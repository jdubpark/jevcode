import {
  ChangeUnitSchema,
  DecisionSchema,
  EVENT_TYPES,
  EvidenceFactSchema,
  JevDecisionLogSchema,
  NormalizedAgentEventSchema,
  ValidationResultSchema,
  type AgentState,
  type EventStoreType,
  type TraceRow,
  type TraceSessionSummary,
} from "@jevcode/contracts";
import type { z } from "zod";

import { applyNoise, applyProblems, flagMissingEvidence } from "./classify.js";
import { foldAgentEvent } from "./fold-agent.js";
import { buildChapters, foldChangeUnit, foldDecision, foldJevDecision } from "./fold-chapters.js";
import { buildEntities, foldEvidenceFact, foldValidation } from "./fold-evidence.js";
import {
  addGap,
  advanceClock,
  clockTs,
  FoldState,
  type DisplayClock,
  type RowContext,
  type StepDraft,
  type TurnDraft,
} from "./fold-state.js";
import { stepHeadline } from "./format.js";
import { ENVELOPE_RULES } from "./registry.js";
import {
  CAPABILITIES,
  SIGNAL_IDS,
  TRACE_SCHEMA_VERSION,
  type Capability,
  type Coverage,
  type Gap,
  type Step,
  type StepId,
  type StepStatus,
  type TraceSession,
  type Turn,
  type TurnOutcome,
} from "./types.js";

export interface TraceState {
  readonly meta: TraceSessionSummary;
  readonly loadedThroughSeq: number;
  readonly received: number;
}

export interface FinalizeOptions {
  live: boolean;
  /** Overrides meta.state (the latest TraceRowsPage.state). */
  state?: AgentState;
  /** cursorAfter(lastPage); raises loadedThroughSeq past filtered rows. */
  throughSeq?: number;
  /** Epoch ms on the session's source clock (TraceSource.now()). With live, a running step lasts
   *  nowMs - startMs (spec §6.5); without it a running step's durationMs is null. */
  nowMs?: number;
}

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

