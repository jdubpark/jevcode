// Component Inspector data and the bar scales of the Map (spec §3.4). Pure and React-free.
import type { Component, NarrativeSentence } from "@jevcode/contracts";

import { decisionStableId, type DecisionDetail, type OverviewModel, type StepId, type TraceSession } from "../model/index.js";
import { componentDecisionIds, decisionSteps } from "./brief-decisions.js";
import { componentForPath } from "./map-layout.js";
import { enterSession, sessionSlot } from "./session-slots.js";

/** Spec §3.4: files are listed top 20, then "n more". */
export const DETAIL_FILES_SHOWN = 20;
/** The Inspector lists the top 5 imports each way, then "n more" (approved map-selected-1440.png). */
export const DETAIL_LINKS_SHOWN = 5;

export interface MapLink { id: string; name: string; count: number; example: string | null }
export interface ComponentChange { path: string; added: number; removed: number; stepId: StepId }
/** A decision touching the component (spec §3.4): its title is agent text, for displayUntrusted. */
export interface ComponentDecision { decisionId: string; stepId: StepId; title: string; status: DecisionDetail["status"] }
export interface ComponentDetails {
  files: { shown: readonly string[]; more: number };
  importsOut: readonly MapLink[];
  importsIn: readonly MapLink[];
  externals: readonly { name: string; count: number }[];
  /** This session's edited files inside the component, by path. */
  changes: readonly ComponentChange[];
  /** The decisions of the current change units touching the component (componentDecisionIds), in session order. */
  decisions: readonly ComponentDecision[];
  /** Overview sentences citing the component or one of its listed files. */
  citations: readonly NarrativeSentence[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byCount = (a: MapLink, b: MapLink): number => b.count - a.count || cmp(a.name, b.name) || cmp(a.id, b.id);

type ComponentParts = Pick<ComponentDetails, "files" | "importsOut" | "importsIn" | "externals" | "citations">;

/** What the Inspector reads of the overview alone: its files, imports, packages and the sentences citing it. */
function componentParts(overview: OverviewModel, componentId: string, component: Component): ComponentParts {
  const nameOf = (id: string): string => overview.componentById.get(id)?.name ?? id;
  const importsOut: MapLink[] = [];
  const importsIn: MapLink[] = [];
  for (const edge of overview.snapshot.edges) {
    if (edge.from === edge.to) continue;
    const example = edge.examples[0] ?? null;
    if (edge.from === componentId) importsOut.push({ id: edge.to, name: nameOf(edge.to), count: edge.count, example });
    else if (edge.to === componentId) importsIn.push({ id: edge.from, name: nameOf(edge.from), count: edge.count, example });
  }
  const files = new Set(component.files);
  const citations = (overview.snapshot.narrative?.sentences ?? []).filter((sentence) =>
    sentence.citations.some((citation) => (citation.kind === "component" && citation.id === componentId) || (citation.kind === "file" && files.has(citation.id))),
  );
  return {
    files: {
      shown: component.files.slice(0, DETAIL_FILES_SHOWN),
      more: Math.max(0, component.fileCount - Math.min(DETAIL_FILES_SHOWN, component.files.length)),
    },
    importsOut: importsOut.sort(byCount),
    importsIn: importsIn.sort(byCount),
    externals: [...component.externalDeps].sort((a, b) => b.count - a.count || cmp(a.name, b.name)),
    citations,
  };
}

/** This session's edited files inside the component, by path. */
function componentChanges(overview: OverviewModel, componentId: string, entities: TraceSession["entities"]): ComponentChange[] {
  const changes: ComponentChange[] = [];
  for (const entity of entities) {
    const stepId = entity.stepIds.at(-1);
    if (stepId === undefined || componentForPath(overview, entity.path) !== componentId) continue;
    changes.push({ path: entity.path, added: entity.added, removed: entity.removed, stepId });
  }
  return changes.sort((a, b) => cmp(a.path, b.path));
}

/** The decisions touching the component, in session order: its decision steps only (decisionSteps). */
function componentDecisions(session: TraceSession, componentId: string): ComponentDecision[] {
  const touching = componentDecisionIds(session, componentId);
  const decisions: ComponentDecision[] = [];
  if (touching.size === 0) return decisions;
  for (const step of decisionSteps(session.steps)) {
    const decision = step.decision;
    if (decision === undefined || !touching.has(decisionStableId(decision.decisionId))) continue;
    decisions.push({ decisionId: decision.decisionId, stepId: step.id, title: decision.title, status: decision.status });
  }
  return decisions;
}

/**
 * The inputs of the last details built. The overview parts read the passed overview and component; the changes also read
 * the entities; the decisions read the session's chapters, overview and steps. Finalize keeps each of those the same
 * object while it is unchanged, so a live commit rebuilds only the parts whose inputs it changed.
 */
let last: {
  overview: OverviewModel;
  componentId: string;
  entities: TraceSession["entities"];
  chapters: TraceSession["chapters"];
  sessionOverview: TraceSession["overview"];
  steps: TraceSession["steps"];
  details: ComponentDetails;
} | null = null;

sessionSlot({
  clear: () => {
    last = null;
  },
  held: () => (last === null ? [] : [last.overview, last.entities, last.chapters, last.sessionOverview, last.steps]),
});

export function componentDetails(overview: OverviewModel, componentId: string, session: TraceSession): ComponentDetails | null {
  enterSession(session.meta.sessionId);
  const component = overview.componentById.get(componentId);
  if (component === undefined) return null;
  const { entities, chapters, steps } = session;
  const previous = last !== null && last.overview === overview && last.componentId === componentId ? last : null;
  if (
    previous !== null && previous.entities === entities && previous.chapters === chapters &&
    previous.sessionOverview === session.overview && previous.steps === steps
  ) {
    return previous.details;
  }
  const parts: ComponentParts = previous?.details ?? componentParts(overview, componentId, component);
  const details: ComponentDetails = {
    files: parts.files,
    importsOut: parts.importsOut,
    importsIn: parts.importsIn,
    externals: parts.externals,
    changes: previous !== null && previous.entities === entities ? previous.details.changes : componentChanges(overview, componentId, entities),
    decisions:
      previous !== null && previous.chapters === chapters && previous.sessionOverview === session.overview && previous.steps === steps
        ? previous.details.decisions
        : componentDecisions(session, componentId),
    citations: parts.citations,
  };
  last = { overview, componentId, entities, chapters, sessionOverview: session.overview, steps, details };
  return details;
}

/** The longest list bar in the Inspector, in px (revised Map mockup). */
export const LIST_BAR_MAX_PX = 48;

/** Width of a card's file-count bar as a percent of its track: √(files ÷ largest), never below 8% so every card shows one. */
export function fileBarPercent(files: number, maxFiles: number): number {
  if (maxFiles <= 0) return 8;
  return Math.min(100, Math.max(8, Math.round(100 * Math.sqrt(Math.max(0, files) / maxFiles))));
}

/** Width in px of an Inspector list bar: the count's share of the list's largest, at least 1 px for a nonzero count. */
export function listBarPx(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  return Math.max(1, Math.round((LIST_BAR_MAX_PX * count) / max));
}

/** A component's top `n` external packages by count, then name; the detail-level card shows two. */
export function topPackages(component: Component, n: number): readonly { name: string; count: number }[] {
  return [...component.externalDeps].sort((a, b) => b.count - a.count || cmp(a.name, b.name)).slice(0, Math.max(0, n));
}
