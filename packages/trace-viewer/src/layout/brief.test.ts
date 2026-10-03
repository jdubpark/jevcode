import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { foldRows, type TraceSession } from "../model/index.js";
import { arbTraceSession } from "../test-support/arbitraries.js";
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