/** The parsed payload, or null after recording an invalid_row gap (the fold continues). */
function parseOrGap<T>(state: FoldState, row: TraceRow, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T | null {
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
      const unit = parseOrGap(s, row, ChangeUnitSchema);
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

function settledStatus(draft: StepDraft): StepStatus {
  if (draft.command === undefined) return draft.status;
  if (draft.tests !== undefined && draft.tests.failed > 0) return "failed";
  const exitCode = draft.command.exitCode;
  if (exitCode !== null && exitCode > 0) return "failed";
  if (exitCode === 0) return "ok";
  // exit -1 (Codex gave none) or no exit code: known only through a clean test result.
  return draft.tests !== undefined && draft.tests.passed > 0 ? "ok" : "unknown";
}

function headlineOf(draft: StepDraft): string {
  return stepHeadline({
    kind: draft.kind,
    ...(draft.target !== undefined ? { target: draft.target } : {}),
    ...(draft.label !== null ? { text: draft.label } : draft.text !== undefined ? { text: draft.text } : {}),
    ...(draft.tests !== undefined
      ? { tests: { passed: draft.tests.passed, failed: draft.tests.failed, skipped: draft.tests.skipped } }
      : {}),
    ...(draft.command !== undefined ? { exitCode: draft.open ? null : draft.command.exitCode } : {}),
    ...(draft.decision !== undefined ? { decisionTitle: draft.decision.title } : {}),
    ...(draft.guardrail !== undefined ? { clampIds: draft.guardrail.clampIds } : {}),
  });
}

/** A deep copy with the private draft fields dropped: later rows never change a returned session. */
function toPublicStep(draft: StepDraft, openStatus: "running" | "unknown"): Step {
  const step: Step = {
    id: draft.id,
    kind: draft.kind,
    lane: draft.lane,
    actor: draft.actor,
    provenance: draft.provenance,
    status: draft.open ? openStatus : settledStatus(draft),
    headline: headlineOf(draft),
    ...(draft.target !== undefined ? { target: draft.target } : {}),
    ...(draft.text !== undefined ? { text: draft.text } : {}),
    ...(draft.callId !== undefined ? { callId: draft.callId } : {}),
    turnIndex: draft.turnIndex,
    seqs: [...draft.seqs],
    firstSeq: draft.firstSeq,
    lastSeq: draft.lastSeq,
    startTs: draft.startTs,
    endTs: draft.open ? null : draft.endTs,
    tMs: draft.tMs,
    startMs: draft.startMs,
    endTMs: draft.open ? null : draft.endTMs,
    durationMs: draft.open ? null : draft.durationMs,
    approxTime: draft.approxTime,
    evidenceSeqs: [...draft.evidenceSeqs],
    chapterIds: [],
    entityIds: [],
    findingIds: [],
    problems: [],
    noise: null,
  };
  if (draft.command !== undefined) step.command = { ...draft.command };
  if (draft.tests !== undefined) {
    step.tests = { ...draft.tests, failures: draft.tests.failures.map((failure) => ({ ...failure })) };
  }
  if (draft.edit !== undefined) step.edit = { ...draft.edit };
  if (draft.decision !== undefined) {
    step.decision = { ...draft.decision, options: draft.decision.options.map((option) => ({ ...option })) };
  }
  if (draft.guardrail !== undefined) step.guardrail = { ...draft.guardrail, clampIds: [...draft.guardrail.clampIds] };
  return step;
}

function outcomeOf(turn: TurnDraft, isLast: boolean, live: boolean): Pick<Turn, "outcome" | "interruptReason"> {
  const terminal = turn.terminal;
  if (terminal !== null) {
    if (terminal.type === "agent_completed") return { outcome: "completed" };
    if (terminal.type === "agent_failed") return { outcome: "failed" };
    return terminal.reason !== undefined
      ? { outcome: "interrupted", interruptReason: terminal.reason }
      : { outcome: "interrupted" };
  }
  if (!isLast) return { outcome: turn.decisionAnswered ? "waiting" : "interrupted" };
  if (!live) return { outcome: "unknown" };
  const waiting: TurnOutcome =
    turn.lastAgentEvent === "agent_waiting" || turn.lastAgentEvent === "approval_requested" ? "waiting" : "running";
  return { outcome: waiting };
}

function toPublicTurn(turn: TurnDraft, isLast: boolean, live: boolean): Turn {
  return {
    index: turn.index,
    trigger: turn.trigger,
    prompt: turn.prompt,
    ...outcomeOf(turn, isLast, live),
    ...(turn.turnId !== undefined ? { turnId: turn.turnId } : {}),
    startSeq: turn.startSeq,
    endSeq: turn.endSeq,
    startTs: turn.startTs,
    endTs: turn.endTs,
    tMs: turn.tMs,
    endTMs: turn.endTMs,
    stepIds: [...turn.stepIds],
  };
}

/** Capabilities present in the folded rows. No signal is evaluated yet, so each one reads inactive. */
function coverageOf(capabilities: ReadonlySet<Capability>, approximateJoins: boolean, inferredSteps: number): Coverage {
  return {
    capabilities: CAPABILITIES.filter((capability) => capabilities.has(capability)),
    signals: SIGNAL_IDS.map((id) => ({ id, active: false, missing: [] })),
    approximateJoins,
    inferredSteps,
  };
}

function compareGaps(a: Gap, b: Gap): number {
  return a.atSeq - b.atSeq || a.kind.localeCompare(b.kind) || a.message.localeCompare(b.message);
}

/** TraceSession.originMs (spec §6.5): the first clock row's source time, else meta.startedAt,
 *  else 0. Never NaN. */
function originOf(clock: DisplayClock, startedAt: string): number {
  if (!Number.isNaN(clock.origin)) return clock.origin;
  const parsed = Date.parse(startedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Never mutates state. Same rows in any batch split produce a deep-equal TraceSession. */
export function finalize(state: TraceState, options: FinalizeOptions): TraceSession {
  const s = internal(state);
  const live = options.live;
  const lastTurnIndex = s.turns.length - 1;
  const gaps: Gap[] = [...s.gaps];
  const turns = s.turns.map((turn) => toPublicTurn(turn, turn.index === lastTurnIndex, live));
  const steps = s.steps.map((draft) => {
    const running = live && draft.turnIndex === lastTurnIndex;
    if (draft.open && !running) {
      gaps.push({
        kind: "unpaired",
        atSeq: draft.firstSeq,
        message: `${draft.target ?? draft.kind} started but never finished`,
      });
    }
    return toPublicStep(draft, running ? "running" : "unknown");
  });
  const nowMs = options.nowMs;
  if (live && nowMs !== undefined) {
    // spec §6.5: an open step at the live edge lasts until now.
    for (const step of steps) if (step.status === "running") step.durationMs = Math.max(0, nowMs - step.startMs);
  }
  steps.sort((a, b) => a.firstSeq - b.firstSeq);
  const stepById = new Map<StepId, Step>(steps.map((step) => [step.id, step]));

  const entities = buildEntities(steps, s.evidence.duplicates);
  const chapters = buildChapters(s, steps, stepById, entities);
  applyProblems(steps);
  flagMissingEvidence(steps, turns, live, gaps);
  applyNoise(steps, { duplicates: s.evidence.duplicates, chapters });

  const loadedThroughSeq = Math.max(s.loadedThroughSeq, options.throughSeq ?? 0);
  const clock = s.clock;
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    meta: { ...s.meta, ...(options.state !== undefined ? { state: options.state } : {}) },
    live,
    loadedThroughSeq,
    originMs: originOf(clock, s.meta.startedAt),
    span: {
      startTs: clockTs(clock, 0, s.meta.startedAt),
      endTs: clockTs(clock, clock.last, s.meta.startedAt),
      durationMs: clock.last,
    },
    turns,
    steps,
    chapters,
    entities,
    findings: [],
    gaps: gaps.sort(compareGaps),
    coverage: coverageOf(
      s.capabilities,
      chapters.some((chapter) => chapter.link === "inferred"),
      steps.filter((step) => step.provenance === "inferred").length,
    ),
    hidden: { byType: { ...s.hidden }, unreceived: Math.max(0, loadedThroughSeq - s.received) },
  };
}

export function foldRows(
  meta: TraceSessionSummary,
  rows: readonly TraceRow[],
  options: FinalizeOptions,
): TraceSession {
  return finalize(accumulateAll(createTraceState(meta), rows), options);
}
