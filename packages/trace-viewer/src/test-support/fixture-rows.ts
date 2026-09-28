// Test-only: loads fixtures/<name>/events.jsonl through the real semantic pipeline.
// Excluded from the build (tsconfig.build.json) and from the model import bans.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { EvidenceFact, TraceRow, TraceSessionSummary } from "@jevcode/contracts";
import { factContentId, parseReplayLine, PipelineCoordinator } from "@jevcode/semantic-core";

import { normalizeCommand } from "../model/format.js";
import { rowsFromPipelineRecords } from "../model/rows.js";

export const FIXTURE_NAMES = ["oauth", "rate-limit", "schema-change", "api-break", "dep-change"] as const;

export type FixtureName = (typeof FIXTURE_NAMES)[number];

export interface FixtureTrace {
  meta: TraceSessionSummary;
  rows: TraceRow[];
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

export function fixtureEventsPath(name: FixtureName): string {
  return path.join(REPO_ROOT, "fixtures", name, "events.jsonl");
}

export function fixtureLines(name: FixtureName): string[] {
  return readFileSync(fixtureEventsPath(name), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
}

function field(payload: unknown, key: string): unknown {
  return payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>)[key] : undefined;
}

/**
 * Reads fixtures/<name>/events.jsonl, parses each line with parseReplayLine, ingests all
 * records into a PipelineCoordinator, flushes, and returns the records' rows
 * (factId = factContentId) followed by one change_unit row per snapshot unit and one
 * validation row per snapshot validation. meta.state = "completed".
 */
export function loadFixtureTrace(name: FixtureName): FixtureTrace {
  const records = fixtureLines(name).map((line, index) => {
    const record = parseReplayLine(line);
    if (record === null) throw new Error(`${name}: line ${index + 1} is empty`);
    return record;
  });
  const coordinator = new PipelineCoordinator();
  for (const record of records) coordinator.ingest(record);
  coordinator.flush();
  const snapshot = coordinator.snapshot();
  const recordRows = rowsFromPipelineRecords(records, {
    factId: (fact: EvidenceFact) => factContentId(fact.sessionId, fact),
  });
  const derivedRows = rowsFromPipelineRecords([...snapshot.units, ...snapshot.validations], {
    firstSeq: recordRows.length + 1,
  });
  const rows = [...recordRows, ...derivedRows];
  const first = rows[0];
  const last = rows[recordRows.length - 1];
  if (first === undefined || last === undefined) throw new Error(`${name}: fixture has no records`);
  const started = records.find((record) => field(record, "type") === "agent_started");
  const repoId = records.map((record) => field(record, "repoId")).find((value) => typeof value === "string");
  const meta: TraceSessionSummary = {
    sessionId: String(field(first.payload, "sessionId")),
    repoId: typeof repoId === "string" ? repoId : `repo-${name}`,
    repoName: name,
    prompt: String(field(started, "prompt") ?? ""),
    state: "completed",
    startedAt: first.ts,
    endedAt: last.ts,
    lastEventSeq: rows.length,
  };
  return { meta, rows };
}

// ------------------------------------------------------------ capture-field variants

const CAPTURE_EVENT_KEYS = ["turnId", "callId"] as const;

/** The rows as a session recorded before M1 would store them (D11): no turnId, callId,
 *  sourceCallId, factId or agentCallIds. */
export function stripCaptureFields(rows: readonly TraceRow[]): TraceRow[] {
  return rows.map((row) => {
    const { factId: _factId, ...rest } = row;
    const payload = row.payload;
    if (payload === null || typeof payload !== "object") return { ...rest };
    const copy = { ...(payload as Record<string, unknown>) };
    if (row.type === "agent_event") for (const key of CAPTURE_EVENT_KEYS) delete copy[key];
    if (row.type === "evidence_fact") delete copy["sourceCallId"];
    if (row.type === "change_unit") delete copy["agentCallIds"];
    return { ...rest, payload: copy };
  });
}

const CALL_FAMILY: Readonly<Record<string, { family: string; role: "start" | "complete" }>> = {
  command_started: { family: "command", role: "start" },
  command_completed: { family: "command", role: "complete" },
  tool_started: { family: "tool", role: "start" },
  tool_completed: { family: "tool", role: "complete" },
};

/** The rows as M1 capture (A1-9) would store them: every agent event carries turnId,
 *  start/complete pairs share callId `${turnId}:item_<n>`, and command_executed /
 *  test_result facts carry the sourceCallId of the latest same-command call. Fields
 *  already present are kept. */
export function addCaptureFields(rows: readonly TraceRow[]): TraceRow[] {
  let turn = 0;
  let item = 0;
  const open = new Map<string, string[]>();
  const latestCallByCommand = new Map<string, string>();
  return rows.map((row) => {
    const payload = row.payload;
    if (payload === null || typeof payload !== "object") return { ...row };
    const copy = { ...(payload as Record<string, unknown>) };
    if (row.type === "agent_event") {
      const type = String(copy["type"]);
      if (type === "agent_started") {
        turn += 1;
        open.clear();
      }
      const turnId = typeof copy["turnId"] === "string" ? copy["turnId"] : `turn-${Math.max(turn, 1)}`;
      copy["turnId"] = turnId;
      const family = CALL_FAMILY[type];
      if (family !== undefined) {
        const target = String(copy["command"] ?? copy["tool"] ?? "");
        const key = `${family.family}\u0000${normalizeCommand(target)}`;
        if (family.role === "start") {
          item += 1;
          const callId = typeof copy["callId"] === "string" ? copy["callId"] : `${turnId}:item_${item}`;
          copy["callId"] = callId;
          open.set(key, [...(open.get(key) ?? []), callId]);
          if (family.family === "command") latestCallByCommand.set(normalizeCommand(target), callId);
        } else {
          const queue = open.get(key) ?? [];
          const callId = typeof copy["callId"] === "string" ? copy["callId"] : queue[0];
          if (callId !== undefined) copy["callId"] = callId;
          open.set(key, queue.filter((candidate) => candidate !== callId));
        }
      }
    }
    if (row.type === "evidence_fact") {
      const type = String(copy["type"]);
      if ((type === "command_executed" || type === "test_result") && typeof copy["sourceCallId"] !== "string") {
        const callId = latestCallByCommand.get(normalizeCommand(String(copy["command"] ?? "")));
        if (callId !== undefined) copy["sourceCallId"] = callId;
      }
    }
    return { ...row, payload: copy };
  });
}
