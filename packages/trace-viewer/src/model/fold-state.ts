import type {
  AgentInterruptReason,
  ChangeUnit,
  EventStoreType,
  JevClientKind,
  NormalizedAgentEventType,
  TraceSessionSummary,
} from "@jevcode/contracts";

import { KIND_META } from "./registry.js";
import {
  stepStableId,
  type Actor,
  type Capability,
  type Gap,
  type GapKind,
  type Step,
  type StepId,
  type StepKind,
  type StepStatus,
  type TurnTrigger,
} from "./types.js";

// Internal fold state. Nothing here is exported from the model barrel.

/** Where a row lands on the display clock. */
export interface RowContext {
  seq: number;
  /** Source time: the payload ts of a clock row; origin + t for any other row. */
  sourceTs: string;
  /** Display clock: ms since the origin, never decreasing with seq. */
  t: number;
}

/**
 * The session clock (spec §6.5). Only agent_event and evidence_fact payload times move it; the
 * first of them is the origin. change_unit, decision, validation and jev_decision rows carry
 * pipeline processing times (in replay.db the replay run's wall clock, days after the source
 * times), so they inherit the current clock instead.
 */
export interface DisplayClock {
  /** Epoch ms of the first parseable clock-row time; NaN until one arrives. */
  origin: number;
  last: number;
}

export function createClock(): DisplayClock {
  return { origin: Number.NaN, last: 0 };
}

/** Advances the clock to a clock row's ts. A ts that goes backwards or does not parse keeps the last value. */
export function advanceClock(clock: DisplayClock, ts: string): number {
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return clock.last;
  if (Number.isNaN(clock.origin)) clock.origin = parsed;
  clock.last = Math.max(clock.last, parsed - clock.origin);
  return clock.last;
}

/** The ISO time of a clock offset, or the fallback while the clock has no origin. */
export function clockTs(clock: DisplayClock, t: number, fallback: string): string {
  return Number.isNaN(clock.origin) ? fallback : new Date(clock.origin + t).toISOString();
}

/** Step.startMs (R25): the parsed source time, else origin + t, else t while the clock has no
 *  origin. Never NaN. */
export function sourceMs(clock: DisplayClock, ctx: RowContext): number {
  const parsed = Date.parse(ctx.sourceTs);
  if (!Number.isNaN(parsed)) return parsed;
  return Number.isNaN(clock.origin) ? ctx.t : clock.origin + ctx.t;
}

export type CallFamily = "tool" | "command" | "test";

export interface StepDraft extends Step {
  /** A start whose completion has not arrived. */
  open: boolean;
  /** Start/complete family; null for point steps. */
  family: CallFamily | null;
  /** The row type that created the step: an agent event type, a fact type or an envelope type. */
  source: string;
  /** Headline text for lifecycle and guardrail steps (not public Step.text). */
  label: string | null;
}

/** A user message that may answer an open decision: the step holding it and its own seq. The step
 *  is the relaunch's instruction step when the message echoed its agent_started (spec §6.6). */
export interface PendingAnswer {
  step: StepDraft;
  seq: number;
}

export interface QueueEntry {
  step: StepDraft;
  /** A test_started folded into an enclosing command: its completion must not close the command. */
  nested: boolean;
}

export interface TerminalEvent {
  type: "agent_completed" | "agent_failed" | "agent_interrupted";
  reason?: AgentInterruptReason;
}

export interface TurnDraft {
  index: number;
  trigger: TurnTrigger;
  prompt: string;
  turnId: string | undefined;
  /** False for an implicit turn opened by rows that arrived before any agent_started. */
  started: boolean;
  startSeq: number;
  endSeq: number;
  startTs: string;
  endTs: string;
  tMs: number;
  endTMs: number;
  stepIds: StepId[];
  terminal: TerminalEvent | null;
  /** A decision row answered or delegated a decision in this turn. */
  decisionAnswered: boolean;
  /** The turn's instruction item (spec §6.6 "Instruction dedupe"): the step its agent_started
   *  opened, or the earlier user message that agent_started delivered; null for an implicit turn
   *  and for a relaunch that delivered a decision answer. */
  instruction: StepDraft | null;
  lastAgentEvent: NormalizedAgentEventType | null;
  /** Open starts, FIFO per `${family}\u0000${target}`. */
  readonly queues: Map<string, QueueEntry[]>;
  /** Latest command-like step per normalized command. */
  readonly commands: Map<string, StepDraft>;
  /** Latest edit step per path. */
  readonly edits: Map<string, StepDraft>;
}

