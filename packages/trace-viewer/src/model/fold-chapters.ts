import { AttentionDecisionSchema, type ChangeUnit, type Decision, type JevDecisionLog } from "@jevcode/contracts";

import {
  addRowToStep,
  createStep,
  currentTurn,
  removeStep,
  touchTurn,
  type FoldState,
  type RowContext,
  type StepDraft,
  type UnitAttention,
  type UnitEntry,
} from "./fold-state.js";
import { clampMeta } from "./registry.js";
import { chapterShortTitle } from "./short-title.js";
import {
  decisionStableId,
  unitStableId,
  type Chapter,
  type DecisionDetail,
  type DecisionStableId,
  type Step,
  type StepId,
  type StepStatus,
} from "./types.js";

/** Fallback join window slack: the git collector polls every 5 s. */
export const APPROX_WINDOW_SLACK_MS = 5_000;

export function foldChangeUnit(state: FoldState, unit: ChangeUnit, ctx: RowContext): void {
  state.changes.units.add(unit.id);
  const entry = state.chapters.units.get(unit.id);
  if (entry === undefined) {
    state.chapters.units.set(unit.id, { unit, firstSeq: ctx.seq, lastSeq: ctx.seq, versions: 1 });
    return;
  }
  entry.unit = unit;
  entry.lastSeq = ctx.seq;
  entry.versions += 1;
}

function decisionDetail(decision: Decision): DecisionDetail {
  const chosen = new Set(Object.values(decision.answer?.decision ?? {}));
  const decidedBy =
    decision.status === "answered" ? "supervisor" : decision.status === "delegated" ? "delegated" : undefined;
  return {
    decisionId: decision.id,
    title: decision.title,
    severity: decision.severity,
    status: decision.status,
    options: decision.options.map((option) => ({ id: option.id, label: option.label, chosen: chosen.has(option.id) })),
    ...(decidedBy !== undefined ? { decidedBy } : {}),
  };
}

/** spec §6.6 Status: running while open, ok when answered or delegated, unknown when expired. */
function decisionStatus(decision: Decision): StepStatus {
  switch (decision.status) {
    case "open":
      return "running";
    case "answered":
    case "delegated":
      return "ok";
    case "expired":
      return "unknown";
  }
}

/** Every row of one decision id folds into one step (step:<firstSeq>, target = the decision id).
 *  A user message whose next decision row answers or delegates an already-open decision is the
 *  supervisor's answer: its instruction step is removed and its seqs join the decision step (R25). */
export function foldDecision(state: FoldState, decision: Decision, ctx: RowContext): void {
  const turn = currentTurn(state, ctx);
  touchTurn(turn, ctx);
  const answer = state.pendingAnswer;
  state.pendingAnswer = null;
  setDecisionUnits(state, decision.id, decision.affectedChangeUnits);
  const closes = decision.status === "answered" || decision.status === "delegated";
  if (closes) turn.decisionAnswered = true;
  const existing = state.chapters.decisionSteps.get(decision.id);
  if (existing !== undefined) {
    const answerSeq = existing.decision?.answerSeq;
    // Only the row that closes the decision ends its wait; the Jev projection pass re-emits
    // answered decisions later, and those rows must not stretch it (spec §6.6 "Decision answers").
    const closing = existing.status === "running" && decisionStatus(decision) !== "running";
    addRowToStep(state, existing, ctx, false);
    existing.decision = decisionDetail(decision);
    if (answerSeq !== undefined) existing.decision.answerSeq = answerSeq;
    let end: { t: number; sourceTs: string } = ctx;
    if (closes && answer !== null) {
      removeStep(state, answer.step);
      existing.seqs.push(...answer.step.seqs);
      existing.seqs.sort((a, b) => a - b);
      existing.decision.answerSeq = answer.seq;
      end = answer;
      const relaunched = state.turns[answer.step.turnIndex];
      if (relaunched !== undefined && relaunched.instruction === answer.step) {
        // The answer was delivered as a steer: its relaunch opens a turn without an instruction
        // step, and the turn's prompt is the decision title (spec §6.6 "Instruction dedupe").
        relaunched.instruction = null;
        relaunched.prompt = decision.title;
      } else {
        state.answeredPrompts.set((answer.step.text ?? "").trim(), { step: existing, title: decision.title });
      }
    }
    existing.status = decisionStatus(decision);
    if (closing) {
      existing.endTs = end.sourceTs;
      existing.endTMs = Math.max(existing.tMs, end.t);
      existing.durationMs = existing.endTMs - existing.tMs;
    }
    return;
  }
  const step = createStep(state, turn, ctx, {
    kind: "decision",
    source: "decision",
    status: decisionStatus(decision),
    target: decision.id,
  });
  step.decision = decisionDetail(decision);
  state.chapters.decisionOrder.set(decision.id, state.chapters.decisionSteps.size);
  state.chapters.decisionSteps.set(decision.id, step);
  state.changes.decisionIds.add(decision.id);
}

