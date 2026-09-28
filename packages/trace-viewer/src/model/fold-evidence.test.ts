import { describe, expect, it } from "vitest";

import { loadFixtureTrace } from "../test-support/fixture-rows.js";
import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { foldRows } from "./fold.js";
import type { Step, TraceSession } from "./types.js";

function fold(builder: TraceBuilder, live = false): TraceSession {
  return foldRows(testMeta(), builder.rows, { live });
}

function stepAt(session: TraceSession, seq: number): Step {
  const step = session.steps.find((candidate) => candidate.firstSeq === seq);
  if (step === undefined) throw new Error(`no step starts at seq ${seq}`);
  return step;
}

const HASH_A = "aaaaaaaaaaaaaaaa";
const HASH_B = "bbbbbbbbbbbbbbbb";

function hunk(file: string, added: number, removed: number, diff?: Record<string, unknown>) {
  return {
    type: "git_hunk" as const,
    file,
    added,
    removed,
    isFormattingOnly: false,
    isConfigOnly: false,
    isLockfile: false,
    ...(diff !== undefined ? { diff: diff as never } : {}),
  };
}

describe("evidence attach", () => {
  it("joins a test_result to its command by sourceCallId (observed)", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "command_started", command: "/bin/zsh -lc 'pnpm test'", callId: "c1" });
    b.agent({ type: "command_completed", command: "/bin/zsh -lc 'pnpm test'", exitCode: 1, stdout: "", stderr: "", callId: "c1" });
    const result = b.fact({
      type: "test_result",
      runner: "vitest",
      command: "pnpm test",
      passed: 3,
      failed: 1,
      skipped: 2,
      failures: [{ file: "a.test.ts", testName: "a > b", message: "boom" }],
      sourceCallId: "c1",
    });
    const session = fold(b);
    const step = stepAt(session, 2);
    expect(step).toMatchObject({ kind: "test", lane: "tests", provenance: "observed", status: "failed" });
    expect(step.tests).toEqual({
      runner: "vitest",
      passed: 3,
      failed: 1,
      skipped: 2,
      failures: [{ file: "a.test.ts", testName: "a > b", message: "boom" }],
      resultSeq: result,
    });
    expect(step.evidenceSeqs).toEqual([result]);
    expect(step.seqs).toEqual([2, 3, result]);
    expect(session.coverage.capabilities).toContain("test_results");
  });

  it("joins by whitespace-normalized command in the turn when there is no sourceCallId (inferred)", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p", turnId: "t" });
    b.agent({ type: "command_started", command: "pnpm  test", callId: "t:1" });
    const result = b.fact({ type: "test_result", runner: "vitest", command: "pnpm test", passed: 14, failed: 1, skipped: 0, failures: [] });
    b.agent({ type: "command_completed", command: "pnpm test", exitCode: 0, stdout: "", stderr: "", callId: "t:1" });
    const step = stepAt(fold(b), 2);
    expect(step).toMatchObject({ provenance: "inferred", status: "failed", headline: "pnpm test · 14/15" });
    expect(step.tests?.resultSeq).toBe(result);
  });

  it("keeps at most 20 failures and makes a check command a check", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "command_started", command: "pnpm lint" });
    b.agent({ type: "command_completed", command: "pnpm lint", exitCode: 1, stdout: "", stderr: "" });
    const failures = Array.from({ length: 25 }, (_, index) => ({ file: `f${index}.ts`, testName: `t${index}`, message: "x" }));
    b.fact({ type: "test_result", runner: "eslint", command: "pnpm lint", passed: 0, failed: 25, skipped: 0, failures });
    const step = stepAt(fold(b), 2);
    expect(step.kind).toBe("check");
    expect(step.tests?.failures).toHaveLength(20);
  });

  it("makes a repo step for a fact with no matching command", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const executed = b.fact({ type: "command_executed", command: "rm -rf dist", exitCode: 0, isDestructive: true });
    const session = fold(b);
    expect(stepAt(session, executed)).toMatchObject({
      kind: "command",
      actor: "repo",
      provenance: "observed",
      status: "ok",
      command: { command: "rm -rf dist", exitCode: 0, destructivePattern: "rm-recursive-force" },
      evidenceSeqs: [executed],
    });
  });

  it("joins a validation to the run holding its test_result", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "command_started", command: "pnpm test" });
    b.agent({ type: "command_completed", command: "pnpm test", exitCode: 0, stdout: "", stderr: "" });
    const ts = TraceBuilder.at(20);
    b.fact({ type: "test_result", runner: "vitest", command: "pnpm test", passed: 5, failed: 0, skipped: 0, failures: [], ts });
    b.agent({ type: "agent_completed" });
    const validation = b.validation({ id: "val_1", kind: "test", command: "pnpm test", status: "passed", passed: 5, failed: 0, skipped: 0, ts });
    const step = stepAt(fold(b), 2);
    expect(step.evidenceSeqs).toEqual([4, validation]);
    expect(step.status).toBe("ok");
  });
});

