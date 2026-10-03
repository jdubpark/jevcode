import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { foldRows, type TraceSession } from "../model/index.js";
import { arbTraceSession } from "../test-support/arbitraries.js";
import { buildSession } from "../test-support/session-builder.js";
import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { buildBrief } from "./brief.js";
import { buildTraceIndex } from "./trace-index.js";

const NOW = Date.parse("2026-09-18T09:30:00.000Z");

function hunk(file: string, added: number, removed: number) {
  return { type: "git_hunk" as const, file, added, removed, isFormattingOnly: false, isConfigOnly: false, isLockfile: false };
}

function twoUnits(): TraceBuilder {
  const b = new TraceBuilder();
  b.agent({ type: "agent_started", prompt: "Add OAuth" });
  b.agent({ type: "file_changed", path: "src/google.ts", callId: "edit_g" });
  b.fact(hunk("src/google.ts", 86, 0), "fact_g");
  b.unit({ id: "cu_google", title: "Google provider", files: ["src/google.ts"], evidence: ["fact_g"], agentCallIds: ["edit_g"] });
  b.agent({ type: "file_changed", path: "src/identity.ts", callId: "edit_i" });
  b.fact(hunk("src/identity.ts", 41, 12), "fact_i");
  b.unit({ id: "cu_identity", title: "Identity linking", files: ["src/identity.ts"], evidence: ["fact_i"], agentCallIds: ["edit_i"] });
  return b;
}

function fold(b: TraceBuilder, state: "running" | "completed"): TraceSession {
  return foldRows(testMeta({ state, lastEventSeq: b.rows.length }), b.rows, { live: state === "running", nowMs: NOW });
}

