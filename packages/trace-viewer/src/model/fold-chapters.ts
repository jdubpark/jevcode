import { AttentionDecisionSchema, type ChangeUnit, type Decision, type JevDecisionLog } from "@jevcode/contracts";

import {
  addRowToStep,
  createStep,
  currentTurn,
  touchTurn,
  type FoldState,
  type RowContext,
  type StepDraft,
  type UnitAttention,
} from "./fold-state.js";
import { clampMeta } from "./registry.js";
import {
  decisionStableId,
  unitStableId,
  type Chapter,
  type DecisionDetail,
  type DecisionStableId,
  type Entity,
  type Step,
  type StepId,
  type StepStatus,
} from "./types.js";

/** Fallback join window slack: the git collector polls every 5 s. */
export const APPROX_WINDOW_SLACK_MS = 5_000;

export function foldChangeUnit(state: FoldState, unit: ChangeUnit, ctx: RowContext): void {
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

function decisionStatus(decision: Decision): StepStatus {
  return decision.status === "answered" || decision.status === "delegated" ? "ok" : "info";
}

/** Every row of one decision id folds into one step (step:<firstSeq>). */
export function foldDecision(state: FoldState, decision: Decision, ctx: RowContext): void {
  const turn = currentTurn(state, ctx);
  touchTurn(turn, ctx);
  state.chapters.decisionUnits.set(decision.id, [...decision.affectedChangeUnits]);
  if (decision.status === "answered" || decision.status === "delegated") turn.decisionAnswered = true;
  const existing = state.chapters.decisionSteps.get(decision.id);
  if (existing !== undefined) {
    addRowToStep(existing, ctx, false);
    existing.decision = decisionDetail(decision);
    existing.status = decisionStatus(decision);
    existing.endTs = ctx.sourceTs;
    existing.endTMs = ctx.t;
    existing.durationMs = ctx.t - existing.tMs;
    return;
  }
  const step = createStep(state, turn, ctx, {
    kind: "decision",
    source: "decision",
    status: decisionStatus(decision),
  });
  step.decision = decisionDetail(decision);
  state.chapters.decisionSteps.set(decision.id, step);
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

/** Edit steps per path, duplicate_poll steps left out; built once per finalize. */
function editsByPath(steps: readonly Step[], duplicates: ReadonlySet<string>): Map<string, Step[]> {
  const byPath = new Map<string, Step[]>();
  for (const step of steps) {
    if (step.kind !== "edit" || step.edit === undefined || duplicates.has(step.id)) continue;
    const list = byPath.get(step.edit.path);
    if (list === undefined) byPath.set(step.edit.path, [step]);
    else list.push(step);
  }
  return byPath;
}

/** D11: edit steps on unit.files inside [createdAt, updatedAt] widened by the slack; for a file
 *  with none there, its latest edit at or before the window's end. */
function approximateSteps(unit: ChangeUnit, edits: ReadonlyMap<string, Step[]>): Step[] {
  const from = Date.parse(unit.createdAt) - APPROX_WINDOW_SLACK_MS;
  const to = Date.parse(unit.updatedAt) + APPROX_WINDOW_SLACK_MS;
  const picked: Step[] = [];
  for (const file of new Set(unit.files)) {
    const candidates = edits.get(file) ?? [];
    let inWindow = 0;
    let latestBefore: Step | undefined;
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
 *  formatting-only change (R25). applySignals clears it for a chapter a finding names. */
function isNoiseChapter(
  stepIds: readonly StepId[],
  stepById: ReadonlyMap<StepId, Step>,
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

/** One chapter per change unit, from its latest version (R10). Also fills step.chapterIds and
 *  entity.chapterIds. */
export function buildChapters(
  state: FoldState,
  steps: readonly Step[],
  stepById: ReadonlyMap<StepId, Step>,
  entities: readonly Entity[],
): Chapter[] {
  const evidence = state.evidence;
  const chapters = state.chapters;
  const origin = state.clock.origin;
  const edits = editsByPath(steps, evidence.duplicates);
  const entries = [...chapters.units.values()].sort(
    (a, b) => a.firstSeq - b.firstSeq || a.unit.id.localeCompare(b.unit.id),
  );
  const result: Chapter[] = [];
  for (const entry of entries) {
    const unit = entry.unit;
    const id = unitStableId(unit.id);
    const linked = new Set<StepId>();
    const pick = (draft: StepDraft | Step | undefined): void => {
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
    let callLinks = 0;
    for (const callId of unit.agentCallIds ?? []) {
      const step = state.stepsByCallId.get(callId);
      if (step === undefined) continue;
      callLinks += 1;
      pick(step);
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
    for (const [decisionId, draft] of chapters.decisionSteps) {
      const related = unit.relatedDecisions.includes(decisionId);
      const affected = chapters.decisionUnits.get(decisionId)?.includes(unit.id) ?? false;
      if (related || affected) {
        decisionIds.push(decisionStableId(decisionId));
        pick(draft);
      }
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
    const stepIds = [...linked].sort((a, b) => (stepById.get(a)?.firstSeq ?? 0) - (stepById.get(b)?.firstSeq ?? 0));
    for (const stepId of stepIds) stepById.get(stepId)?.chapterIds.push(id);
    const tMs = offset(origin, unit.createdAt);
    result.push({
      id,
      changeUnitId: unit.id,
      title: unit.title,
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
      validationStepIds: [...validationSteps].sort(
        (a, b) => (stepById.get(a)?.firstSeq ?? 0) - (stepById.get(b)?.firstSeq ?? 0),
      ),
      clampIds,
      triad: triadOf(unit, chapters.attentionByUnit.get(unit.id)),
      schemaChanges: unit.schemaChanges.map((change) => ({ ...change })),
      dependencyChanges: unit.dependencyChanges.map((change) => ({ ...change })),
      findingIds: [],
    });
  }
  const byPath = new Map(entities.map((entity) => [entity.path, entity]));
  for (const chapter of result) {
    for (const file of chapter.files) byPath.get(file)?.chapterIds.push(chapter.id);
  }
  return result;
}
