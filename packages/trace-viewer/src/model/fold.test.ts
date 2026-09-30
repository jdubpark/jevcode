import { describe, expect, it } from "vitest";

import { loadFixtureTrace } from "../test-support/fixture-rows.js";
import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { accumulate, accumulateAll, createTraceState, finalize, foldRows } from "./fold.js";
import type { Step, TraceSession } from "./types.js";

function fold(builder: TraceBuilder, live = false): TraceSession {
  return foldRows(testMeta(), builder.rows, { live });
}

function stepAt(session: TraceSession, seq: number): Step {
  const step = session.steps.find((candidate) => candidate.firstSeq === seq);
  if (step === undefined) throw new Error(`no step starts at seq ${seq}`);
  return step;
}

describe("fold: seq handling and gaps", () => {
  it("folds an empty session", () => {
    const session = foldRows(testMeta(), [], { live: false });
    expect(session.schemaVersion).toBe(1);
    expect(session.steps).toEqual([]);
    expect(session.turns).toEqual([]);
    expect(session.loadedThroughSeq).toBe(0);
    // No clock row yet: the origin falls back to meta.startedAt (spec §6.5).
    expect(session.originMs).toBe(Date.parse(testMeta().startedAt));
    expect(session.coverage.signals.map((signal) => signal.id)).toEqual([
      "claim_contradicted",
      "failing_tests",
      "destructive_command",
      "guardrail_clamp",
      "recovery_arc",
    ]);
  });

  it("skips a seq it already folded", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "agent_message", role: "assistant", text: "hello" });
    const once = fold(b);
    const state = accumulateAll(createTraceState(testMeta()), b.rows);
    accumulate(state, b.rows[1] as (typeof b.rows)[number]);
    expect(finalize(state, { live: false })).toEqual(once);
  });

  it("records a lower new seq as out_of_order and skips it", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "agent_message", role: "assistant", text: "late" });
    b.agent({ type: "agent_message", role: "assistant", text: "early" });
    const [first, second, third] = b.rows;
    if (first === undefined || second === undefined || third === undefined) throw new Error("rows");
    const session = foldRows(testMeta(), [first, third, second], { live: false });
    expect(session.gaps).toEqual([expect.objectContaining({ kind: "out_of_order", atSeq: 2 })]);
    expect(session.steps.map((step) => step.firstSeq)).toEqual([1, 3]);
  });

  it("records a corrupt payload as invalid_row and keeps folding", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.raw("agent_event", { type: "command_started", sessionId: "s" });
    b.raw("agent_event", undefined);
    b.agent({ type: "agent_message", role: "assistant", text: "still here" });
    const session = fold(b);
    expect(session.gaps.map((gap) => [gap.kind, gap.atSeq])).toEqual([
      ["invalid_row", 2],
      ["invalid_row", 3],
    ]);
    expect(stepAt(session, 4).text).toBe("still here");
  });

  it("records an unknown row type and counts hidden envelope types", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.raw("future_row", { anything: true });
    b.raw("telemetry", { name: "x" });
    b.raw("graph_node", { id: "n" });
    b.raw("graph_node", { id: "m" });
    const session = foldRows(testMeta(), b.rows, { live: false, throughSeq: 9 });
    expect(session.gaps).toEqual([expect.objectContaining({ kind: "unknown_row_type", atSeq: 2 })]);
    expect(session.hidden.byType).toEqual({ telemetry: 1, graph_node: 2 });
    expect(session.loadedThroughSeq).toBe(9);
    expect(session.hidden.unreceived).toBe(4);
  });

  it("uses the page state over meta.state", () => {
    const session = foldRows(testMeta({ state: "running" }), [], { live: true, state: "paused" });
    expect(session.meta.state).toBe("paused");
    expect(session.live).toBe(true);
  });
});