/** Records a decision row's affectedChangeUnits and marks the units it adds or drops. */
function setDecisionUnits(state: FoldState, decisionId: string, affected: readonly string[]): void {
  const chapters = state.chapters;
  for (const unitId of chapters.decisionUnits.get(decisionId) ?? []) {
    chapters.decisionsByUnit.get(unitId)?.delete(decisionId);
    state.changes.units.add(unitId);
  }
  chapters.decisionUnits.set(decisionId, [...affected]);
  for (const unitId of affected) {
    let set = chapters.decisionsByUnit.get(unitId);
    if (set === undefined) chapters.decisionsByUnit.set(unitId, (set = new Set()));
    set.add(decisionId);
    state.changes.units.add(unitId);
  }
}

/** shouldSurface of a Pass A row (an attention decision or a guardrail suppression), else
 *  undefined. Pass B rows (UI intents) carry no shouldSurface. */
function passASurface(log: JevDecisionLog): boolean | undefined {
  if (log.pass === "B") return undefined;
  const output = log.output;
  if (typeof output !== "object" || output === null) return undefined;
  const surface = (output as { shouldSurface?: unknown }).shouldSurface;
  return typeof surface === "boolean" ? surface : undefined;
}

/** A jev_decision with clamps is a guardrail step; one without is an attention step. */
export function foldJevDecision(state: FoldState, log: JevDecisionLog, ctx: RowContext): void {
  state.capabilities.add("jev_decisions");
  if (log.changeUnitId !== undefined) state.changes.units.add(log.changeUnitId);
  const surface = passASurface(log);
  if (log.changeUnitId !== undefined && surface !== undefined) state.chapters.surfaceByUnit.set(log.changeUnitId, surface);
  if (log.changeUnitId !== undefined && log.pass !== "B") {
    // Chapter.triad (spec §6.6): the latest Pass A row that is a full attention decision.
    const attention = AttentionDecisionSchema.safeParse(log.output);
    if (attention.success) {
      state.chapters.attentionByUnit.set(log.changeUnitId, {
        importance: attention.data.importance,
        relevance: attention.data.relevance,
        interruption: attention.data.interruption,
        clientKind: log.clientKind,
      });
    }
  }
  const turn = currentTurn(state, ctx);
  touchTurn(turn, ctx);
  let step: StepDraft;
  if (log.clamps.length > 0) {
    step = createStep(state, turn, ctx, {
      kind: "guardrail",
      source: "jev_decision",
      status: "info",
      label: log.clamps.map((id) => clampMeta(id).label).join(", "),
    });
    step.guardrail = {
      clampIds: [...log.clamps],
      clientKind: log.clientKind,
      confidence: log.confidence,
      ...(log.changeUnitId !== undefined ? { changeUnitId: log.changeUnitId } : {}),
      ...(log.pass !== undefined ? { pass: log.pass } : {}),
    };
  } else {
    step = createStep(state, turn, ctx, { kind: "attention", source: "jev_decision", status: "info" });
  }
  if (log.changeUnitId !== undefined) {
    const list = state.chapters.jevStepsByUnit.get(log.changeUnitId);
    if (list === undefined) state.chapters.jevStepsByUnit.set(log.changeUnitId, [step]);
    else list.push(step);
  }
}

/** Unit createdAt/updatedAt are source (fact) times, so they sit on the clock's origin. */
function offset(origin: number, ts: string): number {
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed) || Number.isNaN(origin)) return 0;
  return Math.max(0, parsed - origin);
}

