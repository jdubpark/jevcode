import type { NarrativeSentence } from "@jevcode/contracts";

import type {
  Chapter,
  DecisionDetail,
  DecisionStableId,
  DecisionTradeoff,
  OverviewModel,
  Step,
  StepId,
  TraceSession,
} from "../model/index.js";
import { componentForPath } from "./map-layout.js";
import { stepDigest } from "./step-digest.js";

// Spec §3.5: a decision is a card in the Brief's Now while it is pending; the latest decided ones stay, with
// their narrator "why" and the components they affected (two, as the approved H3 mockup shows). Pure. The cards are
// cached per session object and rebuilt only when what they read changed: the picked decision steps, the chapters, the
// overview or the narrator's whys (a live commit that adds an ordinary step or a story keeps them).

/** Open decisions the Brief shows as cards, oldest first. */
export const BRIEF_DECISIONS_MAX = 3;
/** Answered or delegated decisions the Brief keeps under Decisions, newest first. */
export const BRIEF_DECIDED_MAX = 2;
const COMPONENTS_MAX = 6;

export interface BriefDecisionCard {
  decisionId: string;
  stepId: StepId;
  title: string;
  status: DecisionDetail["status"];
  decidedBy: "supervisor" | "delegated" | "open";
  options: { id: string; label: string; chosen: boolean; tradeoffs: DecisionTradeoff[] }[];
  why: NarrativeSentence | null;
  components: { id: string; name: string }[];
}

const cache = new WeakMap<TraceSession, readonly BriefDecisionCard[]>();

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The one rule both directions read: a decision touches the components its current change units' files fall in (by
 * componentForPath). decisionComponents reads it per decision (the Brief's cards), componentDecisionIds per component
 * (the component Inspector, spec §3.4).
 */
function chapterComponentIds(overview: OverviewModel, chapter: Chapter): Set<string> {
  const ids = new Set<string>();
  for (const file of chapter.files) {
    const id = componentForPath(overview, file);
    if (id !== undefined) ids.add(id);
  }
  return ids;
}

/** That rule over the current chapters that list a decision, both ways. */
interface DecisionJoins {
  /** Decision stable id -> the components of the current chapters listing it. */
  readonly componentsOf: ReadonlyMap<DecisionStableId, ReadonlySet<string>>;
  /** Component id -> the decisions of the current chapters whose files fall in it, in chapter order, then list order. */
  readonly decisionsOf: ReadonlyMap<string, ReadonlySet<DecisionStableId>>;
}

const joinsByOverview = new WeakMap<OverviewModel, WeakMap<readonly Chapter[], DecisionJoins>>();

function addAll<K, V>(map: Map<K, Set<V>>, key: K, values: Iterable<V>): void {
  let set = map.get(key);
  if (set === undefined) map.set(key, (set = new Set()));
  for (const value of values) set.add(value);
}

/** Per chapter list and overview; finalize keeps both the same objects until a unit or a snapshot changes them. */
function decisionJoins(overview: OverviewModel, chapters: readonly Chapter[]): DecisionJoins {
  let byChapters = joinsByOverview.get(overview);
  if (byChapters === undefined) joinsByOverview.set(overview, (byChapters = new WeakMap()));
  const cached = byChapters.get(chapters);
  if (cached !== undefined) return cached;
  const componentsOf = new Map<DecisionStableId, Set<string>>();
  const decisionsOf = new Map<string, Set<DecisionStableId>>();
  for (const chapter of chapters) {
    if (!chapter.current || chapter.decisionIds.length === 0) continue;
    const components = chapterComponentIds(overview, chapter);
    for (const decisionId of chapter.decisionIds) addAll(componentsOf, decisionId, components);
    for (const id of components) addAll(decisionsOf, id, chapter.decisionIds);
  }
  const joins: DecisionJoins = { componentsOf, decisionsOf };
  byChapters.set(chapters, joins);
  return joins;
}

/** The components of the current change units a decision affects (by componentForPath), by name, at most six. */
export function decisionComponents(session: TraceSession, decisionId: string): { id: string; name: string }[] {
  const overview = session.overview;
  if (overview === null) return [];
  const ids = decisionJoins(overview, session.chapters).componentsOf.get(`decision:${decisionId}`);
  if (ids === undefined) return [];
  return [...ids]
    .map((id) => ({ id, name: overview.componentById.get(id)?.name ?? id }))
    .sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id))
    .slice(0, COMPONENTS_MAX);
}

