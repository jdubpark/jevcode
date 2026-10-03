import { mapEdgeWidth, type MapEdgePath } from "../../../layout/map-layout.js";

/**
 * One drawn line per pair of components. The layout routes A → B and B → A along the same path and the Map does not
 * draw direction (spec alignment note 4), so a two-way import is one path whose weight is the sum of both directions;
 * the Inspector keeps the two directions apart.
 */
export interface MapDrawnEdge extends MapEdgePath {
  /** Directed edge keys `"<from>><to>"` drawn by this path: one, or two for a two-way import. */
  keys: readonly string[];
  twoWay: boolean;
  /** Drawn without a hover or selection: band to band, and at least one direction does not enter a hub. */
  atRest: boolean;
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** The layout's edges merged per component pair, in the layout's order (by the first direction's key). */
export function mapDrawnEdges(edges: readonly MapEdgePath[], hubs: ReadonlySet<string>): MapDrawnEdge[] {
  const drawn: MapDrawnEdge[] = [];
  const byPair = new Map<string, number>();
  for (const edge of edges) {
    const key = `${edge.from}>${edge.to}`;
    const atRest = edge.kind !== "same" && !hubs.has(edge.to);
    const pair = pairKey(edge.from, edge.to);
    const at = byPair.get(pair);
    const first = at === undefined ? undefined : drawn[at];
    if (at === undefined || first === undefined) {
      byPair.set(pair, drawn.length);
      drawn.push({ ...edge, keys: [key], twoWay: false, atRest });
      continue;
    }
    const count = first.count + edge.count;
    drawn[at] = { ...first, count, width: mapEdgeWidth(count), keys: [...first.keys, key], twoWay: true, atRest: first.atRest || atRest };
  }
  return drawn;
}