describe("edits: claims and repo facts", () => {
  it("joins repo facts to the agent's claim for the same path", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "file_changed", path: "src/a.ts", callId: "t:5" });
    b.fact({ type: "file_changed", path: "src/a.ts", kind: "modified" });
    const hunkSeq = b.fact(hunk("src/a.ts", 7, 2, { hash: HASH_A, bytes: 120, text: "@@ -1 +1 @@", truncated: false, redactions: 0 }));
    const session = fold(b);
    const step = stepAt(session, 2);
    expect(session.steps.filter((candidate) => candidate.kind === "edit")).toHaveLength(1);
    expect(step).toMatchObject({ actor: "agent", callId: "t:5", seqs: [2, 3, 4], evidenceSeqs: [3, 4] });
    expect(step.edit).toEqual({
      path: "src/a.ts",
      change: "modified",
      added: 7,
      removed: 2,
      claimed: true,
      observed: true,
      diffSeq: hunkSeq,
      diff: "text",
      lockfile: false,
      formattingOnly: false,
    });
    expect(step.entityIds).toEqual(["file:src/a.ts"]);
  });

  it("lets a claim that arrives after the repo facts join them", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.fact(hunk("src/b.ts", 1, 0));
    b.agent({ type: "file_changed", path: "src/b.ts" });
    const step = stepAt(fold(b), 2);
    expect(step).toMatchObject({ actor: "agent", seqs: [2, 3] });
    expect(step.edit).toMatchObject({ claimed: true, observed: true, diff: "none" });
  });

  it("joins a git poll that lands after a test run to the claim it confirms", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const claim = b.agent({ type: "file_changed", path: "src/late.ts" });
    b.agent({ type: "command_started", command: "pnpm test" });
    b.agent({ type: "command_completed", command: "pnpm test", exitCode: 0, stdout: "", stderr: "" });
    b.fact(hunk("src/late.ts", 2, 0));
    const session = fold(b);
    expect(session.steps.filter((step) => step.kind === "edit").map((step) => step.firstSeq)).toEqual([claim]);
    expect(stepAt(session, claim).edit).toMatchObject({ claimed: true, observed: true, added: 2 });
  });

  it("splits a new hunk into a new step and marks an identical re-poll as a duplicate step", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.fact(hunk("src/c.ts", 3, 0, { hash: HASH_A, bytes: 10, text: "x", truncated: false, redactions: 0 }));
    const poll = b.fact(hunk("src/c.ts", 3, 0, { hash: HASH_A, bytes: 10, text: "x", truncated: false, redactions: 0 }));
    const next = b.fact(hunk("src/c.ts", 9, 1, { hash: HASH_B, bytes: 40, truncated: false, redactions: 0, withheld: "not_captured" }));
    const session = fold(b);
    const edits = session.steps.filter((step) => step.kind === "edit");
    expect(edits.map((step) => step.firstSeq)).toEqual([2, poll, next]);
    expect(stepAt(session, next).edit).toMatchObject({ added: 9, removed: 1, diff: "not_captured" });
    const entity = session.entities.find((candidate) => candidate.path === "src/c.ts");
    expect(entity).toMatchObject({ id: "file:src/c.ts", added: 9, removed: 1, observed: true, claimed: false });
    expect(entity?.stepIds).toEqual(["step:2", `step:${next}`]);
  });

  it("uses added/removed as the change key when the hunk has no diff", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.fact(hunk("src/d.ts", 2, 2));
    b.fact(hunk("src/d.ts", 2, 2));
    b.fact(hunk("src/d.ts", 4, 2));
    expect(fold(b).steps.filter((step) => step.kind === "edit").map((step) => step.firstSeq)).toEqual([2, 3, 4]);
  });

  it("maps withheld and truncated diffs", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const secret = b.fact(hunk(".env.local", 1, 0, { hash: HASH_A, bytes: 20, truncated: false, redactions: 0, withheld: "secret_path" }));
    const cut = b.fact(hunk("big.ts", 900, 0, { hash: HASH_B, bytes: 410_000, text: "@@", truncated: true, redactions: 2 }));
    const session = fold(b);
    expect(stepAt(session, secret).edit?.diff).toBe("withheld_secret");
    expect(stepAt(session, cut).edit?.diff).toBe("truncated");
  });

  it("labels entities with a middle-truncated path", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const path = "packages/trace-viewer/src/model/deeply/nested/folder/structure/file.ts";
    b.fact(hunk(path, 1, 1));
    const entity = fold(b).entities[0];
    expect(entity?.label.endsWith("/file.ts")).toBe(true);
    expect(entity?.label).toContain("…");
  });

  it("makes a dependency step from a dependency_change fact", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const seq = b.fact({
      type: "dependency_change",
      manifest: "package.json",
      added: [{ name: "zod", version: "^3.24.1" }],
      removed: [{ name: "axios", version: "^1.7.0" }],
    });
    expect(stepAt(fold(b), seq)).toMatchObject({ kind: "dependency", lane: "edits", actor: "repo", headline: "+zod −axios" });
  });
});

describe("oauth fixture", () => {
  it("folds the pnpm test run into one failed test step with 14/1/0", () => {
    const trace = loadFixtureTrace("oauth");
    const session = foldRows(trace.meta, trace.rows, { live: false });
    const payloadOf = (seq: number) => trace.rows[seq - 1]?.payload as Record<string, unknown>;
    const started = trace.rows.find((row) => {
      const payload = row.payload as Record<string, unknown>;
      return payload["type"] === "command_started" && payload["command"] === "pnpm test";
    });
    const result = trace.rows.find((row) => (row.payload as Record<string, unknown>)["type"] === "test_result");
    if (started === undefined || result === undefined) throw new Error("fixture rows missing");
    const step = stepAt(session, started.seq);
    expect(step).toMatchObject({ kind: "test", status: "failed", tests: { passed: 14, failed: 1, skipped: 0 } });
    expect(step.tests?.resultSeq).toBe(result.seq);
    const joinedById = payloadOf(started.seq)["callId"] !== undefined && payloadOf(result.seq)["sourceCallId"] !== undefined;
    expect(step.provenance).toBe(joinedById ? "observed" : "inferred");
    const completed = trace.rows.filter((row) => {
      const payload = row.payload as Record<string, unknown>;
      return row.type === "agent_event" && payload["command"] === "pnpm test";
    });
    expect(step.seqs).toEqual(expect.arrayContaining(completed.map((row) => row.seq)));
  });
});