export interface EvidenceState {
  /** path -> key of the latest non-duplicate git_hunk (diff.hash, else "added:removed"). */
  readonly lastHunkKey: Map<string, string>;
  /** edit step -> key of the git_hunk it holds. */
  readonly hunkKeyByStep: Map<StepId, string>;
  /** Edit steps made by a git_hunk identical to the path's previous one (duplicate_poll). */
  readonly duplicates: Set<StepId>;
  /** row factId -> seq; the first row with an id wins. */
  readonly factSeqById: Map<string, number>;
  /** fact or validation seq -> the step it joined. */
  readonly stepByEvidenceSeq: Map<number, StepDraft>;
  /** `${normalized command}\u0000${test_result ts}` -> the step holding that result. */
  readonly testRunByKey: Map<string, StepDraft>;
  /** validation id -> seq. */
  readonly validationSeqById: Map<string, number>;
}

export interface UnitEntry {
  /** The latest version. */
  unit: ChangeUnit;
  firstSeq: number;
  lastSeq: number;
  versions: number;
}

/** Scores and client kind of a unit's latest Pass A attention row (Chapter.triad, spec §6.6). */
export interface UnitAttention {
  importance: number;
  relevance: number;
  interruption: number;
  clientKind: JevClientKind;
}

export interface ChapterState {
  /** change unit id -> latest version, in first-seen order. */
  readonly units: Map<string, UnitEntry>;
  /** decision id -> its one decision step. */
  readonly decisionSteps: Map<string, StepDraft>;
  /** decision id -> affectedChangeUnits of its latest row. */
  readonly decisionUnits: Map<string, string[]>;
  /** change unit id -> guardrail and attention steps from jev_decision rows naming it. */
  readonly jevStepsByUnit: Map<string, StepDraft[]>;
  /** change unit id -> shouldSurface of its latest Pass A jev_decision row (Chapter.noise, R25). */
  readonly surfaceByUnit: Map<string, boolean>;
  /** change unit id -> its latest non-Pass-B row whose output parses with AttentionDecisionSchema
   *  (Chapter.triad, UI index §1.4 B-5). */
  readonly attentionByUnit: Map<string, UnitAttention>;
}

export class FoldState {
  loadedThroughSeq = 0;
  received = 0;
  maxSeq = 0;
  readonly seen = new Set<number>();
  readonly gaps: Gap[] = [];
  readonly hidden: Partial<Record<EventStoreType, number>> = {};
  readonly capabilities = new Set<Capability>();
  readonly clock: DisplayClock;
  readonly steps: StepDraft[] = [];
  readonly stepById = new Map<StepId, StepDraft>();
  /** Every step that carries a callId (open or closed). */
  readonly stepsByCallId = new Map<string, StepDraft>();
  /** The latest user message since the last decision row: a candidate decision answer (R25). */
  pendingAnswer: PendingAnswer | null = null;
  /** User instruction steps that no agent_started has delivered yet, oldest first (spec §6.6). */
  readonly undelivered: StepDraft[] = [];
  /** Trimmed text of an absorbed decision answer -> its decision step and title, for a relaunch
   *  that delivers the answer after the answer row (spec §6.6). */
  readonly answeredPrompts = new Map<string, { step: StepDraft; title: string }>();
  readonly turns: TurnDraft[] = [];
  readonly evidence: EvidenceState = {
    lastHunkKey: new Map(),
    hunkKeyByStep: new Map(),
    duplicates: new Set(),
    factSeqById: new Map(),
    stepByEvidenceSeq: new Map(),
    testRunByKey: new Map(),
    validationSeqById: new Map(),
  };
  readonly chapters: ChapterState = {
    units: new Map(),
    decisionSteps: new Map(),
    decisionUnits: new Map(),
    jevStepsByUnit: new Map(),
    surfaceByUnit: new Map(),
    attentionByUnit: new Map(),
  };

  constructor(readonly meta: TraceSessionSummary) {
    this.clock = createClock();
  }
}

export function addGap(state: FoldState, kind: GapKind, atSeq: number, message: string): void {
  state.gaps.push({ kind, atSeq, message });
}

function previousTrigger(previous: TurnDraft | undefined): TurnTrigger {
  if (previous === undefined) return "initial";
  const terminal = previous.terminal;
  // A turn that stopped on an answered decision resumes; one that just stopped was steered.
  if (terminal === null) return previous.decisionAnswered ? "resume" : "steer";
  if (terminal.type === "agent_interrupted" && terminal.reason === "steer") return "steer";
  return "resume";
}

