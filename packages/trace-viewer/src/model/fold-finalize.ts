import type { AgentState } from "@jevcode/contracts";

import { isTurnClosed, missingEvidence, noiseOf, ownsRunOutcome, problemsOf } from "./classify.js";
import { buildChapter } from "./fold-chapters.js";
import { buildEntity } from "./fold-evidence.js";
import { explainerModelOf } from "./fold-explainer.js";
import { overviewModelOf } from "./fold-overview.js";
import { clockTs, type DisplayClock, type FoldState, type StepDraft, type TurnDraft } from "./fold-state.js";
import { normalizeCommand, stepHeadline } from "./format.js";
import {
  buildSignalScan,
  computeCoverage,
  evaluateSignals,
  isPlanText,
  isSuccessClaim,
  turnMarks,
  type SignalIndex,
  type SignalScan,
} from "./signals.js";
import {
  TRACE_SCHEMA_VERSION,
  fileStableId,
  unitStableId,
  type Chapter,
  type Coverage,
  type Entity,
  type Finding,
  type FindingId,
  type Gap,
  type Step,
  type StepId,
  type StepStatus,
  type TraceSession,
  type Turn,
  type TurnOutcome,
  type UnitStableId,
} from "./types.js";

// The finalize (spec §6): the session a TraceState's rows fold to. It is incremental. The derived
// state below survives between calls on one TraceState, and a call re-derives only what the rows
// since the previous call can change: the steps they touched, the chapters whose joins they reach
// (by unit id, fact id, call id, validation id, decision id or edited path), and the session-wide
// fields those feed (step.chapterIds, the validation-only runs, noise, entities, gaps). Signals
// re-run over the steps each rule reads (buildSignalScan keeps each kept step's category), so a
// call reads the changed steps and the runs, edits, claims and guardrails, not every step. The result always deep-equals
// a fresh fold of the same rows (fold.incremental.test.ts), and:
//
// - Nothing a finalize returned is mutated later.
// - Between two calls with the same `live`, a Step, Chapter, Entity, Turn or Finding whose value did
//   not change is the same object, and so is a top-level list (steps, chapters, entities, turns,
//   findings, gaps) none of whose items changed; coverage, meta, span and hidden likewise. A change
//   of `live` or of the clock origin (the first clock row) re-derives everything, with new objects.

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

// ------------------------------------------------------------ public objects

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
  const status = draft.open ? openStatus : settledStatus(draft);
  // An unpaired start, or a decision still open (spec §6.6 Status), has no end yet.
  const unfinished = draft.open || status === "running";
  const step: Step = {
    id: draft.id,
    kind: draft.kind,
    lane: draft.lane,
    actor: draft.actor,
    provenance: draft.provenance,
    status,
    headline: headlineOf(draft),
    ...(draft.target !== undefined ? { target: draft.target } : {}),
    ...(draft.text !== undefined ? { text: draft.text } : {}),
    ...(draft.callId !== undefined ? { callId: draft.callId } : {}),
    turnIndex: draft.turnIndex,
    seqs: [...draft.seqs],
    firstSeq: draft.firstSeq,
    lastSeq: draft.lastSeq,
    startTs: draft.startTs,
    endTs: unfinished ? null : draft.endTs,
    tMs: draft.tMs,
    startMs: draft.startMs,
    endTMs: unfinished ? null : draft.endTMs,
    durationMs: unfinished ? null : draft.durationMs,
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

/** Structural equality of plain data (the session's objects, arrays and primitives). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) if (!sameValue(a[index], b[index])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}

/** The earlier object when it holds the same value (identity for unchanged items). */
function keep<T>(previous: T | undefined, next: T): T {
  return previous !== undefined && sameValue(previous, next) ? previous : next;
}

// ------------------------------------------------------------ sorted index lists

/** First position with list[i] >= value. */
function lowerBound(list: readonly number[], value: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] ?? 0) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function insertSorted(list: number[], value: number): number {
  const last = list[list.length - 1];
  if (last === undefined || last < value) return list.push(value) - 1;
  const at = lowerBound(list, value);
  list.splice(at, 0, value);
  return at;
}

/** Removes one occurrence; the position it had, or -1. */
function removeSorted(list: number[], value: number): number {
  const at = lowerBound(list, value);
  if (list[at] !== value) return -1;
  list.splice(at, 1);
  return at;
}

function addToIndex<K, V>(index: Map<K, Set<V>>, key: K, value: V): void {
  const set = index.get(key);
  if (set === undefined) index.set(key, new Set([value]));
  else set.add(value);
}

// ------------------------------------------------------------ derived state

const EMPTY_IDS: readonly never[] = [];

interface StepRecord {
  readonly draft: StepDraft;
  /** Position in FoldState.steps. */
  pos: number;
  /** toPublicStep of the draft, durationMs set for a live running step; no session-wide fields. */
  base: Step;
  /** base with chapterIds, entityIds, problems, the missing-evidence status and noise: what the
   *  signals read. */
  pre: Step;
  /** pre with the findings applied: the step the session holds. */
  out: Step;
  /** Sorted positions of the chapters that join this step (mutated in place, never emitted). */
  readonly chapterIdx: number[];
  /** chapterIdx as ids. Emitted, so replaced rather than mutated once a session holds it. */
  chapterIds: UnitStableId[];
  /** chapterIds was made in this finalize and no session holds it yet. */
  chapterIdsOwned: boolean;
  /** Current chapters that join this step (validation-only runs, spec §6.6). */
  currentCount: number;
  /** unpaired and missing_evidence gaps of this step. */
  gaps: readonly Gap[];
  /** kind and failures of a test or check run: what validationOnlyStepIds and ownsRunOutcome read. */
  runSig: string;
  /** normalizeCommand(target) of a test or check run with a target. */
  runKey: string | null;
  /** isPlanText / isSuccessClaim of text, for the text they were computed from. */
  marks: { text: string; plan: boolean; claim: boolean } | null;
  /** pre.provenance is inferred and counted in Derived.inferredSteps. */
  inferred: boolean;
}

interface ChapterRecord {
  readonly index: number;
  readonly unitId: string;
  readonly id: UnitStableId;
  /** buildChapter: no validation-only runs, no findings. */
  base: Chapter;
  /** base with validationOnlyStepIds: what the signals read. */
  pre: Chapter;
  /** pre with the findings applied. */
  out: Chapter;
  /** The unit's agentCallIds when unitsByCallId last took them. */
  indexedCallIds: readonly string[];
}