/** A step the D11 fallback can join: an edit step's fields it reads. */
type EditCandidate = Pick<Step, "id" | "startTs" | "evidenceSeqs">;

/** D11: edit steps on unit.files inside [createdAt, updatedAt] widened by the slack; for a file
 *  with none there, its latest edit at or before the window's end. edits holds each path's edit
 *  steps in seq order, duplicate_poll steps left out. */
function approximateSteps<S extends EditCandidate>(unit: ChangeUnit, edits: ReadonlyMap<string, readonly S[]>): S[] {
  const from = Date.parse(unit.createdAt) - APPROX_WINDOW_SLACK_MS;
  const to = Date.parse(unit.updatedAt) + APPROX_WINDOW_SLACK_MS;
  const picked: S[] = [];
  for (const file of new Set(unit.files)) {
    const candidates = edits.get(file) ?? [];
    let inWindow = 0;
    let latestBefore: S | undefined;
    for (const step of candidates) {
      const t = Date.parse(step.startTs);
      if (!Number.isNaN(t) && t >= from && t <= to) {
        picked.push(step);
        inWindow += 1;
      }
      if (Number.isNaN(to) || Number.isNaN(t) || t <= to) latestBefore = step;
    }
    if (inWindow === 0 && latestBefore !== undefined) picked.push(latestBefore);
  }
  return picked;
}

/** Chapter.triad (spec §6.6): the latest Pass A attention row's scores and client kind, else the
 *  unit's own scores without a client kind. */
function triadOf(unit: ChangeUnit, attention: UnitAttention | undefined): Chapter["triad"] {
  if (attention !== undefined) return { ...attention };
  return {
    ...(unit.importance !== undefined ? { importance: unit.importance } : {}),
    ...(unit.relevance !== undefined ? { relevance: unit.relevance } : {}),
    ...(unit.interruption !== undefined ? { interruption: unit.interruption } : {}),
  };
}

/** True when the chapter joins at least one edit and every joined edit is a lockfile or a
 *  formatting-only change (R25). The finalize clears it for a chapter a finding names. */
function isNoiseChapter(
  stepIds: readonly StepId[],
  stepById: ReadonlyMap<StepId, StepDraft>,
  duplicates: ReadonlySet<string>,
): boolean {
  let edits = 0;
  for (const stepId of stepIds) {
    const step = stepById.get(stepId);
    if (step?.edit === undefined || duplicates.has(step.id)) continue;
    if (!step.edit.lockfile && !step.edit.formattingOnly) return false;
    edits += 1;
  }
  return edits > 0;
}

/** The decision ids a unit links, in decisionSteps order: those its latest version relates and
 *  those whose latest decision row lists it as affected. */
function unitDecisions(state: FoldState, unit: ChangeUnit): string[] {
  const chapters = state.chapters;
  const candidates = new Set<string>();
  for (const decisionId of unit.relatedDecisions) if (chapters.decisionSteps.has(decisionId)) candidates.add(decisionId);
  for (const decisionId of chapters.decisionsByUnit.get(unit.id) ?? []) {
    if (chapters.decisionUnits.get(decisionId)?.includes(unit.id) === true) candidates.add(decisionId);
  }
  return [...candidates].sort((a, b) => (chapters.decisionOrder.get(a) ?? 0) - (chapters.decisionOrder.get(b) ?? 0));
}

/**
 * The chapter of one change unit, from its latest version (R10), before the session-wide passes:
 * validationOnlyStepIds is empty, findingIds is empty and noise is the chapter's own. Reads only the
 * fold state; edits holds each path's non-duplicate edit steps in seq order (the D11 fallback).
 * Step.chapterIds and Entity.chapterIds are the finalize's (fold-finalize.ts).
 */
