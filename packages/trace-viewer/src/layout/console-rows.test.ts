import { describe, expect, it } from "vitest";

import { accumulateAll, createTraceState, finalize, foldRows, type TraceSession } from "../model/index.js";
import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import {
  buildConsoleRows,
  CONSOLE_TAIL_LINES,
  consoleNewRowCount,
  consoleRowStepIds,
  type ConsoleRow,
  type ConsoleRowsState,
} from "./console-rows.js";
import { buildTraceIndex } from "./trace-index.js";

const NOW = Date.parse("2026-09-18T09:30:00.000Z");

function lines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");
}

function hunk(file: string, added: number, removed: number) {
  return { type: "git_hunk" as const, file, added, removed, isFormattingOnly: false, isConfigOnly: false, isLockfile: false };
}

function build(b: TraceBuilder, state: "running" | "completed" = "completed"): { session: TraceSession; out: ConsoleRowsState } {
  const session = foldRows(testMeta({ state, lastEventSeq: b.rows.length }), b.rows, { live: state === "running", nowMs: NOW });
  return { session, out: buildConsoleRows(session, buildTraceIndex(session)) };
}

function rowsOf<K extends ConsoleRow["kind"]>(out: ConsoleRowsState, kind: K): Extract<ConsoleRow, { kind: K }>[] {
  return out.rows.filter((row): row is Extract<ConsoleRow, { kind: K }> => row.kind === kind);
}