/** A turn's plan and claim marks (turnMarks, signals.ts) over a prefix of its steps, and whether that prefix holds
 *  an edit: enough to extend the marks over steps appended later. */
interface TurnMarkState {
  marks: Pick<Turn, "planStepId" | "claimStepId">;
  hasEdit: boolean;
}

interface TurnRecord {
  isLast: boolean;
  closed: boolean;
  /** turn.stepIds and its length when stepIds and marks were taken. */
  stepIdsRef: readonly StepId[];
  stepIdsLength: number;
  stepIds: StepId[];
  marks: TurnMarkState;
  out: Turn;
}

interface RunOwners {
  /** Sorted positions of the chapters that own the run's outcome. */
  readonly owners: number[];
  ids: UnitStableId[] | null;
}

/** Items the last finalize re-derived: the work an append costs (fold.incremental.test.ts). */
export interface FinalizeWork {
  /** Steps copied from their drafts (toPublicStep). */
  steps: number;
  /** Steps whose session-wide fields were re-derived. */
  stepFields: number;
  /** Chapters rebuilt from their unit (buildChapter). */
  chapters: number;
  /** Chapters whose validation-only runs were re-derived. */
  validationOnly: number;
  entities: number;
  /** Steps the signal rules categorized anew (buildSignalScan): the others kept their category. */
  signalSteps: number;
  /** Steps whose plan and claim marks were read (Turn.planStepId, claimStepId). */
  marks: number;
}

class Derived {
  work: FinalizeWork = { steps: 0, stepFields: 0, chapters: 0, validationOnly: 0, entities: 0, signalSteps: 0, marks: 0 };
  readonly steps = new Map<StepDraft, StepRecord>();
  readonly stepsById = new Map<StepId, StepRecord>();
  /** Records in FoldState.steps order. */
  order: StepRecord[] = [];
  readonly chapters: ChapterRecord[] = [];
  readonly chapterByUnit = new Map<string, ChapterRecord>();
  readonly chapterById = new Map<UnitStableId, ChapterRecord>();
  // Reverse indexes: a key -> the units whose chapter read it when last built. Never pruned: a stale
  // entry only rebuilds a chapter that did not need it. Fact, validation and decision ids change a
  // chapter only when they first resolve (FoldChanges), so only unresolved ones are indexed; a
  // call id can gain steps at any time.
  readonly unitsByFactId = new Map<string, Set<string>>();
  readonly unitsByCallId = new Map<string, Set<string>>();
  readonly unitsByValidationId = new Map<string, Set<string>>();
  readonly unitsByDecisionId = new Map<string, Set<string>>();
  /** path -> units whose chapter is inferred and lists the path (the D11 fallback reads its edits). */
  readonly inferredByFile = new Map<string, Set<string>>();
  /** path -> sorted chapter positions, once per listing of the path in chapter.files. */
  readonly chaptersByFile = new Map<string, number[]>();
  /** path -> its edit steps in seq order; editsNonDuplicate leaves out duplicate_poll steps. */
  readonly edits = new Map<string, StepDraft[]>();
  readonly editsNonDuplicate = new Map<string, StepDraft[]>();
  readonly entityPaths: string[] = [];
  readonly entityByPath = new Map<string, Entity>();
  /** normalized command -> its latest test or check run (passing_test noise). */
  readonly lastRuns = new Map<string, StepDraft>();
  readonly superseded = new Set<UnitStableId>();
  readonly runOwners = new Map<StepId, RunOwners>();
  readonly turns: TurnRecord[] = [];
  readonly preById = new Map<StepId, Step>();
  readonly preChapterById = new Map<UnitStableId, Chapter>();
  readonly withGaps = new Set<StepRecord>();
  /** Records whose base status is running: their durationMs follows nowMs. */
  readonly running = new Set<StepRecord>();
  readonly namedSteps = new Set<StepRecord>();
  readonly namedChapters = new Set<ChapterRecord>();
  readonly findingById = new Map<FindingId, Finding>();
  inferredChapters = 0;
  inferredSteps = 0;
  foldGaps = 0;
  nowMs: number | undefined = undefined;
  session: TraceSession | null = null;
  preSteps: Step[] = [];
  outSteps: Step[] = [];
  preChapters: Chapter[] = [];
  outChapters: Chapter[] = [];
  /** The rules' step positions for the previous preSteps: a kept Step keeps its category. */
  signalScan: SignalScan | undefined = undefined;

  constructor(
    readonly live: boolean,
    readonly origin: number,
  ) {}
}

function isRunKind(step: Step): boolean {
  return step.kind === "test" || step.kind === "check";
}

function runSigOf(step: Step): string {
  return isRunKind(step) ? `${step.kind}\u0000${JSON.stringify(step.tests?.failures ?? [])}` : "";
}

function isEditDraft(draft: StepDraft): boolean {
  return draft.kind === "edit" && draft.edit !== undefined;
}

/** True when a step's base or pre reads its turn's state: an open step (its status follows whether its turn is the
 *  running one, and it is unpaired once it is not) or a step whose evidence is missing once its turn is closed
 *  (missingEvidence reads only the base). Every other step is the same whatever its turn's state. */
function readsTurnState(record: StepRecord): boolean {
  return record.draft.open || missingEvidence(record.base) !== null;
}

// ------------------------------------------------------------ one finalize

class Finalizer {
  private readonly d: Derived;
  private readonly lastTurnIndex: number;
  /** Steps whose pre must be re-derived. */
  private readonly redo = new Set<StepRecord>();
  /** Units whose chapter must be rebuilt. */
  private readonly dirtyUnits = new Set<string>();
  /** Chapter positions whose validationOnlyStepIds must be re-derived. */
  private readonly voDirty = new Set<number>();
  private readonly entityDirty = new Set<string>();
  private readonly chaptersChanged = new Set<ChapterRecord>();
  private readonly stepsChanged = new Set<StepRecord>();
  /** Records whose chapterIds this finalize replaced. */
  private readonly ownedChapterIds: StepRecord[] = [];
  /** Turns whose planStepId/claimStepId must be re-derived though their step list did not change. */
  private readonly marksDirty = new Set<number>();
  /** An entity changed, appeared or left. */
  private entitiesChanged = false;
  private gapsChanged = false;
  /** A step was removed: positions shifted, so the step lists are rebuilt. */
  private reordered = false;

