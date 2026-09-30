import { describe, expect, it } from "vitest";

import type { TraceRow } from "@jevcode/contracts";

import { loadFixtureTrace, type FixtureName } from "../test-support/fixture-rows.js";
import { foldRows } from "./fold.js";
import type { TraceSession } from "./types.js";

// Each test breaks one thing in a real fixture and checks the fold reports it instead of
// hiding it. Rows are selected by content, never by line number.

function field(row: TraceRow, key: string): unknown {
  return (row.payload as Record<string, unknown>)[key];
}

function isPayload(type: string, extra: Record<string, unknown> = {}) {
  return (row: TraceRow) =>
    field(row, "type") === type && Object.entries(extra).every(([key, value]) => field(row, key) === value);
}

function mutate(
  name: FixtureName,
  change: (rows: TraceRow[]) => TraceRow[],
  live = false,
): { rows: TraceRow[]; session: TraceSession } {
  const trace = loadFixtureTrace(name);
  const rows = change(trace.rows);
  return { rows, session: foldRows(trace.meta, rows, { live }) };
}

function seqOf(rows: readonly TraceRow[], predicate: (row: TraceRow) => boolean): number {
  const row = rows.find(predicate);
  if (row === undefined) throw new Error("row not found");
  return row.seq;
}

/** Inserts agent events before or after the first matching agent row, with that row's times, and
 *  renumbers every seq in order. */
function insertAgentRows(
  rows: readonly TraceRow[],
  predicate: (row: TraceRow) => boolean,
  where: "before" | "after",
  events: Record<string, unknown>[],
): TraceRow[] {
  const at = rows.findIndex(predicate);
  const anchor = rows[at];
  if (anchor === undefined) throw new Error("row not found");
  const added = events.map((event) => ({
    seq: 0,
    type: "agent_event",
    ts: anchor.ts,
    payload: { sessionId: field(anchor, "sessionId"), ts: field(anchor, "ts"), ...event },
  }));
  const index = where === "before" ? at : at + 1;
  return [...rows.slice(0, index), ...added, ...rows.slice(index)].map((row, position) => ({ ...row, seq: position + 1 }));
}

