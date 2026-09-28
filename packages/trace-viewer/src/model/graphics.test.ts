import { describe, expect, it } from "vitest";

import { loadFixtureTrace } from "../test-support/fixture-rows.js";
import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { foldRows } from "./fold.js";
import { describeGraphic, pickGraphic } from "./format.js";
import type { Chapter, GraphicSpec, Step, TraceSession } from "./types.js";

function hunk(file: string, added: number, removed: number) {
  return { type: "git_hunk" as const, file, added, removed, isFormattingOnly: false, isConfigOnly: false, isLockfile: false };
}

function chapterOf(session: TraceSession, unitId: string): Chapter {
  const chapter = session.chapters.find((candidate) => candidate.changeUnitId === unitId);
  if (chapter === undefined) throw new Error(`no chapter for ${unitId}`);
  return chapter;
}

function stepAt(session: TraceSession, seq: number): Step {
  const step = session.steps.find((candidate) => candidate.firstSeq === seq);
  if (step === undefined) throw new Error(`no step starts at seq ${seq}`);
  return step;
}

describe("pickGraphic: steps", () => {
  it("picks tests, claim, diff and fork graphics on oauth", () => {
    const trace = loadFixtureTrace("oauth");
    const session = foldRows(trace.meta, trace.rows, { live: false });
    const byKind = (kind: string) => session.steps.find((step) => step.kind === kind);
    expect(pickGraphic(byKind("test") as NonNullable<ReturnType<typeof byKind>>, session)).toEqual({
      kind: "tests",
      passed: 14,
      failed: 1,
      skipped: 0,
    });
    const claimStep = session.steps.find((step) => step.problems.includes("claim_contradicted"));
    expect(claimStep && pickGraphic(claimStep, session)).toMatchObject({
      kind: "claim",
      claim: { text: "OAuth implementation complete; all checks pass.", tMs: claimStep?.tMs },
      observed: { passed: 14, failed: 1, command: "pnpm test" },
    });
    const edit = session.steps.find((step) => step.edit?.path === "src/auth/identity.ts");
    // Counts come from the fixture row, never a literal: A1-9 reconciles fixture git_hunk counts
    // with the real diffs (index §4, fixture drift).
    const fixtureHunk = trace.rows.find((row) => {
      const payload = row.payload as { type?: string; file?: string };
      return row.type === "evidence_fact" && payload.type === "git_hunk" && payload.file === "src/auth/identity.ts";
    })?.payload as { added: number; removed: number } | undefined;
    expect(fixtureHunk).toBeDefined();
    expect(edit && pickGraphic(edit, session)).toEqual({ kind: "diff", added: fixtureHunk?.added, removed: fixtureHunk?.removed });
    const decision = byKind("decision");
    expect(decision && pickGraphic(decision, session)).toEqual({
      kind: "fork",
      options: [
        { label: "Match by email", chosen: false },
        { label: "Require explicit linking", chosen: true },
      ],
      decidedBy: "supervisor",
    });
    const message = byKind("message");
    expect(message && pickGraphic(message, session)).toBeNull();
  });

  it("draws commands as durations: open while running, an x for a failed command, a dot for a failed check", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const make = b.agent({ type: "command_started", command: "make" });
    b.agent({ type: "command_completed", command: "make", exitCode: 2, stdout: "", stderr: "" });
    const lint = b.agent({ type: "command_started", command: "pnpm lint" });
    b.agent({ type: "command_completed", command: "pnpm lint", exitCode: 1, stdout: "", stderr: "" });
    const install = b.agent({ type: "command_started", command: "pnpm install" });
    const session = foldRows(testMeta(), b.rows, { live: true });
    expect(pickGraphic(stepAt(session, make), session)).toEqual({
      kind: "duration",
      durationMs: 1_000,
      running: false,
      status: "failed",
      end: "exit_x",
    });
    expect(pickGraphic(stepAt(session, lint), session)).toEqual({
      kind: "duration",
      durationMs: 1_000,
      running: false,
      status: "failed",
      end: "bad_dot",
    });
    expect(pickGraphic(stepAt(session, install), session)).toEqual({
      kind: "duration",
      durationMs: null,
      running: true,
      status: "running",
      end: "none",
    });
  });
});

