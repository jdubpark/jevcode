import type { ViewKind } from "../state/view-state.js";
import { CanvasView } from "./canvas/CanvasView.js";
import { HybridView } from "./hybrid/HybridView.js";
import { ConsolePlaceholder, MapPlaceholder } from "./placeholder/ViewPlaceholder.js";
import type { ViewDefinition } from "./view-port.js";

export type { ViewDefinition, ViewProps } from "./view-port.js";

/**
 * Switch and key order (spec §3.7, §8.6, interfaces §6.2): Console 0, Canvas 1, Hybrid 2, Map 3. The Console and Map
 * slots hold quiet placeholders until V-4 (ConsoleView) and lane 06 (MapView) replace them, so the keys never move.
 */
export const VIEWS: readonly ViewDefinition[] = [
  { kind: "console", label: "Console", icon: "view-console", Component: ConsolePlaceholder },
  { kind: "canvas", label: "Canvas", icon: "view-canvas", Component: CanvasView },
  { kind: "hybrid", label: "Hybrid", icon: "view-hybrid", Component: HybridView },
  { kind: "map", label: "Map", icon: "view-map", Component: MapPlaceholder },
];

/** true: hidden views stay mounted under <Activity mode="hidden">; the spike risk 6 ruling sets false (unmount). */
export const KEEP_HIDDEN_VIEWS_MOUNTED = true;

/** VIEWS followed by the host's views (spec §8.5). A host view whose kind is taken (built in or earlier) is dropped. */
export function composeViews(hostViews: readonly ViewDefinition[] | undefined): readonly ViewDefinition[] {
  if (hostViews === undefined || hostViews.length === 0) return VIEWS;
  const taken = new Set<string>(VIEWS.map((view) => view.kind));
  const extra: ViewDefinition[] = [];
  for (const view of hostViews) {
    if (taken.has(view.kind)) continue;
    taken.add(view.kind);
    extra.push(view);
  }
  return extra.length === 0 ? VIEWS : [...VIEWS, ...extra];
}

/**
 * The view a viewer opens on (spec §8.5, §9): the location's view, else initialView, else Console when embedded and
 * Hybrid in full chrome. A kind that `views` does not register falls back to that chrome default.
 */
export function openingView(
  views: readonly ViewDefinition[],
  chrome: "full" | "embedded",
  locationView: ViewKind | undefined,
  initialView: ViewKind | undefined,
): ViewKind {
  const fallback: ViewKind = chrome === "embedded" ? "console" : "hybrid";
  const wanted = locationView ?? initialView ?? fallback;
  return views.some((view) => view.kind === wanted) ? wanted : fallback;
}
