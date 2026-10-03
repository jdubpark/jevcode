import { memo, useMemo } from "react";
import type React from "react";

import type { MapEdgePath, MapLayout } from "../../../layout/map-layout.js";
import { mapDrawnEdges, type MapDrawnEdge } from "./map-edge-pairs.js";
import styles from "./MapView.module.css";

/** Stroke px by `MapEdgePath.width` bucket (revised Map mockup), non-scaling at any zoom. */
export const MAP_EDGE_STROKE: Readonly<Record<MapEdgePath["width"], number>> = { 1: 1, 2: 1.6, 3: 2.4 };

/** A hub's mark: three strokes, 11 long, converging on its left port at (x, y). */
export function hubStubPath(x: number, y: number): string {
  return `M${x - 11} ${y - 7}Q${x - 5} ${y - 7} ${x} ${y}M${x - 11} ${y}H${x}M${x - 11} ${y + 7}Q${x - 5} ${y + 7} ${x} ${y}`;
}

export interface MapEdgesProps {
  layout: MapLayout;
  /** Component ids that are hubs (mapHubIds). */
  hubs: ReadonlySet<string>;
  /** The hovered, else the selected, component: all of its edges show, in accent, on top. */
  activeId: string | null;
  /** Lane 07 overlay: edge keys "<from>><to>" with both ends touched; they always draw. */
  emphasized: ReadonlySet<string> | null;
}

/**
 * One SVG under the cards, one path per pair of components (mapDrawnEdges: a two-way import is one path with the summed
 * weight). At rest it draws band-to-band edges that do not enter a hub (and emphasized session edges); the active card
 * adds all of its own edges, same-band and hub edges included, in accent and drawn last, while every other edge drops
 * to 22% (revised Map mockup, spec §3.4).
 */
function MapEdgesView({ layout, hubs, activeId, emphasized }: MapEdgesProps): React.JSX.Element {
  const pairs = useMemo(() => mapDrawnEdges(layout.edges, hubs), [layout.edges, hubs]);
  const rest = useMemo(
    () => pairs.filter((edge) => edge.atRest || (emphasized !== null && edge.keys.some((key) => emphasized.has(key)))),
    [pairs, emphasized],
  );
  const touches = (edge: MapDrawnEdge): boolean => activeId !== null && (edge.from === activeId || edge.to === activeId);
  const lit = activeId === null ? [] : pairs.filter(touches);
  const drawn = [...rest.filter((edge) => !touches(edge)), ...lit];
  return (
    <svg className={styles.edges} width={Math.max(1, layout.bounds.w)} height={Math.max(1, layout.bounds.h)} aria-hidden="true" focusable="false">
      {layout.cards
        .filter((card) => hubs.has(card.id) && card.id !== activeId)
        .map((card) => (
          <path key={card.id} d={hubStubPath(card.x, card.y + card.h / 2)} className={styles.stub} data-map-hub-stub={card.id} />
        ))}
      {drawn.map((edge) => {
        const [key, reverse] = edge.keys;
        const isLit = touches(edge);
        return (
          <path
            key={key}
            d={edge.d}
            className={styles.edge}
            strokeWidth={MAP_EDGE_STROKE[edge.width]}
            data-map-edge={key}
            data-map-edge-reverse={reverse}
            data-two-way={edge.twoWay ? "" : undefined}
            data-kind={edge.kind}
            data-lit={isLit ? "" : undefined}
            data-dim={activeId !== null && !isLit ? "" : undefined}
            data-emphasized={emphasized !== null && edge.keys.some((item) => emphasized.has(item)) ? "" : undefined}
          />
        );
      })}
    </svg>
  );
}

export const MapEdges = memo(MapEdgesView);
