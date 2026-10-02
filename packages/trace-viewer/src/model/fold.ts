import {
  ChangeUnitSchema,
  DecisionSchema,
  EVENT_TYPES,
  EvidenceFactSchema,
  JevDecisionLogSchema,
  NormalizedAgentEventSchema,
  OverviewSnapshotSchema,
  ValidationResultSchema,
  type EventStoreType,
  type TraceRow,
  type TraceSessionSummary,
} from "@jevcode/contracts";
import type { z } from "zod";

import { exactGuard } from "./exact-guard.js";
import { foldAgentEvent } from "./fold-agent.js";
import { foldChangeUnit, foldDecision, foldJevDecision } from "./fold-chapters.js";
import { foldEvidenceFact, foldValidation } from "./fold-evidence.js";
import { finalizeState, type FinalizeOptions } from "./fold-finalize.js";
import { foldOverviewSnapshot } from "./fold-overview.js";
import { addGap, advanceClock, clockTs, FoldState, type RowContext } from "./fold-state.js";
import { ENVELOPE_RULES } from "./registry.js";
import type { TraceSession } from "./types.js";

export interface TraceState {
  readonly meta: TraceSessionSummary;
  readonly loadedThroughSeq: number;
  readonly received: number;
}

export type { FinalizeOptions } from "./fold-finalize.js";

export function createTraceState(meta: TraceSessionSummary): TraceState {
  return new FoldState({ ...meta });
}

function internal(state: TraceState): FoldState {
  if (!(state instanceof FoldState)) {
    throw new TypeError("accumulate/finalize need a state made by createTraceState");
  }
  return state;
}

function isEventStoreType(type: string): type is EventStoreType {
  return (EVENT_TYPES as readonly string[]).includes(type);
}

/** agent_event and evidence_fact rows move the clock; every other row inherits it (spec §6.5). */
function clockContext(state: FoldState, row: TraceRow, payloadTs: string): RowContext {
  return { seq: row.seq, sourceTs: payloadTs, t: advanceClock(state.clock, payloadTs) };
}

function inheritedContext(state: FoldState, row: TraceRow): RowContext {
  const t = state.clock.last;
  return { seq: row.seq, sourceTs: clockTs(state.clock, t, row.ts), t };
}

/** change_unit rows are re-emitted on every unit update (85k of 111k soak rows) and carry long id
 *  lists, so zod's per-node parse dominated the fold. The exact guard accepts only payloads zod
 *  would parse to an equal copy; everything else still goes through zod (verdict and message). The
 *  payload is then used as is, which is safe because the fold never mutates a parsed unit. */
const isExactChangeUnit = exactGuard(ChangeUnitSchema);

/** The parsed payload, or null after recording an invalid_row gap (the fold continues). */
function parseOrGap<T>(
  state: FoldState,
  row: TraceRow,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  fast?: (value: unknown) => boolean,
): T | null {
  if (fast?.(row.payload) === true) return row.payload as T;
  const parsed = schema.safeParse(row.payload);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues[0];
  addGap(
    state,
    "invalid_row",
    row.seq,
    `${row.type} row ${row.seq} failed its schema${detail !== undefined ? ` at ${detail.path.join(".") || "payload"}: ${detail.message}` : ""}`,
  );
  return null;
}

/**
 * Mutates state and returns it. A seq already folded is skipped silently; a new seq below the
 * max folded seq adds an out_of_order gap and is skipped; a payload that fails its contracts
 * schema adds an invalid_row gap; a type outside EVENT_TYPES adds an unknown_row_type gap.
 */
export function accumulate(state: TraceState, row: TraceRow): TraceState {
  const s = internal(state);
  if (!Number.isInteger(row.seq) || row.seq < 1) {
    addGap(s, "invalid_row", 0, `row has an invalid seq ${String(row.seq)}`);
    return state;
  }
  if (s.seen.has(row.seq)) return state;
  s.seen.add(row.seq);
  s.received = s.seen.size;
  if (row.seq < s.maxSeq) {
    addGap(s, "out_of_order", row.seq, `row ${row.seq} arrived after row ${s.maxSeq} and was skipped`);
    return state;
  }
  s.maxSeq = row.seq;
  s.loadedThroughSeq = row.seq;
  const type = row.type;
  if (!isEventStoreType(type)) {
    addGap(s, "unknown_row_type", row.seq, `row ${row.seq} has unknown type "${type.slice(0, 64)}"`);
    return state;
  }
  if (ENVELOPE_RULES[type] === "hidden") {
    s.hidden[type] = (s.hidden[type] ?? 0) + 1;
    return state;
  }
  switch (type) {
    case "agent_event": {
      const event = parseOrGap(s, row, NormalizedAgentEventSchema);
      if (event !== null) foldAgentEvent(s, event, clockContext(s, row, event.ts));
      break;
    }
    case "evidence_fact": {
      const fact = parseOrGap(s, row, EvidenceFactSchema);
      if (fact !== null) foldEvidenceFact(s, row, fact, clockContext(s, row, fact.ts));
      break;
    }
    case "validation": {
      const validation = parseOrGap(s, row, ValidationResultSchema);
      if (validation !== null) foldValidation(s, validation, inheritedContext(s, row));
      break;
    }
    case "change_unit": {
      const unit = parseOrGap(s, row, ChangeUnitSchema, isExactChangeUnit);
      if (unit !== null) foldChangeUnit(s, unit, inheritedContext(s, row));
      break;
    }
    case "decision": {
      const decision = parseOrGap(s, row, DecisionSchema);
      if (decision !== null) foldDecision(s, decision, inheritedContext(s, row));
      break;
    }
    case "jev_decision": {
      const log = parseOrGap(s, row, JevDecisionLogSchema);
      if (log !== null) foldJevDecision(s, log, inheritedContext(s, row));
      break;
    }
    case "overview_snapshot": {
      // Replace semantics (spec §8.1): no step, no clock move, no turn; an invalid payload is an invalid_row gap.
      const snapshot = parseOrGap(s, row, OverviewSnapshotSchema);
      if (snapshot !== null) foldOverviewSnapshot(s, snapshot, row.seq);
      break;
    }
    default:
      s.hidden[type] = (s.hidden[type] ?? 0) + 1;
  }
  return state;
}

export function accumulateAll(state: TraceState, rows: readonly TraceRow[]): TraceState {
  for (const row of rows) accumulate(state, row);
  return state;
}

// ------------------------------------------------------------ finalize

/**
 * The session of the rows accumulated so far. Incremental: a call re-derives only what the rows
 * since the previous call on this state can change (fold-finalize.ts). Same rows in any batch split,
 * with finalize called between any of the batches, produce a deep-equal TraceSession. A returned
 * session is never mutated later, and between calls with the same `live` an unchanged step,
 * chapter, entity, turn or finding (and an unchanged list of them) is the same object.
 */
export function finalize(state: TraceState, options: FinalizeOptions): TraceSession {
  return finalizeState(internal(state), options);
}

export function foldRows(
  meta: TraceSessionSummary,
  rows: readonly TraceRow[],
  options: FinalizeOptions,
): TraceSession {
  return finalize(accumulateAll(createTraceState(meta), rows), options);
}
