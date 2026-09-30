import { memo } from "react";
import type React from "react";

import type { CanvasLayout } from "../../../layout/canvas-layout.js";
import { directPath, type CanvasEdge } from "../../../layout/canvas-routes.js";
import styles from "./World.module.css";

export interface DrawnEdge {
  edge: CanvasEdge;
  d: string;
  hop: boolean;
}

/**
 * Rest edges plus the selection's one-hop edges. "over" holds the lifted paths drawn above the frames with a halo:
 * `shape: "direct"` (the contradicts fallback) and the selection's lane-less edges (`d: null`, spec §7.5) via directPath.
 */
export function drawnEdges(layout: CanvasLayout, selectedKey: string | null, layer: "under" | "over"): DrawnEdge[] {
  const out: DrawnEdge[] = [];
  for (const edge of layout.edges) {
    // A trunk's from/to are only its first and last placed story frames, not relations of the selection: it never
    // turns accent, it dims like any other edge (canvas-camera's zoomToSelection skips it the same way).
    const hop =
      selectedKey !== null && edge.kind !== "trunk" && (edge.from === selectedKey || edge.to === selectedKey);
    if (!edge.rest && !hop) continue;
    let d = edge.d;
    let lifted = edge.shape === "direct";
    if (d === null) {
      const from = layout.frameByKey.get(edge.from);
      const to = layout.frameByKey.get(edge.to);
      if (from === undefined || to === undefined) continue;
      d = directPath(from.card, to.card);
      lifted = true;
    }
    if ((layer === "over") !== lifted) continue;
    out.push({ edge, d, hop });
  }
  return out;
}

export interface EdgeLayerProps {
  layout: CanvasLayout;
  layer: "under" | "over";
  selectedKey: string | null;
  onSelectEdge(edge: CanvasEdge): void;
}

function strokeClass(edge: CanvasEdge, hop: boolean, selecting: boolean): string {
  return [styles.edge, hop ? styles.hop : selecting ? styles.dim : undefined, edge.tone === "bad" ? styles.bad : undefined]
    .filter((name): name is string => name !== undefined)
    .join(" ");
}

/** One SVG in world px; strokes stay 1.5 CSS px through --tv-inv-k (written at settle). No arrowheads. */
function EdgeLayerView({ layout, layer, selectedKey, onSelectEdge }: EdgeLayerProps): React.JSX.Element {
  const edges = drawnEdges(layout, selectedKey, layer);
  return (
    <svg
      className={styles.edges}
      data-layer={layer}
      width={Math.max(1, layout.bounds.w)}
      height={Math.max(1, layout.bounds.h)}
      aria-hidden="true"
      focusable="false"
    >
      {edges.map(({ edge, d, hop }) => (
        <g key={edge.id} data-edge={edge.id} data-kind={edge.kind}>
          {layer === "over" ? <path className={styles.halo} d={d} /> : null}
          <path className={strokeClass(edge, hop, selectedKey !== null)} d={d} data-stroke="" />
          {edge.kind === "contradicts" ? (
            <path className={styles.hit} d={d} data-hit="contradicts" onClick={() => onSelectEdge(edge)} />
          ) : null}
        </g>
      ))}
      {layer === "under"
        ? layout.junctions.map((point) => (
            <circle key={`${point.x}:${point.y}`} className={styles.junction} cx={point.x} cy={point.y} r={2.5} />
          ))
        : null}
    </svg>
  );
}

/** Memoized: camera gestures (will-change) and the live tick re-render the World without touching the edges. */
export const EdgeLayer = memo(EdgeLayerView);