/**
 * The inverse of decisionComponents, uncapped: the decisions of the current change units whose files fall in
 * `componentId`, as stable ids.
 */
export function componentDecisionIds(session: TraceSession, componentId: string): ReadonlySet<DecisionStableId> {
  const overview = session.overview;
  if (overview === null) return new Set();
  return decisionJoins(overview, session.chapters).decisionsOf.get(componentId) ?? new Set();
}

const decisionStepsBySteps = new WeakMap<readonly Step[], readonly Step[]>();

/** The steps with a decision, in list order (stepDigest: a commit reads only the steps it changed). */
export function decisionSteps(steps: readonly Step[]): readonly Step[] {
  const cached = decisionStepsBySteps.get(steps);
  if (cached !== undefined) return cached;
  const out: Step[] = [];
  for (const at of stepDigest(steps).decisions) {
    const step = steps[at];
    if (step !== undefined) out.push(step);
  }
  decisionStepsBySteps.set(steps, out);
  return out;
}

function cardOf(session: TraceSession, step: Step, decision: DecisionDetail): BriefDecisionCard {
  return {
    decisionId: decision.decisionId,
    stepId: step.id,
    title: decision.title,
    status: decision.status,
    decidedBy: decision.decidedBy ?? "open",
    options: decision.options.map((option) => ({ id: option.id, label: option.label, chosen: option.chosen, tradeoffs: option.tradeoffs ?? [] })),
    why: session.explainer.decisionWhy.get(decision.decisionId) ?? null,
    components: decisionComponents(session, decision.decisionId),
  };
}

const pickedBySteps = new WeakMap<readonly Step[], readonly Step[]>();

/** The decision steps the cards show, in card order (buildBriefDecisions), per steps list. */
function pickedSteps(steps: readonly Step[]): readonly Step[] {
  const cached = pickedBySteps.get(steps);
  if (cached !== undefined) return cached;
  const open: Step[] = [];
  const closed: Step[] = [];
  for (const step of decisionSteps(steps)) {
    const status = step.decision?.status;
    if (status === "open") open.push(step);
    else if (status === "answered" || status === "delegated") closed.push(step);
  }
  // By when the answer landed, not by when the decision was asked: the card the reader just answered must be one of
  // those shown. That is the supervisor's answer message (answerSeq), else the row that answered or delegated it
  // (decidedSeq: a delegation or an answer without a message), so a later-answered card sorts first whatever its step
  // order. Never the step's last row: a later re-emit of an old decision adds rows to its step (final review D I-1).
  const answeredAt = (step: Step): number => step.decision?.answerSeq ?? step.decision?.decidedSeq ?? step.lastSeq;
  const newestAnswered = closed.sort((a, b) => answeredAt(b) - answeredAt(a));
  const picked = [...open.slice(0, BRIEF_DECISIONS_MAX), ...newestAnswered.slice(0, BRIEF_DECIDED_MAX)];
  pickedBySteps.set(steps, picked);
  return picked;
}

/** The inputs of the last cards built: a card reads its step, the chapters and overview (components) and the whys. */
let lastCards: {
  picked: readonly Step[];
  chapters: readonly Chapter[];
  overview: OverviewModel | null;
  why: TraceSession["explainer"]["decisionWhy"];
  cards: readonly BriefDecisionCard[];
} | null = null;

/**
 * Open decisions oldest first (at most BRIEF_DECISIONS_MAX), then the answered or delegated ones, the most recently
 * answered first (at most BRIEF_DECIDED_MAX).
 */
export function buildBriefDecisions(session: TraceSession): readonly BriefDecisionCard[] {
  const cached = cache.get(session);
  if (cached !== undefined) return cached;
  const picked = pickedSteps(session.steps);
  const why = session.explainer.decisionWhy;
  const last = lastCards;
  let cards: readonly BriefDecisionCard[];
  if (
    last !== null && last.chapters === session.chapters && last.overview === session.overview && last.why === why &&
    last.picked.length === picked.length && last.picked.every((step, at) => step === picked[at])
  ) {
    cards = last.cards;
  } else {
    cards = picked.flatMap((step) => (step.decision === undefined ? [] : [cardOf(session, step, step.decision)]));
    lastCards = { picked, chapters: session.chapters, overview: session.overview, why, cards };
  }
  cache.set(session, cards);
  return cards;
}
