import { HIGHLIGHT_STATES, type OverviewModel, type TraceSession } from "../../../model/index.js";

/** Phase C session state of a card (spec §3.4); red only for "failing". */
export type MapCardState = "new" | "changed" | "decision" | "failing";

export interface MapOverlay {
  /** Every state of a highlighted card in drawing order (new or changed, decided, failing); the arrays are stable per overlay. */
  cardState: ReadonlyMap<string, readonly MapCardState[]>;
  /** Edge keys "<from>><to>" the session touched. */
  emphasizedEdges: ReadonlySet<string>;
}

const cache = new WeakMap<TraceSession["explainer"], { overview: OverviewModel; overlay: MapOverlay | null }>();

/**
 * Spec §3.4 (phase C): the latest highlights on the map's components, and the edges whose two ends were touched. A
 * highlighted id the overview does not list (unknown, or from an older scan) is skipped. Null without an overview,
 * without highlights, or when no highlighted component is on the map. Cached per (explainer, overview).
 */
export function mapOverlayOf(session: TraceSession): MapOverlay | null {
  const overview = session.overview;
  const highlights = session.explainer.highlights;
  if (overview === null || highlights === null) return null;
  const hit = cache.get(session.explainer);
  if (hit !== undefined && hit.overview === overview) return hit.overlay;
  const cardState = new Map<string, readonly MapCardState[]>();
  for (const [id, entry] of highlights.byComponent) if (overview.componentById.has(id)) cardState.set(id, HIGHLIGHT_STATES.filter((state) => entry.states.includes(state)));
  const emphasizedEdges = new Set<string>();
  for (const edge of overview.snapshot.edges) {
    if (cardState.has(edge.from) && cardState.has(edge.to)) emphasizedEdges.add(`${edge.from}>${edge.to}`);
  }
  const overlay = cardState.size === 0 ? null : { cardState, emphasizedEdges };
  cache.set(session.explainer, { overview, overlay });
  return overlay;
}

export function overlayCounts(overlay: MapOverlay): Readonly<Record<MapCardState, number>> {
  const counts: Record<MapCardState, number> = { new: 0, changed: 0, decision: 0, failing: 0 };
  for (const states of overlay.cardState.values()) for (const state of states) counts[state] += 1;
  return counts;
}

/** What a mark means, for accessible names (the dots themselves are decoration). */
export const MARK_WORD: { readonly [K in MapCardState]: string } = {
  new: "new in this session",
  changed: "changed in this session",
  decision: "touched by a decision",
  failing: "failing test",
};