describe("pickGraphic: chapters follow CHAPTER_GRAPHIC", () => {
  it("draws a schema chapter as tables and falls back to a diff list without schema data", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.fact(hunk("migrations/1.sql", 12, 0));
    b.unit({
      id: "cu_schema",
      category: "schema",
      files: ["migrations/1.sql"],
      schemaChanges: [
        { entity: "identities", entityType: "table", change: "added" },
        { entity: "identities.user_id", entityType: "column", change: "added" },
        { entity: "users.password_hash", entityType: "column", change: "removed" },
        { entity: "users_email_idx", entityType: "index", change: "added" },
      ],
    });
    b.unit({ id: "cu_bare", category: "schema", files: ["migrations/1.sql"] });
    const session = foldRows(testMeta(), b.rows, { live: false });
    expect(pickGraphic(chapterOf(session, "cu_schema"), session)).toEqual({
      kind: "table",
      tables: [
        { name: "identities", role: "new", columns: 1 },
        { name: "users", role: "altered", columns: 1 },
      ],
    });
    expect(pickGraphic(chapterOf(session, "cu_bare"), session)).toEqual({
      kind: "diff",
      added: 12,
      removed: 0,
      files: [{ path: "migrations/1.sql", added: 12, removed: 0 }],
    });
  });

  it("draws architecture and api chapters as a flow of file stems in first-edit order", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.fact(hunk("src/auth/identity.ts", 24, 0));
    b.fact(hunk("src/auth/google.ts", 34, 0));
    b.fact(hunk("src/server/index.ts", 11, 3));
    b.fact(hunk("src/auth/service.ts", 7, 12));
    b.unit({
      id: "cu_arch",
      category: "architecture",
      files: ["src/server/index.ts", "src/auth/service.ts", "src/auth/google.ts", "src/auth/identity.ts"],
    });
    b.unit({ id: "cu_api", category: "api", files: ["src/server/index.ts"] });
    const session = foldRows(testMeta(), b.rows, { live: false });
    expect(pickGraphic(chapterOf(session, "cu_arch"), session)).toEqual({
      kind: "flow",
      nodes: ["identity", "google", "index"],
      focus: 1,
    });
    expect(pickGraphic(chapterOf(session, "cu_api"), session)).toEqual({ kind: "flow", nodes: ["index"], focus: 0 });
  });

  it("draws a tests chapter with its latest run's counts", () => {
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
    b.unit({ id: "cu_untested", category: "tests", files: ["tests/a.test.ts"] });
    const session = foldRows(testMeta(), b.rows, { live: false });
    expect(pickGraphic(chapterOf(session, "cu_tests"), session)).toEqual({ kind: "tests", passed: 5, failed: 0, skipped: 0 });
    expect(pickGraphic(chapterOf(session, "cu_untested"), session)).toEqual({
      kind: "diff",
      added: 5,
      removed: 0,
      files: [{ path: "tests/a.test.ts", added: 5, removed: 0 }],
    });
  });

  it("draws a chapter with an answered decision as a fork", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.fact(hunk("src/link.ts", 6, 1));
    b.decision({ id: "dec-1", title: "Linking policy" });
    b.decision({
      id: "dec-1",
      title: "Linking policy",
      status: "answered",
      answer: { decisionId: "dec-1", decision: { policy: "b" }, evidence: [] },
    });
    b.decision({ id: "dec-2", title: "Still open" });
    b.unit({ id: "cu_linked", files: ["src/link.ts"], relatedDecisions: ["dec-1"] });
    b.unit({ id: "cu_waiting", files: ["src/link.ts"], relatedDecisions: ["dec-2"] });
    const session = foldRows(testMeta(), b.rows, { live: false });
    expect(pickGraphic(chapterOf(session, "cu_linked"), session)).toEqual({
      kind: "fork",
      options: [
        { label: "Option A", chosen: false },
        { label: "Option B", chosen: true },
      ],
      decidedBy: "supervisor",
    });
    expect(pickGraphic(chapterOf(session, "cu_waiting"), session)).toMatchObject({ kind: "diff", added: 6, removed: 1 });
  });

  it("lists a chapter's top 4 files by lines changed and counts the rest", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const sizes = [
      ["a.ts", 3, 1],
      ["b.ts", 2, 2],
      ["c.ts", 10, 0],
      ["d.ts", 1, 0],
      ["e.ts", 0, 6],
      ["f.ts", 1, 1],
    ] as const;
    for (const [file, added, removed] of sizes) b.fact(hunk(file, added, removed));
    b.unit({ id: "cu_code", files: sizes.map(([file]) => file) });
    const session = foldRows(testMeta(), b.rows, { live: false });
    expect(pickGraphic(chapterOf(session, "cu_code"), session)).toEqual({
      kind: "diff",
      added: 17,
      removed: 10,
      files: [
        { path: "c.ts", added: 10, removed: 0 },
        { path: "e.ts", added: 0, removed: 6 },
        { path: "a.ts", added: 3, removed: 1 },
        { path: "b.ts", added: 2, removed: 2 },
      ],
      moreFiles: 2,
    });
  });
});

describe("describeGraphic", () => {
  it.each<[GraphicSpec, string]>([
    [{ kind: "tests", passed: 14, failed: 1, skipped: 0 }, "14 passed, 1 failed"],
    [{ kind: "tests", passed: 3, failed: 0, skipped: 2 }, "3 passed, 0 failed, 2 skipped"],
    [{ kind: "diff", added: 17, removed: 3 }, "+17 −3"],
    [
      { kind: "diff", added: 17, removed: 10, files: [{ path: "c.ts", added: 10, removed: 0 }], moreFiles: 5 },
      "+17 −10 in 6 files",
    ],
    [{ kind: "duration", durationMs: 5_000, running: false, status: "failed", end: "bad_dot" }, "5.0 s, failed"],
    [{ kind: "duration", durationMs: null, running: true, status: "running", end: "none" }, "running"],
    [
      { kind: "fork", options: [{ label: "Fail open", chosen: true }, { label: "Fail closed", chosen: false }], decidedBy: "supervisor" },
      "2 options; you chose Fail open",
    ],
    [{ kind: "fork", options: [{ label: "A", chosen: false }], decidedBy: "open" }, "1 option; open"],
    [{ kind: "flow", nodes: ["User", "Identity", "Session"], focus: 1 }, "User → Identity → Session"],
    [
      {
        kind: "table",
        tables: [
          { name: "identities", role: "new", columns: 0 },
          { name: "users", role: "altered", columns: 1 },
        ],
      },
      "identities (new); users (altered, 1 column)",
    ],
    [
      {
        kind: "claim",
        claim: { text: "All checks pass.", span: [0, 15], tMs: 43_000 },
        observed: { passed: 14, failed: 1, command: "pnpm test", tMs: 40_000 },
      },
      'Claimed "All checks pass."; pnpm test had 14 passed, 1 failed',
    ],
  ])("describes %j", (spec, text) => {
    expect(describeGraphic(spec)).toBe(text);
  });
});