describe("fold: turns and agent steps", () => {
  it("pairs a start and completion by callId as observed", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p", turnId: "t1" });
    b.agent({ type: "command_started", command: "pnpm lint", callId: "t1:item_1", turnId: "t1" });
    b.agent({ type: "command_started", command: "pnpm lint", callId: "t1:item_2", turnId: "t1" });
    b.agent({ type: "command_completed", command: "pnpm lint", exitCode: 0, stdout: "", stderr: "", callId: "t1:item_2", turnId: "t1" });
    b.agent({ type: "command_completed", command: "pnpm lint", exitCode: 3, stdout: "", stderr: "", callId: "t1:item_1", turnId: "t1" });
    const session = fold(b);
    const first = stepAt(session, 2);
    const second = stepAt(session, 3);
    expect(first).toMatchObject({ provenance: "observed", callId: "t1:item_1", seqs: [2, 5], status: "failed" });
    expect(second).toMatchObject({ provenance: "observed", callId: "t1:item_2", seqs: [3, 4], status: "ok" });
    expect(first.command?.exitCode).toBe(3);
    expect(session.turns[0]).toMatchObject({ turnId: "t1", trigger: "initial" });
  });

  it("pairs by family and target in FIFO order as inferred when there is no callId", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "tool_started", tool: "read_file", input: "a.ts" });
    b.agent({ type: "tool_started", tool: "read_file", input: "b.ts" });
    b.agent({ type: "tool_completed", tool: "read_file", output: "a" });
    b.agent({ type: "tool_completed", tool: "read_file", output: "b" });
    const session = fold(b);
    expect(stepAt(session, 2)).toMatchObject({ kind: "tool", provenance: "inferred", seqs: [2, 4], status: "ok" });
    expect(stepAt(session, 3)).toMatchObject({ kind: "tool", provenance: "inferred", seqs: [3, 5], status: "ok" });
  });

  it("never pairs two different callIds", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "command_started", command: "make", callId: "x" });
    b.agent({ type: "command_completed", command: "make", exitCode: 0, stdout: "", stderr: "", callId: "y" });
    const session = fold(b);
    expect(stepAt(session, 2)).toMatchObject({ status: "unknown", seqs: [2] });
    expect(stepAt(session, 3)).toMatchObject({ status: "ok", callId: "y", seqs: [3] });
    expect(session.gaps).toEqual([expect.objectContaining({ kind: "unpaired", atSeq: 2 })]);
  });

  it("folds test_started and test_completed into the enclosing command", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "command_started", command: "pnpm  test" });
    b.agent({ type: "test_started", command: "pnpm test" });
    b.agent({ type: "test_completed", command: "pnpm test", exitCode: 1 });
    b.agent({ type: "command_completed", command: "pnpm test", exitCode: 1, stdout: "", stderr: "" });
    const session = fold(b);
    expect(session.steps.filter((step) => step.kind !== "instruction")).toHaveLength(1);
    expect(stepAt(session, 2)).toMatchObject({ kind: "test", lane: "tests", seqs: [2, 3, 4, 5], status: "failed" });
  });

  it("maps exit codes: 0 ok, positive failed, -1 unknown", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    for (const exitCode of [0, 2, -1]) {
      b.agent({ type: "command_started", command: `run ${exitCode}` });
      b.agent({ type: "command_completed", command: `run ${exitCode}`, exitCode, stdout: "", stderr: "" });
    }
    const session = fold(b);
    expect([2, 4, 6].map((seq) => stepAt(session, seq).status)).toEqual(["ok", "failed", "unknown"]);
    expect(stepAt(session, 6).problems).not.toContain("exit_nonzero");
    expect(stepAt(session, 6).headline).toBe("run -1");
  });

  it("interrupted turn leaves the open command unknown", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "build it" });
    b.agent({ type: "command_started", command: "pnpm build" });
    b.agent({ type: "agent_interrupted", reason: "steer" });
    b.agent({ type: "agent_started", prompt: "use the other API" });
    const session = fold(b);
    const command = stepAt(session, 2);
    expect(command).toMatchObject({ status: "unknown", endTs: null, durationMs: null });
    expect(command.problems).toEqual([]);
    expect(session.turns.map((turn) => [turn.trigger, turn.outcome, turn.interruptReason])).toEqual([
      ["initial", "interrupted", "steer"],
      ["steer", "unknown", undefined],
    ]);
    expect(session.steps.flatMap((step) => step.problems)).not.toContain("agent_failed");
    expect(session.gaps).toEqual([expect.objectContaining({ kind: "unpaired", atSeq: 2 })]);
  });

  it("marks a turn resumed after a completed one and interrupted when it has no terminal event", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "one" });
    b.agent({ type: "agent_completed" });
    b.agent({ type: "agent_started", prompt: "two" });
    b.agent({ type: "agent_started", prompt: "three" });
    b.agent({ type: "agent_failed", error: "resume budget exhausted" });
    const session = fold(b);
    expect(session.turns.map((turn) => [turn.trigger, turn.outcome])).toEqual([
      ["initial", "completed"],
      ["resume", "interrupted"],
      ["steer", "failed"],
    ]);
    expect(stepAt(session, 5)).toMatchObject({ kind: "lifecycle", status: "failed", headline: "Stopped: resume budget exhausted" });
  });

  it("keeps open work running only at the live edge", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "command_started", command: "pnpm install" });
    const live = fold(b, true);
    expect(stepAt(live, 2)).toMatchObject({ status: "running", endTMs: null, headline: "Running pnpm install" });
    expect(live.turns[0]?.outcome).toBe("running");
    expect(live.gaps).toEqual([]);
    b.agent({ type: "agent_waiting" });
    expect(fold(b, true).turns[0]?.outcome).toBe("waiting");
    expect(fold(b, false).turns[0]?.outcome).toBe("unknown");
  });

  it("adopts rows that arrive before agent_started into the first turn", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_message", role: "assistant", text: "warming up" });
    b.agent({ type: "agent_started", prompt: "the task", turnId: "t9" });
    const session = fold(b);
    expect(session.turns).toHaveLength(1);
    expect(session.turns[0]).toMatchObject({ prompt: "the task", turnId: "t9", startSeq: 1, endSeq: 2 });
    expect(stepAt(session, 2)).toMatchObject({ kind: "instruction", lane: "supervisor", actor: "supervisor" });
  });

  it("starts the clock at the first agent row and keeps it monotonic when timestamps go backwards", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p", ts: TraceBuilder.at(10) });
    b.agent({ type: "agent_message", role: "assistant", text: "a", ts: TraceBuilder.at(5) });
    b.agent({ type: "agent_message", role: "assistant", text: "b", ts: "not a date" });
    b.agent({ type: "agent_message", role: "assistant", text: "c", ts: TraceBuilder.at(12) });
    // meta.startedAt is the replay run's wall clock in replay.db, days after the source times.
    const session = foldRows(testMeta({ startedAt: "2026-09-21T00:00:00.000Z" }), b.rows, { live: false });
    expect(session.steps.map((step) => step.tMs)).toEqual([0, 0, 0, 2_000]);
    expect(session.span).toEqual({ startTs: TraceBuilder.at(10), endTs: TraceBuilder.at(12), durationMs: 2_000 });
    expect(session.steps[2]?.startTs).toBe("not a date");
    // startMs (R25) is the unclamped source time; a ts that does not parse gets origin + clock.
    expect(session.steps.map((step) => step.startMs)).toEqual(
      [10, 5, 10, 12].map((seconds) => Date.parse(TraceBuilder.at(seconds))),
    );
    expect(session.originMs).toBe(Date.parse(TraceBuilder.at(10)));
  });

  it("starts oauth's display clock at its first agent row and derives every tMs from startMs", () => {
    const trace = loadFixtureTrace("oauth");
    const session = foldRows(trace.meta, trace.rows, { live: false });
    const first = trace.rows.find((row) => row.type === "agent_event");
    const firstMs = Date.parse(String((first?.payload as { ts?: unknown } | undefined)?.ts));
    expect(Number.isNaN(firstMs)).toBe(false);
    expect(session.steps[0]?.startMs).toBe(firstMs);
    expect(session.originMs).toBe(firstMs);
    // spec §6.5: tMs = max(startMs - originMs, tMs of the previous step in seq order, 0).
    let previous = 0;
    for (const step of session.steps) {
      expect(step.tMs, step.id).toBe(Math.max(step.startMs - session.originMs, previous, 0));
      previous = step.tMs;
    }
  });

  it("keeps the last 20 lines of stdout then stderr as the output tail", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const stdout = `${Array.from({ length: 25 }, (_, index) => `out ${index + 1}`).join("\r\n")}\r\n`;
    const noisy = b.agent({ type: "command_started", command: "make all" });
    b.agent({ type: "command_completed", command: "make all", exitCode: 1, stdout, stderr: "err 1\nerr 2\n\n" });
    const quiet = b.agent({ type: "command_started", command: "true" });
    b.agent({ type: "command_completed", command: "true", exitCode: 0, stdout: "", stderr: "" });
    const long = b.agent({ type: "command_started", command: "cat big.log" });
    b.agent({ type: "command_completed", command: "cat big.log", exitCode: 0, stdout: "x".repeat(5_000), stderr: "" });
    const session = fold(b);
    const expected = [...Array.from({ length: 18 }, (_, index) => `out ${index + 8}`), "err 1", "err 2"].join("\n");
    expect(stepAt(session, noisy).command?.outputTail).toBe(expected);
    expect(stepAt(session, quiet).command).not.toHaveProperty("outputTail");
    expect(stepAt(session, long).command?.outputTail).toBe("x".repeat(2_048));
  });

  it("gives an open step at the live edge a duration up to nowMs", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const run = b.agent({ type: "command_started", command: "pnpm install" });
    const startMs = Date.parse(TraceBuilder.at(run - 1));
    const live = foldRows(testMeta(), b.rows, { live: true, nowMs: startMs + 4_000 });
    expect(stepAt(live, run)).toMatchObject({ status: "running", startMs, durationMs: 4_000, endTMs: null });
    expect(stepAt(foldRows(testMeta(), b.rows, { live: true }), run).durationMs).toBeNull();
    expect(stepAt(foldRows(testMeta(), b.rows, { live: false, nowMs: startMs + 4_000 }), run)).toMatchObject({
      status: "unknown",
      durationMs: null,
    });
  });

  it("never changes a returned session when more rows arrive", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "command_started", command: "pnpm test" });
    const state = accumulateAll(createTraceState(testMeta()), b.rows);
    const before = finalize(state, { live: true });
    const snapshot = structuredClone(before);
    accumulate(state, { seq: 3, type: "agent_event", ts: TraceBuilder.at(3), payload: {
      type: "command_completed", sessionId: "sess-test", ts: TraceBuilder.at(3), command: "pnpm test", exitCode: 0, stdout: "", stderr: "",
    } });
    expect(before).toEqual(snapshot);
    expect(finalize(state, { live: true }).steps[1]?.status).toBe("ok");
  });
});