  constructor(
    private readonly s: FoldState,
    private readonly options: FinalizeOptions,
    derived: Derived,
    private readonly full: boolean,
  ) {
    this.d = derived;
    this.lastTurnIndex = s.turns.length - 1;
  }

  run(): TraceSession {
    const s = this.s;
    const d = this.d;
    d.work = { steps: 0, stepFields: 0, chapters: 0, validationOnly: 0, entities: 0, signalSteps: 0, marks: 0 };
    const live = this.options.live;
    const turnStates = this.turnStates();
    this.removeSteps();
    this.scanSteps(turnStates);
    this.collectDirtyUnits();
    this.rebuildChapters();
    this.rebuildValidationOnly();
    this.rebuildStepPre(turnStates);
    this.rebuildEntities();
    const turns = this.buildTurns(turnStates);
    const preSteps = this.listPreSteps();
    const preChapters = this.listPreChapters();
    const loadedThroughSeq = Math.max(s.loadedThroughSeq, this.options.throughSeq ?? 0);
    const clock = s.clock;
    const previous = d.session;
    const state = this.options.state;
    const meta = keep(previous?.meta, { ...s.meta, ...(state !== undefined ? { state } : {}) });
    const span = keep(previous?.span, {
      startTs: clockTs(clock, 0, s.meta.startedAt),
      endTs: clockTs(clock, clock.last, s.meta.startedAt),
      durationMs: clock.last,
    });
    const coverage = keep(
      previous?.coverage,
      computeCoverage(s.capabilities, d.inferredChapters > 0, d.inferredSteps),
    );
    const partial = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      meta,
      live,
      loadedThroughSeq,
      originMs: originOf(clock, s.meta.startedAt),
      span,
      turns,
      steps: preSteps,
      chapters: preChapters,
      entities: this.listEntities(),
      gaps: this.listGaps(),
      hidden: keep(previous?.hidden, {
        byType: { ...s.hidden },
        unreceived: Math.max(0, loadedThroughSeq - s.received),
      }),
      overview: overviewModelOf(s.overview, previous?.overview ?? null),
      explainer: explainerModelOf(s.explainer),
    };
    const findings = this.findings(partial, coverage);
    const session: TraceSession = {
      ...partial,
      steps: this.listOutSteps(),
      chapters: this.listOutChapters(),
      findings,
      coverage,
    };
    for (const record of this.ownedChapterIds) record.chapterIdsOwned = false;
    d.session = session;
    d.nowMs = this.options.nowMs;
    const changes = s.changes;
    changes.units.clear();
    changes.callIds.clear();
    changes.factIds.clear();
    changes.validationIds.clear();
    changes.decisionIds.clear();
    changes.removedSteps.length = 0;
    return session;
  }

  // -------------------------------------------------- turns

  private turnStates(): { isLast: boolean; closed: boolean; outcome: Pick<Turn, "outcome" | "interruptReason"> }[] {
    const live = this.options.live;
    return this.s.turns.map((turn) => {
      const isLast = turn.index === this.lastTurnIndex;
      const outcome = outcomeOf(turn, isLast, live);
      const closed = isTurnClosed({ index: turn.index, outcome: outcome.outcome } as Turn, this.lastTurnIndex, live);
      return { isLast, closed, outcome };
    });
  }

  private buildTurns(states: ReturnType<Finalizer["turnStates"]>): Turn[] {
    const d = this.d;
    const previous = d.session?.turns;
    let changed = previous === undefined || previous.length !== this.s.turns.length;
    const turns = this.s.turns.map((turn, index) => {
      const state = states[index] ?? { isLast: false, closed: true, outcome: { outcome: "unknown" as const } };
      const previousRecord = d.turns[index];
      const same = previousRecord !== undefined && previousRecord.stepIdsRef === turn.stepIds ? previousRecord : undefined;
      const sameSteps = same !== undefined && same.stepIdsLength === turn.stepIds.length;
      const stepIds = sameSteps ? same.stepIds : [...turn.stepIds];
      // Steps are only appended to a turn between removals, which replace turn.stepIds; an appended step never
      // changes the marks of the steps before it, so only the appended ones are read (PL-3). A turn whose first
      // edit became a test run (marksDirty) is read again in full.
      let marks: TurnMarkState;
      if (same !== undefined && !this.marksDirty.has(index)) {
        marks = sameSteps ? same.marks : this.turnMarksOf(turn.stepIds, same.marks, same.stepIdsLength);
      } else {
        marks = this.turnMarksOf(turn.stepIds);
      }
      const out: Turn = {
        index: turn.index,
        trigger: turn.trigger,
        prompt: turn.prompt,
        ...state.outcome,
        ...(turn.turnId !== undefined ? { turnId: turn.turnId } : {}),
        startSeq: turn.startSeq,
        endSeq: turn.endSeq,
        startTs: turn.startTs,
        endTs: turn.endTs,
        tMs: turn.tMs,
        endTMs: turn.endTMs,
        stepIds,
        ...marks.marks,
      };
      const kept = keep(previousRecord?.out, out);
      if (kept !== previous?.[index]) changed = true;
      const record: TurnRecord = {
        isLast: state.isLast,
        closed: state.closed,
        stepIdsRef: turn.stepIds,
        stepIdsLength: turn.stepIds.length,
        stepIds: kept.stepIds,
        marks,
        out: kept,
      };
      d.turns[index] = record;
      return kept;
    });
    d.turns.length = this.s.turns.length;
    return changed || previous === undefined ? turns : previous;
  }

  /** The marks of a turn's steps; with `previous`, the marks of its first `from` steps extended over the rest. */
  private turnMarksOf(stepIds: readonly StepId[], previous?: TurnMarkState, from = 0): TurnMarkState {
    const records: StepRecord[] = [];
    for (let index = previous === undefined ? 0 : from; index < stepIds.length; index += 1) {
      const record = this.d.stepsById.get(stepIds[index] as StepId);
      if (record !== undefined) records.push(record);
    }
    this.d.work.marks += records.length;
    const marksOf = (step: Step): { plan: boolean; claim: boolean } => {
      const record = this.d.stepsById.get(step.id);
      const text = step.text ?? "";
      if (record === undefined) return { plan: isPlanText(text), claim: isSuccessClaim(text) };
      if (record.marks === null || record.marks.text !== text) {
        record.marks = { text, plan: isPlanText(text), claim: isSuccessClaim(text) };
      }
      return record.marks;
    };
    const steps = records.map((record) => record.base);
    const own = turnMarks(
      steps,
      (step) => marksOf(step).plan,
      (step) => marksOf(step).claim,
    );
    const hasEdit = (previous?.hasEdit ?? false) || steps.some((step) => step.kind === "edit");
    if (previous === undefined) return { marks: own, hasEdit };
    // The appended steps come after every earlier one (seq order). An earlier plan stays the first plan, an earlier
    // edit keeps every appended message from being one, and an appended claim is later than any earlier claim.
    const marks: Pick<Turn, "planStepId" | "claimStepId"> = {};
    const plan = previous.marks.planStepId ?? (previous.hasEdit ? undefined : own.planStepId);
    const claim = own.claimStepId ?? previous.marks.claimStepId;
    if (plan !== undefined) marks.planStepId = plan;
    if (claim !== undefined) marks.claimStepId = claim;
    return { marks, hasEdit };
  }

  // -------------------------------------------------- steps

  /** Drops removed steps (a decision's absorbed answer message; see removalReaches). */
  private removeSteps(): void {
    const d = this.d;
    const removed = this.s.changes.removedSteps;
    if (removed.length === 0) return;
    for (const draft of removed) {
      const record = d.steps.get(draft);
      if (record === undefined) continue;
      d.steps.delete(draft);
      d.stepsById.delete(draft.id);
      d.preById.delete(draft.id);
      d.running.delete(record);
      if (d.withGaps.delete(record)) this.gapsChanged = true;
      d.namedSteps.delete(record);
      if (record.inferred) d.inferredSteps -= 1;
    }
    this.reordered = true;
  }

  /** Records new steps and re-derives the base of each step a row touched, of each running step
   *  when the clock moved, and of each step of a turn that closed or stopped being the last. */
  private scanSteps(turnStates: ReturnType<Finalizer["turnStates"]>): void {
    const d = this.d;
    const s = this.s;
    const live = this.options.live;
    const runningOf = (draft: StepDraft): boolean => live && draft.turnIndex === this.lastTurnIndex;
    const created = new Set<StepRecord>();
    if (this.reordered) {
      // A removal shifted positions: walk every step.
      d.order = [];
      s.steps.forEach((draft, pos) => {
        const record = d.steps.get(draft);
        if (record === undefined) {
          created.add(this.addRecord(draft, pos, runningOf(draft)));
        } else {
          record.pos = pos;
          d.order[pos] = record;
        }
      });
    } else {
      // Steps are only appended between removals.
      for (let pos = d.order.length; pos < s.steps.length; pos += 1) {
        const draft = s.steps[pos];
        if (draft !== undefined) created.add(this.addRecord(draft, pos, runningOf(draft)));
      }
    }
    const rebase = (record: StepRecord | undefined): void => {
      if (record !== undefined && !created.has(record)) this.rebase(record, runningOf(record.draft));
    };
    for (const draft of s.touchedSteps) rebase(d.steps.get(draft));
    if (live && this.options.nowMs !== d.nowMs) for (const record of [...d.running]) rebase(record);
    s.turns.forEach((turn, index) => {
      const state = turnStates[index];
      const record = d.turns[index];
      if (state === undefined) return;
      if (record !== undefined && record.isLast === state.isLast && record.closed === state.closed) return;
      // A turn that became closed or stopped being the last one changes its open steps (status and unpaired gap)
      // and its steps' missing evidence, even when their base did not change. No other step reads the turn's
      // state, so a turn end re-derives those steps only, not every step of the turn (PL-3).
      for (const id of turn.stepIds) {
        const step = d.stepsById.get(id);
        if (step === undefined || !readsTurnState(step)) continue;
        if (step.draft.open) rebase(step);
        this.redo.add(step);
      }
    });
    for (const draft of s.touchedSteps) draft.dirty = false;
    s.touchedSteps.length = 0;
  }

  private baseOf(draft: StepDraft, running: boolean): Step {
    this.d.work.steps += 1;
    const base = toPublicStep(draft, running ? "running" : "unknown");
    const nowMs = this.options.nowMs;
    // spec §6.5: an open step at the live edge lasts until now.
    if (this.options.live && nowMs !== undefined && base.status === "running") {
      base.durationMs = Math.max(0, nowMs - base.startMs);
    }
    return base;
  }

  private addRecord(draft: StepDraft, pos: number, running: boolean): StepRecord {
    const d = this.d;
    const base = this.baseOf(draft, running);
    const record: StepRecord = {
      draft,
      pos,
      base,
      // Set by rebuildStepPre and applyFindings in this finalize.
      pre: undefined as unknown as Step,
      out: undefined as unknown as Step,
      chapterIdx: [],
      chapterIds: [],
      chapterIdsOwned: true,
      currentCount: 0,
      gaps: EMPTY_IDS,
      runSig: runSigOf(base),
      runKey: null,
      marks: null,
      inferred: false,
    };
    this.ownedChapterIds.push(record);
    if (base.status === "running") d.running.add(record);
    d.steps.set(draft, record);
    d.stepsById.set(draft.id, record);
    d.order[pos] = record;
    this.redo.add(record);
    this.trackRun(record);
    if (isEditDraft(draft) && draft.edit !== undefined) {
      const path = draft.edit.path;
      const edits = d.edits.get(path);
      if (edits === undefined) {
        d.edits.set(path, [draft]);
        d.entityPaths.push(path);
        this.entitiesChanged = true;
      } else {
        edits.push(draft);
      }
      if (!this.s.evidence.duplicates.has(draft.id)) {
        const nonDuplicate = d.editsNonDuplicate.get(path);
        if (nonDuplicate === undefined) d.editsNonDuplicate.set(path, [draft]);
        else nonDuplicate.push(draft);
      }
      this.editTouched(record);
    }
    return record;
  }

  /** Re-derives a known step's base; when it changed, everything that reads it. */
  private rebase(record: StepRecord, running: boolean): void {
    const base = this.baseOf(record.draft, running);
    if (sameValue(base, record.base)) return;
    const wasEdit = record.base.kind === "edit" && record.base.edit !== undefined;
    record.base = base;
    if (base.status === "running") this.d.running.add(record);
    else this.d.running.delete(record);
    this.redo.add(record);
    const runSig = runSigOf(base);
    if (runSig !== record.runSig) {
      record.runSig = runSig;
      this.d.runOwners.delete(base.id);
      for (const index of record.chapterIdx) this.voDirty.add(index);
    }
    this.trackRun(record);
    if (isEditDraft(record.draft)) this.editTouched(record);
    else if (wasEdit) this.leaveEdits(record);
    else if (record.draft.edit !== undefined) {
      // An edit that became a test run keeps its edit, and later hunks on its path still change it;
      // isNoiseChapter reads the edit whatever the step's kind.
      for (const index of record.chapterIdx) {
        const chapter = this.d.chapters[index];
        if (chapter !== undefined) this.dirtyUnits.add(chapter.unitId);
      }
    }
  }

  /** An edit step that a test_result joined through its call id became a test run: it leaves its
   *  path's edits, and entities keep the order of each path's first remaining edit step. */
  private leaveEdits(record: StepRecord): void {
    const d = this.d;
    const path = record.draft.edit?.path;
    if (path === undefined) return;
    this.editTouched(record);
    // The turn's first edit (Turn.planStepId) may have been this step.
    this.marksDirty.add(record.draft.turnIndex);
    const without = (list: StepDraft[] | undefined): StepDraft[] => (list ?? []).filter((draft) => draft !== record.draft);
    d.editsNonDuplicate.set(path, without(d.editsNonDuplicate.get(path)));
    const edits = without(d.edits.get(path));
    if (edits.length > 0) d.edits.set(path, edits);
    else {
      d.edits.delete(path);
      d.entityByPath.delete(path);
    }
    const firstSeq = (candidate: string): number => d.edits.get(candidate)?.[0]?.firstSeq ?? 0;
    const order = d.entityPaths.filter((candidate) => d.edits.has(candidate)).sort((a, b) => firstSeq(a) - firstSeq(b));
    d.entityPaths.length = 0;
    d.entityPaths.push(...order);
    this.entitiesChanged = true;
  }

  /** Keeps lastRuns: a step becomes its command's latest run when it is a run with a later firstSeq. */
  private trackRun(record: StepRecord): void {
    const base = record.base;
    if (!isRunKind(base) || base.target === undefined) return;
    record.runKey ??= normalizeCommand(base.target);
    const d = this.d;
    const current = d.lastRuns.get(record.runKey);
    if (current === record.draft || (current !== undefined && current.firstSeq >= record.draft.firstSeq)) return;
    d.lastRuns.set(record.runKey, record.draft);
    const previous = current === undefined ? undefined : d.steps.get(current);
    if (previous !== undefined) this.redo.add(previous);
    this.redo.add(record);
  }

  /** An edit step changed: its entity, the chapters joining it (noise) and the inferred chapters on
   *  its path (the D11 fallback reads its start and evidence). */
  private editTouched(record: StepRecord): void {
    const path = record.draft.edit?.path;
    if (path === undefined) return;
    this.entityDirty.add(path);
    for (const index of record.chapterIdx) {
      const chapter = this.d.chapters[index];
      if (chapter !== undefined) this.dirtyUnits.add(chapter.unitId);
    }
    for (const unitId of this.d.inferredByFile.get(path) ?? []) this.dirtyUnits.add(unitId);
  }

  // -------------------------------------------------- chapters

  private collectDirtyUnits(): void {
    const d = this.d;
    const changes = this.s.changes;
    const units = this.s.chapters.units;
    if (this.full) {
      for (const unitId of units.keys()) this.dirtyUnits.add(unitId);
      return;
    }
    for (const unitId of changes.units) this.dirtyUnits.add(unitId);
    const add = (index: Map<string, Set<string>>, keys: Iterable<string>): void => {
      for (const key of keys) for (const unitId of index.get(key) ?? []) this.dirtyUnits.add(unitId);
    };
    add(d.unitsByFactId, changes.factIds);
    add(d.unitsByCallId, changes.callIds);
    add(d.unitsByValidationId, changes.validationIds);
    add(d.unitsByDecisionId, changes.decisionIds);
  }

  private rebuildChapters(): void {
    const d = this.d;
    const units = this.s.chapters.units;
    const known: ChapterRecord[] = [];
    const added: string[] = [];
    for (const unitId of this.dirtyUnits) {
      if (!units.has(unitId)) continue;
      const record = d.chapterByUnit.get(unitId);
      if (record === undefined) added.push(unitId);
      else known.push(record);
    }
    // Chapters are in units order: first-seen seq, which is unique per unit.
    added.sort((a, b) => (units.get(a)?.firstSeq ?? 0) - (units.get(b)?.firstSeq ?? 0));
    for (const unitId of added) {
      const record: ChapterRecord = {
        index: d.chapters.length,
        unitId,
        id: unitStableId(unitId),
        base: undefined as unknown as Chapter,
        pre: undefined as unknown as Chapter,
        out: undefined as unknown as Chapter,
        indexedCallIds: [],
      };
      d.chapters.push(record);
      d.chapterByUnit.set(unitId, record);
      d.chapterById.set(record.id, record);
      known.push(record);
    }
    known.sort((a, b) => a.index - b.index);
    for (const record of known) {
      const entry = units.get(record.unitId);
      if (entry === undefined) continue;
      d.work.chapters += 1;
      this.rebuildChapter(record, buildChapter(this.s, entry, d.editsNonDuplicate));
    }
  }

  private rebuildChapter(record: ChapterRecord, base: Chapter): void {
    const d = this.d;
    const old = record.base as Chapter | undefined;
    // Indexed before the equality check below, so the index never depends on which unit fields the
    // chapter happens to carry.
    const unit = this.s.chapters.units.get(record.unitId)?.unit;
    if (unit !== undefined) {
      const evidence = this.s.evidence;
      for (const evidenceId of unit.evidence) {
        if (evidenceId.startsWith("fact_") && !evidence.factSeqById.has(evidenceId)) {
          addToIndex(d.unitsByFactId, evidenceId, unit.id);
        }
      }
      for (const validationId of unit.validationResults) {
        if (!evidence.validationSeqById.has(validationId)) addToIndex(d.unitsByValidationId, validationId, unit.id);
      }
      for (const decisionId of unit.relatedDecisions) {
        if (!this.s.chapters.decisionSteps.has(decisionId)) addToIndex(d.unitsByDecisionId, decisionId, unit.id);
      }
      const callIds = unit.agentCallIds ?? [];
      if (!sameValue(callIds, record.indexedCallIds)) {
        for (const callId of callIds) addToIndex(d.unitsByCallId, callId, unit.id);
        record.indexedCallIds = callIds;
      }
    }
    if (old !== undefined && sameValue(old, base)) return;
    record.base = base;
    this.chaptersChanged.add(record);
    this.voDirty.add(record.index);
    const wasInferred = old?.link === "inferred";
    const isInferred = base.link === "inferred";
    if (wasInferred) for (const file of old.files) d.inferredByFile.get(file)?.delete(record.unitId);
    if (isInferred) for (const file of base.files) addToIndex(d.inferredByFile, file, record.unitId);
    d.inferredChapters += (isInferred ? 1 : 0) - (wasInferred ? 1 : 0);
    const wasSuperseded = old?.status === "superseded";
    const isSuperseded = base.status === "superseded";
    if (isSuperseded) d.superseded.add(record.id);
    else d.superseded.delete(record.id);

    // step.chapterIds and the current-chapter counts behind validationOnlyStepIds.
    const ownershipChanged =
      old !== undefined && (old.status !== base.status || !sameValue(old.files, base.files));
    if (old === undefined || (old.current === base.current && sameValue(old.stepIds, base.stepIds))) {
      for (const stepId of base.stepIds) {
        const step = d.stepsById.get(stepId);
        if (step === undefined) continue;
        if (old === undefined) {
          const shared = step.currentCount > 1;
          this.link(step, record);
          if (base.current) step.currentCount += 1;
          this.sharedFlip(step, shared);
          continue;
        }
        // No superseded flip reaches here: current is status !== "superseded", so a flip changes
        // current and goes through relink, which redoes the steps.
        if (ownershipChanged) this.recheckOwner(step, record);
      }
    } else {
      this.relink(record, old, base, wasSuperseded !== isSuperseded, ownershipChanged);
    }
    this.refile(record, old, base);
  }

  /** Moves step.chapterIds and the current counts from a chapter's old joins to its new ones. */
  private relink(
    record: ChapterRecord,
    old: Chapter,
    base: Chapter,
    supersededFlip: boolean,
    ownershipChanged: boolean,
  ): void {
    const d = this.d;
    const oldSteps = new Set<StepId>(old.stepIds);
    const newSteps = new Set<StepId>(base.stepIds);
    const oldCurrent = old.current;
    const isSuperseded = base.status === "superseded";
    const wasSuperseded = isSuperseded !== supersededFlip;
    for (const stepId of oldSteps) {
      const step = d.stepsById.get(stepId);
      if (step === undefined) continue;
      const shared = step.currentCount > 1;
      if (!newSteps.has(stepId)) {
        this.unlink(step, record);
        if (oldCurrent) step.currentCount -= 1;
      } else if (oldCurrent !== base.current) {
        step.currentCount += base.current ? 1 : -1;
      }
      if (wasSuperseded !== isSuperseded) this.redo.add(step);
      if (ownershipChanged && newSteps.has(stepId)) this.recheckOwner(step, record);
      this.sharedFlip(step, shared);
    }
    for (const stepId of newSteps) {
      if (oldSteps.has(stepId)) continue;
      const step = d.stepsById.get(stepId);
      if (step === undefined) continue;
      const shared = step.currentCount > 1;
      this.link(step, record);
      if (base.current) step.currentCount += 1;
      this.sharedFlip(step, shared);
    }

  }

  /** Entity.chapterIds: once per listing of a path in files. */
  private refile(record: ChapterRecord, old: Chapter | undefined, base: Chapter): void {
    const d = this.d;
    if (old === undefined || !sameValue(old.files, base.files)) {
      for (const file of old?.files ?? []) {
        const list = d.chaptersByFile.get(file);
        if (list !== undefined) removeSorted(list, record.index);
        this.entityDirty.add(file);
      }
      for (const file of base.files) {
        let list = d.chaptersByFile.get(file);
        if (list === undefined) d.chaptersByFile.set(file, (list = []));
        list.splice(lowerBound(list, record.index + 1), 0, record.index);
        this.entityDirty.add(file);
      }
    }
  }

  private sharedFlip(step: StepRecord, sharedBefore: boolean): void {
    if (step.currentCount > 1 === sharedBefore) return;
    for (const index of step.chapterIdx) this.voDirty.add(index);
  }

  private ownChapterIds(step: StepRecord): UnitStableId[] {
    if (!step.chapterIdsOwned) {
      step.chapterIds = step.chapterIds.slice();
      step.chapterIdsOwned = true;
      this.ownedChapterIds.push(step);
    }
    return step.chapterIds;
  }

  private link(step: StepRecord, chapter: ChapterRecord): void {
    const at = insertSorted(step.chapterIdx, chapter.index);
    this.ownChapterIds(step).splice(at, 0, chapter.id);
    this.redo.add(step);
    const owners = this.d.runOwners.get(step.draft.id);
    if (owners !== undefined && ownsRunOutcome(chapter.base, step.base)) {
      insertSorted(owners.owners, chapter.index);
      owners.ids = null;
    }
  }

  private unlink(step: StepRecord, chapter: ChapterRecord): void {
    const at = removeSorted(step.chapterIdx, chapter.index);
    if (at >= 0) this.ownChapterIds(step).splice(at, 1);
    this.redo.add(step);
    const owners = this.d.runOwners.get(step.draft.id);
    if (owners !== undefined && removeSorted(owners.owners, chapter.index) >= 0) owners.ids = null;
  }

  private recheckOwner(step: StepRecord, chapter: ChapterRecord): void {
    const owners = this.d.runOwners.get(step.draft.id);
    if (owners === undefined) return;
    const owns = ownsRunOutcome(chapter.base, step.base);
    const at = lowerBound(owners.owners, chapter.index);
    const listed = owners.owners[at] === chapter.index;
    if (owns === listed) return;
    if (owns) owners.owners.splice(at, 0, chapter.index);
    else owners.owners.splice(at, 1);
    owners.ids = null;
  }

  /** runChapters (signals.ts) from the maintained owner positions. */
  private runChapters(run: Step): UnitStableId[] {
    const d = this.d;
    const record = d.stepsById.get(run.id);
    if (record === undefined) return [];
    let owners = d.runOwners.get(run.id);
    if (owners === undefined) {
      owners = { owners: [], ids: null };
      for (const index of record.chapterIdx) {
        const chapter = d.chapters[index];
        if (chapter !== undefined && ownsRunOutcome(chapter.base, record.base)) owners.owners.push(index);
      }
      d.runOwners.set(run.id, owners);
    }
    if (owners.owners.length > 0) {
      owners.ids ??= owners.owners.map((index) => d.chapters[index]?.id ?? unitStableId(""));
      return owners.ids;
    }
    const latest = record.chapterIds[record.chapterIds.length - 1];
    return latest === undefined ? [] : [latest];
  }

  /** A test or check run that several current chapters join belongs only to the chapters that own
   *  its outcome; for the rest it is validation-only, and the overview band footprint skips it
   *  (spec §6.6, §7.6.1). */
  private rebuildValidationOnly(): void {
    const d = this.d;
    for (const index of this.voDirty) {
      const record = d.chapters[index];
      if (record === undefined || (record.base as Chapter | undefined) === undefined) continue;
      d.work.validationOnly += 1;
      const base = record.base;
      const validationOnly = base.stepIds.filter((stepId) => {
        const step = d.stepsById.get(stepId);
        if (step === undefined || !isRunKind(step.base)) return false;
        return step.currentCount > 1 && !ownsRunOutcome(base, step.base);
      });
      const pre = keep(record.pre as Chapter | undefined, { ...base, validationOnlyStepIds: validationOnly });
      if (pre === record.pre) continue;
      record.pre = pre;
      d.preChapterById.set(record.id, pre);
      this.chaptersChanged.add(record);
    }
  }

  // -------------------------------------------------- step pre

  private rebuildStepPre(turnStates: ReturnType<Finalizer["turnStates"]>): void {
    const d = this.d;
    const duplicates = this.s.evidence.duplicates;
    const live = this.options.live;
    for (const record of this.redo) {
      if (!d.steps.has(record.draft)) continue;
      d.work.stepFields += 1;
      const base = record.base;
      const draft = record.draft;
      const running = live && draft.turnIndex === this.lastTurnIndex;
      const gaps: Gap[] = [];
      if (draft.open && !running) {
        const message = `${draft.target ?? draft.kind} started but never finished`;
        gaps.push({ kind: "unpaired", atSeq: draft.firstSeq, message });
      }
      const closed = turnStates[draft.turnIndex]?.closed ?? true;
      const missing = closed ? missingEvidence(base) : null;
      if (missing !== null) gaps.push(missing.gap);
      if (!sameValue(gaps, record.gaps)) {
        record.gaps = gaps.length === 0 ? EMPTY_IDS : gaps;
        if (gaps.length > 0) d.withGaps.add(record);
        else d.withGaps.delete(record);
        this.gapsChanged = true;
      }
      // Rule problems read the step before claim_contradicted; noise runs after problems (R10).
      const problems = problemsOf(base);
      const status = missing?.unknownStatus === true ? "unknown" : base.status;
      const decorated: Step = {
        ...base,
        status,
        chapterIds: record.chapterIds,
        entityIds: isEditDraft(draft) && base.edit !== undefined ? [fileStableId(base.edit.path)] : [],
        problems,
      };
      decorated.noise = problems.length > 0 ? null : noiseOf(decorated, { duplicates }, d.lastRuns, d.superseded);
      const pre = keep(record.pre as Step | undefined, decorated);
      if (pre === record.pre) continue;
      const inferred = pre.provenance === "inferred";
      d.inferredSteps += (inferred ? 1 : 0) - (record.inferred ? 1 : 0);
      record.inferred = inferred;
      record.pre = pre;
      d.preById.set(pre.id, pre);
      this.stepsChanged.add(record);
    }
  }

  // -------------------------------------------------- entities

  private rebuildEntities(): void {
    const d = this.d;
    const duplicates = this.s.evidence.duplicates;
    for (const path of this.entityDirty) {
      const edits = d.edits.get(path);
      if (edits === undefined || edits.length === 0) continue;
      d.work.entities += 1;
      const chapterIds = (d.chaptersByFile.get(path) ?? []).map((index) => d.chapters[index]?.id ?? unitStableId(""));
      const previous = d.entityByPath.get(path);
      const entity = keep(previous, buildEntity(path, edits, duplicates, chapterIds));
      if (entity === previous) continue;
      d.entityByPath.set(path, entity);
      this.entitiesChanged = true;
    }
  }

  private listEntities(): Entity[] {
    const d = this.d;
    const previous = d.session?.entities;
    if (previous !== undefined && !this.entitiesChanged) return previous;
    const entities: Entity[] = [];
    let changed = previous === undefined || previous.length !== d.entityPaths.length;
    d.entityPaths.forEach((path, index) => {
      const entity = d.entityByPath.get(path);
      if (entity === undefined) return;
      if (entity !== previous?.[index]) changed = true;
      entities.push(entity);
    });
    return changed || previous === undefined ? entities : previous;
  }

  // -------------------------------------------------- lists

  /** The list with the changed records' items replaced and the new records' items appended; the
   *  previous list when nothing changed. Records are in list order and new ones come last. */
  private patchList<R, T>(
    previous: T[],
    records: readonly R[],
    changed: ReadonlySet<R>,
    rebuild: boolean,
    positionOf: (record: R) => number,
    itemOf: (record: R) => T,
  ): T[] {
    if (rebuild) return records.map(itemOf);
    let list = previous;
    for (const record of changed) {
      const position = positionOf(record);
      if (position >= previous.length || list[position] === itemOf(record)) continue;
      if (list === previous) list = previous.slice();
      list[position] = itemOf(record);
    }
    if (records.length > previous.length) {
      if (list === previous) list = previous.slice();
      for (let position = previous.length; position < records.length; position += 1) {
        const record = records[position];
        if (record !== undefined) list.push(itemOf(record));
      }
    }
    return list;
  }

  private listPreSteps(): Step[] {
    const d = this.d;
    d.preSteps = this.patchList(d.preSteps, d.order, this.stepsChanged, this.reordered, (r) => r.pos, (r) => r.pre);
    return d.preSteps;
  }

  private listPreChapters(): Chapter[] {
    const d = this.d;
    d.preChapters = this.patchList(d.preChapters, d.chapters, this.chaptersChanged, false, (r) => r.index, (r) => r.pre);
    return d.preChapters;
  }

  private listGaps(): Gap[] {
    const d = this.d;
    const previous = d.session?.gaps;
    if (previous !== undefined && !this.gapsChanged && d.foldGaps === this.s.gaps.length) return previous;
    d.foldGaps = this.s.gaps.length;
    const gaps: Gap[] = [...this.s.gaps];
    for (const record of d.withGaps) gaps.push(...record.gaps);
    return keep(previous, gaps.sort(compareGaps));
  }

  // -------------------------------------------------- findings

  private findings(partial: Omit<TraceSession, "findings" | "coverage">, coverage: Coverage): Finding[] {
    const d = this.d;
    const index: SignalIndex = {
      stepById: d.preById,
      chapterById: d.preChapterById,
      runChapters: (run) => this.runChapters(run),
    };
    const previous = d.session?.findings;
    const byId = new Map<FindingId, Finding>();
    let changed = previous === undefined;
    d.signalScan = buildSignalScan(partial.steps, d.signalScan);
    d.work.signalSteps = d.signalScan.categorized;
    const findings = evaluateSignals({ session: partial, index, scan: d.signalScan }, coverage).map((finding, position) => {
      const kept = keep(d.findingById.get(finding.id), finding);
      byId.set(kept.id, kept);
      if (kept !== previous?.[position]) changed = true;
      return kept;
    });
    if (previous !== undefined && previous.length !== findings.length) changed = true;
    d.findingById.clear();
    for (const [id, finding] of byId) d.findingById.set(id, finding);
    this.applyFindings(findings);
    return changed || previous === undefined ? findings : previous;
  }

  /** Attaches findingIds to the steps and chapters each finding names, un-collapses them, keeps a
   *  named chapter's finding runs in its band footprint, and marks each contradicted claim step
   *  with the claim_contradicted problem. */
  private applyFindings(findings: readonly Finding[]): void {
    const d = this.d;
    const stepFindings = new Map<StepRecord, FindingId[]>();
    const claims = new Set<StepRecord>();
    const chapterFindings = new Map<ChapterRecord, { ids: FindingId[]; stepIds: Set<StepId> }>();
    for (const finding of findings) {
      for (const stepId of finding.stepIds) {
        const record = d.stepsById.get(stepId);
        if (record === undefined) continue;
        const ids = stepFindings.get(record);
        if (ids === undefined) stepFindings.set(record, [finding.id]);
        else ids.push(finding.id);
      }
      for (const chapterId of finding.chapterIds) {
        const record = d.chapterById.get(chapterId);
        if (record === undefined) continue;
        const named = chapterFindings.get(record);
        if (named === undefined) chapterFindings.set(record, { ids: [finding.id], stepIds: new Set(finding.stepIds) });
        else {
          named.ids.push(finding.id);
          for (const stepId of finding.stepIds) named.stepIds.add(stepId);
        }
      }
      if (finding.ruleId === "claim_contradicted" && finding.claim !== undefined) {
        const record = d.stepsById.get(finding.claim.claim.stepId);
        if (record !== undefined) claims.add(record);
      }
    }
    const steps = new Set<StepRecord>([...this.stepsChanged, ...d.namedSteps, ...stepFindings.keys(), ...claims]);
    d.namedSteps.clear();
    for (const record of steps) {
      if (!d.steps.has(record.draft)) continue;
      const ids = stepFindings.get(record);
      const claim = claims.has(record);
      const pre = record.pre;
      let out = pre;
      if (ids !== undefined || claim) {
        d.namedSteps.add(record);
        out = {
          ...pre,
          findingIds: ids ?? pre.findingIds,
          noise: ids !== undefined ? null : pre.noise,
          problems:
            claim && !pre.problems.includes("claim_contradicted")
              ? [...pre.problems, "claim_contradicted"]
              : pre.problems,
        };
        out = keep(record.out as Step | undefined, out);
      }
      if (out !== record.out) {
        record.out = out;
        this.stepsChanged.add(record);
      }
    }
    const chapters = new Set<ChapterRecord>([...this.chaptersChanged, ...d.namedChapters, ...chapterFindings.keys()]);
    d.namedChapters.clear();
    for (const record of chapters) {
      const named = chapterFindings.get(record);
      const pre = record.pre;
      let out = pre;
      if (named !== undefined) {
        d.namedChapters.add(record);
        const validationOnly = pre.validationOnlyStepIds ?? [];
        out = keep(record.out as Chapter | undefined, {
          ...pre,
          findingIds: named.ids,
          noise: false,
          validationOnlyStepIds: validationOnly.filter((stepId) => !named.stepIds.has(stepId)),
        });
      }
      if (out !== record.out) {
        record.out = out;
        this.chaptersChanged.add(record);
      }
    }
  }

  private listOutSteps(): Step[] {
    const d = this.d;
    d.outSteps = this.patchList(d.outSteps, d.order, this.stepsChanged, this.reordered, (r) => r.pos, (r) => r.out);
    return d.outSteps;
  }

  private listOutChapters(): Chapter[] {
    const d = this.d;
    d.outChapters = this.patchList(d.outChapters, d.chapters, this.chaptersChanged, false, (r) => r.index, (r) => r.out);
    return d.outChapters;
  }
}