describe("buildBrief (spec §3.3, §8.4)", () => {
  it("lists changes newest first with their diff counts and a rule-based Now", () => {
    const b = twoUnits();
    b.agent({ type: "command_started", command: "pnpm build" });
    const session = fold(b, "running");
    const brief = buildBrief(session, buildTraceIndex(session));
    const chapter = (id: string) => session.chapters.find((c) => c.id === id);
    const running = session.steps.find((step) => step.status === "running" && step.kind !== "decision");
    expect(brief.now).toEqual({ kind: "rule", runningStepId: running?.id ?? null, latestUnitId: "unit:cu_identity", pendingDecisionId: null });
    expect(running?.target).toBe("pnpm build");
    expect(brief.changes).toEqual([
      { unitId: "unit:cu_identity", title: chapter("unit:cu_identity")?.shortTitle ?? "Identity linking", added: 41, removed: 12, tests: null, attention: false },
      { unitId: "unit:cu_google", title: chapter("unit:cu_google")?.shortTitle ?? "Google provider", added: 86, removed: 0, tests: null, attention: false },
    ]);
    expect(brief.architecture).toBeNull();
  });

  it("reports a pending decision until it is answered, and no running step once the session is not live", () => {
    const b = twoUnits();
    b.decision({ id: "d1", title: "Keep password login?" });
    const pending = fold(b, "running");
    expect(buildBrief(pending, buildTraceIndex(pending)).now).toMatchObject({ pendingDecisionId: "d1", runningStepId: null });
    b.decision({ id: "d1", title: "Keep password login?", status: "answered", answer: { decisionId: "d1", decision: { choice: "a" }, evidence: [] } });
    const answered = fold(b, "completed");
    expect(buildBrief(answered, buildTraceIndex(answered)).now).toMatchObject({ pendingDecisionId: null, runningStepId: null });
  });

  it("gives a unit its latest test counts and flags a failing run anchored in it", () => {
    const b = twoUnits();
    b.agent({ type: "command_started", command: "pnpm test", callId: "t1" });
    b.agent({ type: "command_completed", command: "pnpm test", exitCode: 1, stdout: "", stderr: "", callId: "t1" });
    b.fact({
      type: "test_result", runner: "vitest", command: "pnpm test", passed: 14, failed: 1, skipped: 0,
      failures: [{ file: "a.test.ts", testName: "links accounts", message: "x" }], sourceCallId: "t1",
    }, "fact_t1");
    b.unit({
      id: "cu_identity", title: "Identity linking", files: ["src/identity.ts"],
      evidence: ["fact_i", "fact_t1"], agentCallIds: ["edit_i", "t1"],
    });
    const session = fold(b, "completed");
    const identity = buildBrief(session, buildTraceIndex(session)).changes.find((change) => change.unitId === "unit:cu_identity");
    expect(identity).toMatchObject({ added: 41, removed: 12, tests: { passed: 14, failed: 1 }, attention: true });
  });

  it("gives a shared failing run's counts only to the unit that owns its outcome", () => {
    // As on oauth: every unit cites the run's test_result and its validation, but only cu_t holds the failing test's file.
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.fact(hunk("src/a.ts", 3, 0), "fact_a");
    b.fact(hunk("tests/a.test.ts", 9, 0), "fact_t");
    b.agent({ type: "command_started", command: "pnpm test" });
    b.agent({ type: "command_completed", command: "pnpm test", exitCode: 1, stdout: "", stderr: "" });
    const failures = [{ file: "tests/a.test.ts", testName: "links", message: "expected null to be 7" }];
    b.fact({ type: "test_result", runner: "vitest", command: "pnpm test", passed: 3, failed: 1, skipped: 0, failures }, "fact_tr");
    b.validation({ id: "val_1", kind: "test", command: "pnpm test", status: "failed", passed: 3, failed: 1, skipped: 0 });
    b.unit({ id: "cu_a", files: ["src/a.ts"], evidence: ["fact_a", "fact_tr"], validationResults: ["val_1"] });
    b.unit({ id: "cu_t", files: ["tests/a.test.ts"], evidence: ["fact_t", "fact_tr"], validationResults: ["val_1"] });
    const session = fold(b, "completed");
    const byUnit = new Map(buildBrief(session, buildTraceIndex(session)).changes.map((change) => [change.unitId, change]));
    expect(session.chapters.find((chapter) => chapter.id === "unit:cu_a")?.validationOnlyStepIds).toHaveLength(1);
    expect(byUnit.get("unit:cu_t")).toMatchObject({ tests: { passed: 3, failed: 1 }, attention: true });
    expect(byUnit.get("unit:cu_a")).toMatchObject({ tests: null, attention: false });
  });

  it("takes the latest counts from the validations a unit owns", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.fact(hunk("tests/a.test.ts", 5, 0));
    for (const [passed, failed, id] of [[4, 1, "val_1"], [5, 0, "val_2"]] as const) {
      b.agent({ type: "command_started", command: "pnpm test" });
      b.agent({ type: "command_completed", command: "pnpm test", exitCode: failed > 0 ? 1 : 0, stdout: "", stderr: "" });
      b.fact({ type: "test_result", runner: "vitest", command: "pnpm test", passed, failed, skipped: 0, failures: [] });
      b.validation({ id, kind: "test", command: "pnpm test", status: failed > 0 ? "failed" : "passed", passed, failed, skipped: 0 });
    }
    b.unit({ id: "cu_tests", category: "tests", files: ["tests/a.test.ts"], validationResults: ["val_1", "val_2"] });
    const session = fold(b, "completed");
    const chapter = session.chapters.find((candidate) => candidate.id === "unit:cu_tests");
    expect(chapter?.validationStepIds).toHaveLength(2);
    const change = buildBrief(session, buildTraceIndex(session)).changes.find((candidate) => candidate.unitId === "unit:cu_tests");
    expect(change?.tests).toEqual({ passed: 5, failed: 0 });
  });

  it("leaves attention off for a finding the unit lists but that is anchored on a step it does not own", () => {
    const built = buildSession({
      steps: [
        { kind: "edit", tMs: 0, chapter: "u0", edit: { path: "src/a.ts", added: 2, removed: 0 } },
        { kind: "test", tMs: 1_000, chapter: "u1", tests: { passed: 3, failed: 1 } },
      ],
      chapters: [{ id: "u0", title: "Alpha" }, { id: "u1", title: "Beta" }],
      findings: [{ ruleId: "failing_tests", severity: "warning", step: 1 }],
    });
    const finding = built.findings[0];
    if (finding === undefined) throw new Error("no finding");
    // u0 lists the finding (as a chapter a finding names), but its anchor is u1's test step.
    const session = { ...built, chapters: built.chapters.map((chapter) => (chapter.id === "unit:u0" ? { ...chapter, findingIds: [finding.id] } : chapter)) };
    const byUnit = new Map(buildBrief(session, buildTraceIndex(session)).changes.map((change) => [change.unitId, change.attention]));
    expect(byUnit).toEqual(new Map([["unit:u0", false], ["unit:u1", true]]));
  });

  it("holds its invariants on generated sessions", () => {
    fc.assert(
      fc.property(arbTraceSession({ maxSteps: 60, maxChapters: 6 }), (session) => {
        const index = buildTraceIndex(session);
        const brief = buildBrief(session, index);
        expect(buildBrief(session, index)).toStrictEqual(brief);
        const shown = session.chapters.filter((chapter) => chapter.current && !chapter.noise);
        expect(new Set(brief.changes.map((change) => change.unitId))).toEqual(new Set(shown.map((chapter) => chapter.id)));
        const lastSeq = new Map(shown.map((chapter) => [chapter.id as string, chapter.lastSeq]));
        for (let i = 1; i < brief.changes.length; i += 1) {
          expect(lastSeq.get(brief.changes[i - 1]?.unitId ?? "") ?? 0).toBeGreaterThanOrEqual(lastSeq.get(brief.changes[i]?.unitId ?? "") ?? 0);
        }
        for (const change of brief.changes) {
          expect(change.added).toBeGreaterThanOrEqual(0);
          expect(change.removed).toBeGreaterThanOrEqual(0);
        }
        const now = brief.now;
        expect(now.kind).toBe("rule");
        if (now.kind === "rule" && now.runningStepId !== null) {
          expect(session.live).toBe(true);
          expect(session.steps.find((step) => step.id === now.runningStepId)?.status).toBe("running");
        }
        expect(brief.architecture).toBeNull();
      }),
      { numRuns: 150 },
    );
  });
});