export function openTurn(
  state: FoldState,
  ctx: RowContext,
  init: { started: boolean; prompt: string; turnId: string | undefined },
): TurnDraft {
  const turn: TurnDraft = {
    index: state.turns.length,
    trigger: previousTrigger(state.turns[state.turns.length - 1]),
    prompt: init.prompt,
    turnId: init.turnId,
    started: init.started,
    startSeq: ctx.seq,
    endSeq: ctx.seq,
    startTs: ctx.sourceTs,
    endTs: ctx.sourceTs,
    tMs: ctx.t,
    endTMs: ctx.t,
    stepIds: [],
    terminal: null,
    decisionAnswered: false,
    instruction: null,
    lastAgentEvent: null,
    queues: new Map(),
    commands: new Map(),
    edits: new Map(),
  };
  state.turns.push(turn);
  return turn;
}

/** The turn a row belongs to: the latest one, or an implicit first turn. */
export function currentTurn(state: FoldState, ctx: RowContext): TurnDraft {
  const last = state.turns[state.turns.length - 1];
  if (last !== undefined) return last;
  return openTurn(state, ctx, { started: false, prompt: state.meta.prompt, turnId: undefined });
}

export function touchTurn(turn: TurnDraft, ctx: RowContext): void {
  turn.endSeq = Math.max(turn.endSeq, ctx.seq);
  turn.endTs = ctx.sourceTs;
  turn.endTMs = Math.max(turn.endTMs, ctx.t);
}

export interface StepInit {
  kind: StepKind;
  source: string;
  status: StepStatus;
  actor?: Actor;
  target?: string;
  text?: string;
  callId?: string;
  label?: string;
  approxTime?: boolean;
}

export function createStep(state: FoldState, turn: TurnDraft, ctx: RowContext, init: StepInit): StepDraft {
  const meta = KIND_META[init.kind];
  const step: StepDraft = {
    id: stepStableId(ctx.seq),
    kind: init.kind,
    lane: meta.lane,
    actor: init.actor ?? meta.actor,
    provenance: "observed",
    status: init.status,
    headline: "",
    ...(init.target !== undefined ? { target: init.target } : {}),
    ...(init.text !== undefined ? { text: init.text } : {}),
    ...(init.callId !== undefined ? { callId: init.callId } : {}),
    turnIndex: turn.index,
    seqs: [ctx.seq],
    firstSeq: ctx.seq,
    lastSeq: ctx.seq,
    startTs: ctx.sourceTs,
    endTs: ctx.sourceTs,
    tMs: ctx.t,
    startMs: sourceMs(state.clock, ctx),
    endTMs: ctx.t,
    durationMs: null,
    approxTime: init.approxTime ?? false,
    evidenceSeqs: [],
    chapterIds: [],
    entityIds: [],
    findingIds: [],
    problems: [],
    noise: null,
    open: false,
    family: null,
    source: init.source,
    label: init.label ?? null,
  };
  state.steps.push(step);
  state.stepById.set(step.id, step);
  turn.stepIds.push(step.id);
  if (init.callId !== undefined) state.stepsByCallId.set(init.callId, step);
  return step;
}

/** Folds one more row into a step. Rows arrive in ascending seq, so seqs stay sorted. */
export function addRowToStep(step: StepDraft, ctx: RowContext, evidence: boolean): void {
  step.seqs.push(ctx.seq);
  step.lastSeq = Math.max(step.lastSeq, ctx.seq);
  if (evidence) step.evidenceSeqs.push(ctx.seq);
}

/** Changes a step's kind and moves it to that kind's lane. */
export function setKind(step: StepDraft, kind: StepKind): void {
  step.kind = kind;
  step.lane = KIND_META[kind].lane;
}

/** Drops a step from the fold: a user message absorbed into a decision step (R25). */
export function removeStep(state: FoldState, step: StepDraft): void {
  const index = state.steps.indexOf(step);
  if (index >= 0) state.steps.splice(index, 1);
  const queued = state.undelivered.indexOf(step);
  if (queued >= 0) state.undelivered.splice(queued, 1);
  state.stepById.delete(step.id);
  const turn = state.turns[step.turnIndex];
  if (turn !== undefined) turn.stepIds = turn.stepIds.filter((id) => id !== step.id);
}