export function buildChapter(state: FoldState, entry: UnitEntry, edits: ReadonlyMap<string, readonly StepDraft[]>): Chapter {
  const evidence = state.evidence;
  const chapters = state.chapters;
  const stepById = state.stepById;
  const origin = state.clock.origin;
  const unit = entry.unit;
  const id = unitStableId(unit.id);
  const linked = new Set<StepId>();
  const pick = (draft: StepDraft | undefined): void => {
    if (draft !== undefined) linked.add(draft.id);
  };
  const factIds = [...new Set(unit.evidence.filter((evidenceId) => evidenceId.startsWith("fact_")))];
  const resolvedSeqs: number[] = [];
  for (const factId of factIds) {
    const seq = evidence.factSeqById.get(factId);
    if (seq === undefined) continue;
    resolvedSeqs.push(seq);
    pick(evidence.stepByEvidenceSeq.get(seq));
  }
  // spec §6.6 join: every step whose callId the unit cites. One Codex file_change item gives its
  // callId to one edit per path and A1-8 cites it from every unit owning one of those paths, so an
  // edit step joins only the unit whose files hold its path. A call id counts toward the link only
  // when it joins at least one step.
  const unitFiles = new Set(unit.files);
  let callLinks = 0;
  for (const callId of new Set(unit.agentCallIds ?? [])) {
    let joined = false;
    for (const draft of state.allStepsByCallId.get(callId) ?? []) {
      if (draft.edit !== undefined && !unitFiles.has(draft.edit.path)) continue;
      joined = true;
      pick(draft);
    }
    if (joined) callLinks += 1;
  }
  // Content-hash and call-id joins decide the link. A unit that cites neither (a failure-only
  // unit) is joined by plain ids below and stays observed.
  const citesJoins = factIds.length > 0 || (unit.agentCallIds ?? []).length > 0;
  const observed = !citesJoins || resolvedSeqs.length > 0 || callLinks > 0;
  const validationSteps = new Set<StepId>();
  for (const validationId of unit.validationResults) {
    const seq = evidence.validationSeqById.get(validationId);
    if (seq === undefined) continue;
    const draft = evidence.stepByEvidenceSeq.get(seq);
    pick(draft);
    if (draft !== undefined) validationSteps.add(draft.id);
  }
  const decisionIds: DecisionStableId[] = [];
  for (const decisionId of unitDecisions(state, unit)) {
    decisionIds.push(decisionStableId(decisionId));
    pick(chapters.decisionSteps.get(decisionId));
  }
  const clampIds: string[] = [];
  for (const draft of chapters.jevStepsByUnit.get(unit.id) ?? []) {
    pick(draft);
    for (const clampId of draft.guardrail?.clampIds ?? []) if (!clampIds.includes(clampId)) clampIds.push(clampId);
  }
  const factSeqs = new Set(resolvedSeqs);
  let approx = 0;
  if (!observed) {
    for (const step of approximateSteps(unit, edits)) {
      if (linked.has(step.id)) continue;
      approx += 1;
      linked.add(step.id);
      for (const seq of step.evidenceSeqs) factSeqs.add(seq);
    }
  }
  const bySeq = (a: StepId, b: StepId): number => (stepById.get(a)?.firstSeq ?? 0) - (stepById.get(b)?.firstSeq ?? 0);
  const stepIds = [...linked].sort(bySeq);
  const tMs = offset(origin, unit.createdAt);
  return {
    id,
    changeUnitId: unit.id,
    title: unit.title,
    shortTitle: chapterShortTitle(unit),
    ...(unit.intent !== undefined ? { intent: unit.intent } : {}),
    category: unit.category,
    status: unit.status,
    current: unit.status !== "superseded",
    noise: isNoiseChapter(stepIds, stepById, evidence.duplicates) || chapters.surfaceByUnit.get(unit.id) === false,
    files: [...unit.files],
    link: observed ? "observed" : "inferred",
    evidenceLinks: { cited: factIds.length, resolved: resolvedSeqs.length, approx },
    firstSeq: entry.firstSeq,
    lastSeq: entry.lastSeq,
    versions: entry.versions,
    startTs: unit.createdAt,
    endTs: unit.updatedAt,
    tMs,
    endTMs: Math.max(tMs, offset(origin, unit.updatedAt)),
    stepIds,
    factSeqs: [...factSeqs].sort((a, b) => a - b),
    decisionIds,
    validationIds: [...unit.validationResults],
    validationStepIds: [...validationSteps].sort(bySeq),
    validationOnlyStepIds: [],
    clampIds,
    triad: triadOf(unit, chapters.attentionByUnit.get(unit.id)),
    schemaChanges: unit.schemaChanges.map((change) => ({ ...change })),
    dependencyChanges: unit.dependencyChanges.map((change) => ({ ...change })),
    findingIds: [],
  };
}