describe("fold mutations", () => {
  it("dropping oauth's test_result adds missing_evidence and silences the test signals", () => {
    const trace = loadFixtureTrace("oauth");
    const start = seqOf(trace.rows, isPayload("command_started", { command: "pnpm test" }));
    const { session } = mutate("oauth", (rows) =>
      rows.filter((row) => !isPayload("test_result")(row) && row.type !== "validation"),
    );
    expect(session.gaps).toEqual([expect.objectContaining({ kind: "missing_evidence", atSeq: start })]);
    const step = session.steps.find((candidate) => candidate.firstSeq === start);
    expect(step).toMatchObject({ kind: "test", status: "failed", problems: ["exit_nonzero"] });
    expect(session.findings).toEqual([]);
    expect(session.coverage.signals.find((signal) => signal.id === "claim_contradicted")).toEqual({
      id: "claim_contradicted",
      active: false,
      missing: ["test_results"],
    });
  });

  it("a failing schema-change test run makes its completion claim contradicted", () => {
    const { rows, session } = mutate("schema-change", (input) =>
      input.map((row) =>
        isPayload("test_result")(row)
          ? { ...row, payload: { ...(row.payload as object), passed: 41, failed: 1 } }
          : row,
      ),
    );
    const claim = seqOf(rows, isPayload("agent_message", { text: "Schema change complete with migration and passing tests." }));
    const result = seqOf(rows, isPayload("test_result"));
    const finding = session.findings.find((candidate) => candidate.ruleId === "claim_contradicted");
    expect(finding).toMatchObject({ anchorSeq: claim, evidenceSeqs: [result, claim] });
  });

  it("a test command that never completes is unknown with an unpaired gap, or running at the live edge", () => {
    const drop = (rows: TraceRow[]) => rows.filter((row) => !isPayload("command_completed", { command: "pnpm test" })(row));
    const trace = loadFixtureTrace("oauth");
    const start = seqOf(trace.rows, isPayload("command_started", { command: "pnpm test" }));
    const closed = mutate("oauth", drop).session;
    expect(closed.steps.find((step) => step.firstSeq === start)).toMatchObject({ status: "unknown", endTMs: null });
    expect(closed.gaps).toEqual([expect.objectContaining({ kind: "unpaired", atSeq: start })]);
    const live = mutate(
      "oauth",
      (rows) => drop(rows).filter((row) => !isPayload("agent_completed")(row)),
      true,
    ).session;
    expect(live.steps.find((step) => step.firstSeq === start)?.status).toBe("running");
    expect(live.turns[0]?.outcome).toBe("running");
    expect(live.gaps).toEqual([]);
  });

  it("a corrupt payload becomes one invalid_row gap and every other row still folds", () => {
    const trace = loadFixtureTrace("rate-limit");
    const target = seqOf(trace.rows, isPayload("git_hunk", { file: "src/redis/client.ts" }));
    const intact = foldRows(trace.meta, trace.rows, { live: false });
    const { session } = mutate("rate-limit", (rows) =>
      rows.map((row) => (row.seq === target ? { ...row, payload: { type: "git_hunk", file: 42 } } : row)),
    );
    expect(session.gaps).toEqual([expect.objectContaining({ kind: "invalid_row", atSeq: target })]);
    expect(session.steps.length).toBe(intact.steps.length);
    expect(session.findings).toEqual(intact.findings);
  });

  it("a steer yields one instruction step", () => {
    const steer = "Use a token bucket, not a fixed window.";
    const { rows, session } = mutate("rate-limit", (input) =>
      insertAgentRows(input, (row) => isPayload("agent_message", { role: "assistant" })(row) && String(field(row, "text")).startsWith("Plan:"), "after", [
        { type: "agent_interrupted", reason: "steer" },
        { type: "agent_started", prompt: steer },
        { type: "agent_message", role: "user", text: steer },
      ]),
    );
    const relaunch = seqOf(rows, isPayload("agent_started", { prompt: steer }));
    const echo = seqOf(rows, isPayload("agent_message", { text: steer }));
    const instructions = session.steps.filter((step) => step.kind === "instruction");
    expect(instructions.map((step) => step.text)).toEqual([field(rows[0] as TraceRow, "prompt"), steer]);
    expect(instructions[1]).toMatchObject({ firstSeq: relaunch, seqs: [relaunch, echo] });
    expect(session.turns.map((turn) => [turn.trigger, turn.outcome])).toEqual([
      ["initial", "interrupted"],
      ["steer", "completed"],
    ]);
    expect(session.gaps).toEqual([]);
  });

  it("a decision answered with an instruction yields no instruction step", () => {
    const trace = loadFixtureTrace("oauth");
    const answer = trace.rows.find(isPayload("agent_message", { role: "user" }));
    if (answer === undefined) throw new Error("no decision answer in oauth");
    const text = field(answer, "text");
    // sendDecision with an instruction relaunches Codex with the answer before it echoes it.
    const { rows, session } = mutate("oauth", (input) =>
      insertAgentRows(input, isPayload("agent_message", { role: "user" }), "before", [
        { type: "agent_interrupted", reason: "steer" },
        { type: "agent_started", prompt: text },
      ]),
    );
    const relaunch = seqOf(rows, isPayload("agent_started", { prompt: text }));
    const message = seqOf(rows, isPayload("agent_message", { role: "user" }));
    const title = field(rows.find((row) => row.type === "decision") as TraceRow, "title");
    expect(session.steps.filter((step) => step.kind === "instruction").map((step) => step.firstSeq)).toEqual([1]);
    const decision = session.steps.find((step) => step.kind === "decision");
    expect(decision?.seqs).toEqual(expect.arrayContaining([relaunch, message]));
    expect(decision?.decision?.answerSeq).toBe(message);
    expect(session.turns[1]).toMatchObject({ trigger: "steer", startSeq: relaunch, prompt: title });
    expect(session.findings.map((finding) => finding.ruleId).sort()).toEqual(["claim_contradicted", "failing_tests"]);
    expect(session.gaps).toEqual([]);
  });

  it("an unknown row type from a newer build is a gap, not a crash", () => {
    const { session } = mutate("api-break", (rows) => [
      ...rows,
      { seq: rows.length + 1, type: "agent_plan", ts: rows[rows.length - 1]?.ts ?? "", payload: { steps: [] } },
    ]);
    expect(session.gaps.map((gap) => gap.kind)).toEqual(["unknown_row_type"]);
    expect(session.findings.map((finding) => finding.ruleId).sort()).toEqual(["claim_contradicted", "failing_tests"]);
  });
});
