import type { NarrativeSentence } from "@jevcode/contracts";

import type { DecisionDetail, DecisionStableId, DecisionTradeoff, Step, StepId, TraceSession } from "../model/index.js";
import { componentForPath } from "./map-layout.js";

// Spec §3.5: a decision is a card in the Brief's Now while it is pending; the latest decided ones stay, with
// their narrator "why" and the components they affected (two, as the approved H3 mockup shows). Pure; cached per
// session object.

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

/** The components of the current change units a decision affects (by componentForPath), by name, at most six. */
export function decisionComponents(session: TraceSession, decisionId: string): { id: string; name: string }[] {
  const overview = session.overview;
  if (overview === null) return [];
  const stableId = `decision:${decisionId}` as DecisionStableId;
  const ids = new Set<string>();
  for (const chapter of session.chapters) {
    if (!chapter.current || !chapter.decisionIds.includes(stableId)) continue;
    for (const file of chapter.files) {
      const id = componentForPath(overview, file);
      if (id !== undefined) ids.add(id);
    }
  }
  return [...ids]
    .map((id) => ({ id, name: overview.componentById.get(id)?.name ?? id }))
    .sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id))
    .slice(0, COMPONENTS_MAX);
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

/**
 * Open decisions oldest first (at most BRIEF_DECISIONS_MAX), then the answered or delegated ones, the most recently
 * answered first (at most BRIEF_DECIDED_MAX).
 */
export function buildBriefDecisions(session: TraceSession): readonly BriefDecisionCard[] {
  const cached = cache.get(session);
  if (cached !== undefined) return cached;
  const open: Step[] = [];
  const closed: Step[] = [];
  for (const step of session.steps) {
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
  const cards = picked.flatMap((step) => (step.decision === undefined ? [] : [cardOf(session, step, step.decision)]));
  cache.set(session, cards);
  return cards;
}