/** removeStep drops only a decision's absorbed answer message, which no chapter, entity or run
 *  reads; any other removal re-derives everything rather than unwinding those links. */
function removalReaches(derived: Derived, draft: StepDraft): boolean {
  const record = derived.steps.get(draft);
  if (record === undefined) return false;
  return record.chapterIdx.length > 0 || record.runKey !== null || isEditDraft(draft);
}

/** The session of the rows folded so far (spec §6). Never changes a session it returned before.
 *  Same rows in any batch split, with finalize called between any batches, produce a deep-equal
 *  TraceSession. */
export function finalizeState(state: FoldState, options: FinalizeOptions): TraceSession {
  const previous = state.derived instanceof Derived ? state.derived : null;
  const full =
    previous === null ||
    previous.live !== options.live ||
    !Object.is(previous.origin, state.clock.origin) ||
    state.changes.removedSteps.some((draft) => removalReaches(previous, draft));
  let derived = previous;
  if (full || derived === null) {
    derived = new Derived(options.live, state.clock.origin);
    state.derived = derived;
  }
  return new Finalizer(state, options, derived, full).run();
}

/** What the last finalize on this state re-derived; null before the first. */
export function lastFinalizeWork(state: FoldState): FinalizeWork | null {
  return state.derived instanceof Derived ? { ...state.derived.work } : null;
}
