import { describe, expect, it } from "vitest";

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

function run(b: TraceBuilder, command: string, exitCode: number): number {
  const seq = b.agent({ type: "command_started", command });
  b.agent({ type: "command_completed", command, exitCode, stdout: "", stderr: "" });
  return seq;
}

function tests(b: TraceBuilder, command: string, passed: number, failed: number): number {
  const seq = run(b, command, failed > 0 ? 1 : 0);
  b.fact({ type: "test_result", runner: "vitest", command, passed, failed, skipped: 0, failures: [] });
  return seq;
}

function edit(b: TraceBuilder, file: string, flags: { lockfile?: boolean; formatting?: boolean } = {}): number {
  return b.fact({
    type: "git_hunk",
    file,
    added: 1,
    removed: 1,
    isFormattingOnly: flags.formatting ?? false,
    isConfigOnly: false,
    isLockfile: flags.lockfile ?? false,
  });
}

describe("problems", () => {
  it("derives problems from exits, tests, lifecycle, destructive commands and guardrails", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const exit = run(b, "make", 2);
    const unknown = run(b, "make again", -1);
    const failing = tests(b, "pnpm test", 3, 1);
    const destructive = run(b, "rm -rf dist", 0);
    const warning = b.jev({ id: "j1", clamps: ["security_path"] });
    const info = b.jev({ id: "j2", clamps: ["suppress_formatting", "guardrail.security"] });
    const blocked = b.jev({ id: "j3", clamps: ["security_path", "destructive_command"] });
    const failed = b.agent({ type: "agent_failed", error: "boom" });
    const session = fold(b);
    expect(stepAt(session, exit).problems).toEqual(["exit_nonzero"]);
    expect(stepAt(session, unknown).problems).toEqual([]);
    expect(stepAt(session, failing).problems).toEqual(["exit_nonzero", "tests_failed"]);
    expect(stepAt(session, destructive).problems).toEqual(["destructive"]);
    expect(stepAt(session, destructive).command?.destructivePattern).toBe("rm-recursive-force");
    // Only a critical (blocking) clamp is a problem; a warning clamp keeps its finding but not red (§7.12).
    expect(stepAt(session, warning).problems).toEqual([]);
    expect(stepAt(session, info).problems).toEqual([]);
    expect(stepAt(session, blocked).problems).toEqual(["guardrail"]);
    expect(stepAt(session, failed).problems).toEqual(["agent_failed"]);
  });
});

describe("noise", () => {
  it("collapses reads, lockfiles, formatting, duplicate polls and lifecycle rows with reasons", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const read = b.agent({ type: "file_read", path: "src/a.ts" });
    const tool = b.agent({ type: "tool_started", tool: "read_file", input: "src/a.ts" });
    b.agent({ type: "tool_completed", tool: "read_file", output: "" });
    const other = b.agent({ type: "tool_started", tool: "apply_patch", input: "" });
    b.agent({ type: "tool_completed", tool: "apply_patch", output: "" });
    const lock = edit(b, "pnpm-lock.yaml", { lockfile: true });
    const format = edit(b, "src/format.ts", { formatting: true });
    const real = edit(b, "src/real.ts");
    const poll = edit(b, "src/real.ts");
    const waiting = b.agent({ type: "agent_waiting" });
    const attention = b.jev({ id: "j", clamps: [] });
    const failed = b.agent({ type: "agent_failed", error: "x" });
    const session = fold(b);
    expect(stepAt(session, read).noise).toBe("read");
    expect(stepAt(session, tool).noise).toBe("read");
    expect(stepAt(session, other).noise).toBeNull();
    expect(stepAt(session, lock).noise).toBe("lockfile");
    expect(stepAt(session, format).noise).toBe("formatting");
    expect(stepAt(session, real).noise).toBeNull();
    expect(stepAt(session, poll).noise).toBe("duplicate_poll");
    expect(stepAt(session, waiting).noise).toBe("lifecycle");
    expect(stepAt(session, attention).noise).toBe("lifecycle");
    expect(stepAt(session, failed)).toMatchObject({ problems: ["agent_failed"], noise: null });
  });

  it("collapses a guardrail step whose clamps are all info and keeps one with a warning clamp", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const routine = b.jev({ id: "j1", clamps: ["suppress_formatting", "suppress_lockfile"] });
    const unknown = b.jev({ id: "j2", clamps: ["guardrail.security"] });
    const warning = b.jev({ id: "j3", clamps: ["suppress_lockfile", "security_path"] });
    const session = fold(b);
    expect(stepAt(session, routine)).toMatchObject({ kind: "guardrail", problems: [], noise: "lifecycle" });
    expect(stepAt(session, unknown)).toMatchObject({ kind: "guardrail", problems: [], noise: "lifecycle" });
    expect(stepAt(session, warning)).toMatchObject({ kind: "guardrail", problems: [], noise: null });
    expect(stepAt(session, warning).findingIds).toHaveLength(1);
  });

  it("collapses intermediate passing runs but never the final run or a failing run", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const early = tests(b, "pnpm test", 5, 0);
    const failing = tests(b, "pnpm test", 4, 1);
    const final = tests(b, "pnpm test", 5, 0);
    const session = fold(b);
    expect(stepAt(session, early).noise).toBe("passing_test");
    expect(stepAt(session, failing).noise).toBeNull();
    expect(stepAt(session, final).noise).toBeNull();
  });

  it("collapses edits whose chapters were all superseded", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const old = b.fact(
      { type: "git_hunk", file: "src/old.ts", added: 1, removed: 0, isFormattingOnly: false, isConfigOnly: false, isLockfile: false },
      "fact_old",
    );
    b.unit({ id: "cu_old", files: ["src/old.ts"], evidence: ["fact_old"], status: "superseded" });
    expect(stepAt(fold(b), old).noise).toBe("superseded");
  });
});

describe("missing evidence", () => {
  it("flags a finished test run without a test result once its turn is closed", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const bare = run(b, "pnpm test", 0);
    const backed = tests(b, "pnpm test", 2, 0);
    const session = fold(b);
    expect(session.gaps).toEqual([expect.objectContaining({ kind: "missing_evidence", atSeq: bare })]);
    expect(session.gaps.some((gap) => gap.atSeq === backed)).toBe(false);
  });

  it("flags an edit claim with no repo fact and leaves its status unknown", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const claim = b.agent({ type: "file_changed", path: "src/ghost.ts" });
    b.agent({ type: "agent_completed" });
    const session = fold(b);
    expect(stepAt(session, claim).status).toBe("unknown");
    expect(session.gaps).toEqual([expect.objectContaining({ kind: "missing_evidence", atSeq: claim })]);
  });

  it("raises nothing for the open turn of a live session", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    run(b, "pnpm test", 0);
    const claim = b.agent({ type: "file_changed", path: "src/pending.ts" });
    const live = fold(b, true);
    expect(live.gaps).toEqual([]);
    expect(stepAt(live, claim).status).toBe("ok");
    b.agent({ type: "agent_completed" });
    expect(fold(b, true).gaps.map((gap) => gap.kind)).toEqual(["missing_evidence", "missing_evidence"]);
  });
});
