// Component Inspector data and the bar scales of the Map (spec §3.4). Pure and React-free.
import type { Component, NarrativeSentence } from "@jevcode/contracts";

import type { OverviewModel, StepId, TraceSession } from "../model/index.js";
import { componentForPath } from "./map-layout.js";

/** Spec §3.4: files are listed top 20, then "n more". */
export const DETAIL_FILES_SHOWN = 20;

export interface MapLink { id: string; name: string; count: number; example: string | null }
export interface ComponentChange { path: string; added: number; removed: number; stepId: StepId }
export interface ComponentDetails {
  files: { shown: readonly string[]; more: number };
  importsOut: readonly MapLink[];
  importsIn: readonly MapLink[];
  externals: readonly { name: string; count: number }[];
  /** This session's edited files inside the component, by path. */
  changes: readonly ComponentChange[];
  /** Overview sentences citing the component or one of its listed files. */
  citations: readonly NarrativeSentence[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byCount = (a: MapLink, b: MapLink): number => b.count - a.count || cmp(a.name, b.name) || cmp(a.id, b.id);

export function componentDetails(overview: OverviewModel, componentId: string, session: TraceSession): ComponentDetails | null {
  const component = overview.componentById.get(componentId);
  if (component === undefined) return null;
  const nameOf = (id: string): string => overview.componentById.get(id)?.name ?? id;
  const importsOut: MapLink[] = [];
  const importsIn: MapLink[] = [];
  for (const edge of overview.snapshot.edges) {
    if (edge.from === edge.to) continue;
    const example = edge.examples[0] ?? null;
    if (edge.from === componentId) importsOut.push({ id: edge.to, name: nameOf(edge.to), count: edge.count, example });
    else if (edge.to === componentId) importsIn.push({ id: edge.from, name: nameOf(edge.from), count: edge.count, example });
  }
  const changes: ComponentChange[] = [];
  for (const entity of session.entities) {
    const stepId = entity.stepIds.at(-1);
    if (stepId === undefined || componentForPath(overview, entity.path) !== componentId) continue;
    changes.push({ path: entity.path, added: entity.added, removed: entity.removed, stepId });
  }
  changes.sort((a, b) => cmp(a.path, b.path));
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
    changes,
    citations,
  };
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
