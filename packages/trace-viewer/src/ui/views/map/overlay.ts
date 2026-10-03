import type { TraceSession } from "../../../model/index.js";

/** Phase C session state of a card (spec §3.4); red only for "failing". */
export type MapCardState = "new" | "changed" | "decision" | "failing";

export interface MapOverlay {
  cardState: ReadonlyMap<string, MapCardState>;
  /** Edge keys "<from>><to>" the session touched. */
  emphasizedEdges: ReadonlySet<string>;
}

/** Phase B has no session overlay. Lane 07 (S-5) derives it from session.explainer.highlights. */
export function mapOverlayOf(session: TraceSession): MapOverlay | null {
  void session;
  return null;
}