describe("buildConsoleRows (spec §3.2, §8.2)", () => {
  it("maps each step kind to its Console row, in step order", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Add OAuth" });
    b.agent({ type: "agent_message", role: "assistant", text: "Plan: add a provider." });
    b.agent({ type: "agent_reasoning", text: "Which flow?" });
    b.agent({ type: "tool_started", tool: "mcp.github.search_issues", input: "oauth" });
    b.agent({ type: "tool_completed", tool: "mcp.github.search_issues", output: "" });
    b.agent({ type: "command_started", command: "ls src" });
    b.agent({ type: "command_completed", command: "ls src", exitCode: 0, stdout: lines(12), stderr: "" });
    b.agent({ type: "file_read", path: "src/a.ts" });
    b.agent({ type: "file_read", path: "src/b.ts" });
    b.agent({ type: "file_changed", path: "src/a.ts" });
    b.fact(hunk("src/a.ts", 3, 1));
    b.decision({ id: "d1", title: "Keep email login?" });
    b.agent({ type: "agent_waiting" });
    const { out } = build(b);

    expect(out.rows.map((row) => row.kind)).toEqual([
      "instruction", "message", "reasoning", "tool", "command", "reads", "edit", "decision", "lifecycle",
    ]);
    expect(rowsOf(out, "instruction")[0]).toMatchObject({ text: "Add OAuth", mode: "start" });
    expect(rowsOf(out, "message")[0]).toMatchObject({ text: "Plan: add a provider." });
    expect(rowsOf(out, "tool")[0]).toMatchObject({ name: "mcp.github.search_issues", args: "", status: "ok" });
    expect(rowsOf(out, "command")[0]).toMatchObject({
      command: "ls src",
      exitCode: 0,
      running: false,
      outputTail: ["line 5", "line 6", "line 7", "line 8", "line 9", "line 10", "line 11", "line 12"],
    });
    expect(rowsOf(out, "command")[0]?.outputTail).toHaveLength(CONSOLE_TAIL_LINES);
    expect(rowsOf(out, "reads")[0]?.paths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(rowsOf(out, "edit")[0]).toMatchObject({ path: "src/a.ts", added: 3, removed: 1 });
    expect(rowsOf(out, "decision")[0]).toMatchObject({
      decisionId: "d1",
      question: "Keep email login?",
      status: "pending",
      answer: null,
      options: [{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }],
    });
    expect(rowsOf(out, "lifecycle")[0]).toMatchObject({ state: "waiting", text: "Waiting for direction" });
  });

  it("indexes every shown step, a read group under each of its reads", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const r1 = b.agent({ type: "file_read", path: "src/a.ts" });
    const r2 = b.agent({ type: "file_read", path: "src/b.ts" });
    b.agent({ type: "agent_message", role: "assistant", text: "done reading" });
    const r3 = b.agent({ type: "file_read", path: "src/c.ts" });
    const { out, session } = build(b);
    const stepAt = (seq: number) => session.steps.find((step) => step.firstSeq === seq)?.id ?? "";
    const groups = rowsOf(out, "reads");
    expect(groups.map((row) => row.paths)).toEqual([["src/a.ts", "src/b.ts"], ["src/c.ts"]]);
    expect(groups[0]?.key).toBe(`reads:${stepAt(r1)}`);
    expect(out.byStep.get(stepAt(r1))).toBe(out.byStep.get(stepAt(r2)));
    expect(out.rows[out.byStep.get(stepAt(r3)) ?? -1]?.key).toBe(`reads:${stepAt(r3)}`);
    for (const step of session.steps) {
      const at = out.byStep.get(step.id);
      expect(at, step.id).toBeDefined();
      expect(consoleRowStepIds(out.rows[at ?? -1] as ConsoleRow)).toContain(step.id);
    }
  });

  it("puts a failing run's tests row before the finding anchored on it", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Fix login" });
    b.agent({ type: "command_started", command: "pnpm test" });
    b.agent({ type: "command_completed", command: "pnpm test", exitCode: 1, stdout: "", stderr: "" });
    b.fact({
      type: "test_result", runner: "vitest", command: "pnpm test", passed: 14, failed: 1, skipped: 0,
      failures: [{ file: "a.test.ts", testName: "links accounts", message: "expected true" }],
    });
    b.agent({ type: "agent_completed" });
    const { out } = build(b);
    const tests = rowsOf(out, "tests")[0];
    expect(tests).toMatchObject({ passed: 14, failed: 1, failing: ["links accounts"] });
    const next = out.rows[out.rows.indexOf(tests as ConsoleRow) + 1];
    expect(next).toMatchObject({ kind: "finding", stepId: tests?.stepId });
    expect(next?.kind === "finding" ? next.findingId : "").toMatch(/^finding:failing_tests@/);
    expect(rowsOf(out, "lifecycle").at(-1)).toMatchObject({ state: "completed" });
  });

  it("marks steer and queued instructions", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Add OAuth" });
    b.agent({ type: "agent_message", role: "user", text: "Also add tests" });
    b.agent({ type: "agent_interrupted", reason: "steer" });
    b.agent({ type: "agent_started", prompt: "Use PKCE" });
    b.agent({ type: "agent_message", role: "user", text: "Use PKCE" });
    const { out } = build(b, "running");
    const modes = rowsOf(out, "instruction").map((row) => [row.text, row.mode]);
    expect(modes).toEqual([
      ["Add OAuth", "start"],
      ["Also add tests", "queue"],
      ["Use PKCE", "steer"],
    ]);
    expect(rowsOf(out, "lifecycle")[0]).toMatchObject({ state: "interrupted" });
  });

  it("shows a running command, a failed agent and a Jev step only through its finding", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const routine = b.jev({ id: "j1", clamps: ["suppress_formatting"] });
    const warning = b.jev({ id: "j2", clamps: ["security_path"] });
    b.agent({ type: "command_started", command: "pnpm build" });
    const running = build(b, "running");
    expect(rowsOf(running.out, "command")[0]).toMatchObject({ command: "pnpm build", running: true, exitCode: null, ms: null });
    const stepAt = (seq: number) => running.session.steps.find((step) => step.firstSeq === seq)?.id ?? "";
    expect(running.out.byStep.has(stepAt(routine))).toBe(false);
    const flagged = running.out.rows[running.out.byStep.get(stepAt(warning)) ?? -1];
    expect(flagged).toMatchObject({ kind: "finding", stepId: stepAt(warning) });

    b.agent({ type: "agent_failed", error: "boom" });
    expect(rowsOf(build(b).out, "lifecycle").at(-1)).toMatchObject({ state: "failed", text: "Stopped: boom" });
  });

  it("returns the previous state for the same session and keeps unchanged rows across an append", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "agent_message", role: "assistant", text: "one" });
    b.agent({ type: "command_started", command: "ls" });
    b.agent({ type: "command_completed", command: "ls", exitCode: 0, stdout: "a", stderr: "" });
    const state = createTraceState(testMeta({ state: "running" }));
    accumulateAll(state, b.rows);
    const first = finalize(state, { live: true, nowMs: NOW });
    const firstIndex = buildTraceIndex(first);
    const a = buildConsoleRows(first, firstIndex);
    expect(buildConsoleRows(first, firstIndex, a)).toBe(a);

    const seen = b.rows.length;
    b.agent({ type: "agent_message", role: "assistant", text: "two" });
    accumulateAll(state, b.rows.slice(seen));
    const second = finalize(state, { live: true, nowMs: NOW });
    const c = buildConsoleRows(second, buildTraceIndex(second, firstIndex), a);
    expect(c.rows).toHaveLength(a.rows.length + 1);
    a.rows.forEach((row, i) => {
      if (row.kind !== "instruction") expect(c.rows[i]).toBe(row);
    });
    expect(c.rows.at(-1)).toMatchObject({ kind: "message", text: "two" });
  });

  it("folds consecutive warning guardrail flag lines into one Jev review row; a critical finding never folds", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const w1 = b.jev({ id: "j1", clamps: ["security_path"] });
    const w2 = b.jev({ id: "j2", clamps: ["security_path"] });
    const w3 = b.jev({ id: "j3", clamps: ["security_path"] });
    const critical = b.jev({ id: "j4", clamps: ["destructive_command"] });
    const lone = b.jev({ id: "j5", clamps: ["security_path"] });
    b.agent({ type: "agent_message", role: "assistant", text: "done" });
    const { session, out } = build(b);
    const stepAt = (seq: number) => session.steps.find((step) => step.firstSeq === seq)?.id ?? "";

    expect(out.rows.map((row) => row.kind)).toEqual(["instruction", "guardrails", "finding", "finding", "message"]);
    const fold = rowsOf(out, "guardrails")[0];
    expect(fold?.stepIds).toEqual([stepAt(w1), stepAt(w2), stepAt(w3)]);
    expect(fold?.findingIds).toHaveLength(3);
    for (const seq of [w1, w2, w3]) expect(out.byStep.get(stepAt(seq))).toBe(1);
    const index = buildTraceIndex(session);
    const flagged = out.rows[out.byStep.get(stepAt(critical)) ?? -1];
    expect(flagged?.kind === "finding" ? index.findingsById.get(flagged.findingId as never)?.severity : null).toBe("critical");
    // One warning after the critical line stays a plain flag line.
    expect(out.rows[out.byStep.get(stepAt(lone)) ?? -1]).toMatchObject({ kind: "finding", stepId: stepAt(lone) });
    expect(consoleRowStepIds(fold as ConsoleRow)).toEqual(fold?.stepIds);
  });

  it("counts the Console rows after a seq for the pill: a read group counts once, a silent Jev step not at all", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const seen = b.agent({ type: "agent_message", role: "assistant", text: "one" });
    b.agent({ type: "file_read", path: "src/a.ts" });
    b.agent({ type: "file_read", path: "src/b.ts" });
    b.jev({ id: "j1", clamps: ["suppress_formatting"] });
    b.agent({ type: "agent_message", role: "assistant", text: "two" });
    const { session, out } = build(b, "running");
    const index = buildTraceIndex(session);
    // Four model steps arrived after `seen` (two reads, a guardrail, a message); the reader sees two new rows.
    expect(session.steps.filter((step) => step.firstSeq > seen)).toHaveLength(4);
    expect(consoleNewRowCount(out, index, seen)).toBe(2);
    expect(consoleNewRowCount(out, index, b.rows.length)).toBe(0);
    expect(consoleNewRowCount(out, index, 0)).toBe(out.rows.length);
  });

  it("keys a warning guardrail flag line guardrails:<finding id> from the start, so the fold that absorbs it keeps its key", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.jev({ id: "j1", clamps: ["security_path"] });
    const one = build(b, "running");
    const lone = one.out.rows.at(-1);
    expect(lone).toMatchObject({ kind: "finding" });
    expect(lone?.key).toBe(`guardrails:${lone?.kind === "finding" ? lone.findingId : ""}`);

    b.jev({ id: "j2", clamps: ["security_path"] });
    const two = build(b, "running");
    expect(two.out.rows.at(-1)).toMatchObject({ kind: "guardrails", key: lone?.key });
    // A critical guardrail finding never folds and keeps its finding id as its key.
    b.jev({ id: "j3", clamps: ["destructive_command"] });
    const three = build(b, "running");
    const critical = three.out.rows.at(-1);
    expect(critical?.kind === "finding" ? critical.key : "").toBe(critical?.kind === "finding" ? critical.findingId : "x");
  });
});
