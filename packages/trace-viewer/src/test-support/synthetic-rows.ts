// Test-only: a synthetic session shaped like a long live Codex run, for the fold benchmark
// and the parity property. Excluded from the build (tsconfig.build.json).
import type { TraceRow, TraceSessionSummary } from "@jevcode/contracts";

const SESSION = "sess-bench";
const REPO = "repo-bench";
const START = Date.parse("2026-09-18T09:00:00.000Z");

export const SYNTHETIC_META: TraceSessionSummary = {
  sessionId: SESSION,
  repoId: REPO,
  repoName: "bench",
  prompt: "Synthetic 75k-row session",
  state: "completed",
  startedAt: new Date(START).toISOString(),
  endedAt: null,
  lastEventSeq: 0,
};

/** One cycle of a realistic session: talk, read, edit (claim + repo facts), run tests, Jev. */
function cycle(index: number, turnId: string): { type: string; payload: Record<string, unknown> }[] {
  const ts = new Date(START + index * 4_000).toISOString();
  const file = `src/module-${index % 50}/file-${index % 7}.ts`;
  const call = `${turnId}:item_${index}`;
  const testCall = `${turnId}:item_${index}_t`;
  const failed = index % 9 === 0 ? 1 : 0;
  const base = { sessionId: SESSION, ts, turnId };
  const fact = { repoId: REPO, sessionId: SESSION, ts };
  return [
    { type: "agent_event", payload: { ...base, type: "agent_message", role: "assistant", text: `Working on step ${index}: updating ${file}.` } },
    { type: "agent_event", payload: { ...base, type: "agent_reasoning", text: "Considering the next edit.".repeat(4) } },
    { type: "agent_event", payload: { ...base, type: "tool_started", tool: "read_file", input: file, callId: `${call}_r` } },
    { type: "agent_event", payload: { ...base, type: "tool_completed", tool: "read_file", output: "x".repeat(400), callId: `${call}_r` } },
    { type: "agent_event", payload: { ...base, type: "file_changed", path: file, callId: call } },
    { type: "evidence_fact", payload: { ...fact, type: "file_changed", path: file, kind: "modified" } },
    { type: "evidence_fact", payload: { ...fact, type: "git_hunk", file, added: index % 13, removed: index % 5, isFormattingOnly: false, isConfigOnly: false, isLockfile: false } },
    { type: "agent_event", payload: { ...base, type: "command_started", command: "pnpm test", callId: testCall } },
    { type: "agent_event", payload: { ...base, type: "command_completed", command: "pnpm test", exitCode: failed, stdout: "Tests passed\n".repeat(20), stderr: "", callId: testCall } },
    { type: "evidence_fact", payload: { ...fact, type: "command_executed", command: "pnpm test", exitCode: failed, isDestructive: false, sourceCallId: testCall } },
    { type: "evidence_fact", payload: { ...fact, type: "test_result", runner: "vitest", command: "pnpm test", passed: 40, failed, skipped: 0, failures: failed > 0 ? [{ file, testName: "suite > case", message: "expected 1 to be 2" }] : [], sourceCallId: testCall } },
    { type: "jev_decision", payload: { id: `jev_${index}`, sessionId: SESSION, changeUnitId: `cu_${index % 40}`, inputHash: "abc", output: {}, confidence: 0.8, latencyMs: 5, clientKind: "degrade", clamps: index % 5 === 0 ? ["schema_floor"] : [], ts } },
    { type: "telemetry", payload: { sessionId: SESSION, name: "agent_event_count", ts } },
    { type: "graph_node", payload: { sessionId: SESSION, id: `n_${index}`, ts } },
    { type: "change_unit", payload: { id: `cu_${index % 40}`, sessionId: SESSION, title: `Unit ${index % 40}`, category: "implementation", status: "in_progress", files: [file], symbols: [], interfacesChanged: [], schemaChanges: [], dependencyChanges: [], relatedDecisions: [], validationResults: [], evidence: [`fact_${index}`], createdAt: ts, updatedAt: ts, agentCallIds: [call] } },
  ];
}

export function syntheticRows(count: number): TraceRow[] {
  const rows: TraceRow[] = [];
  let turn = 0;
  for (let index = 0; rows.length < count; index += 1) {
    if (index % 200 === 0) {
      turn += 1;
      const ts = new Date(START + index * 4_000).toISOString();
      rows.push({ seq: rows.length + 1, type: "agent_event", ts, payload: { type: "agent_started", sessionId: SESSION, ts, prompt: `Turn ${turn}`, turnId: `turn-${turn}` } });
    }
    for (const entry of cycle(index, `turn-${turn}`)) {
      if (rows.length >= count) break;
      const ts = String(entry.payload["ts"] ?? new Date(START).toISOString());
      rows.push({ seq: rows.length + 1, type: entry.type, ts, payload: entry.payload, ...(entry.type === "evidence_fact" ? { factId: `fact_${rows.length}` } : {}) });
    }
  }
  return rows;
}
