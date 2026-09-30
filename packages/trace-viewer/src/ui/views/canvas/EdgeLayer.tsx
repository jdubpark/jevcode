import { memo } from "react";
import type React from "react";

import type { CanvasLayout } from "../../../layout/canvas-layout.js";
import { directPath, type CanvasEdge } from "../../../layout/canvas-routes.js";
import type { CullRange } from "./World.js";
import styles from "./World.module.css";

export interface DrawnEdge {
  edge: CanvasEdge;
  d: string;
  hop: boolean;
}

const extentCache = new WeakMap<CanvasLayout, ReadonlyMap<string, readonly [number, number]>>();

/**
 * The x-extent of an absolute M/L/H/V/C/Q path over every end and control point: a Bézier lies inside its control
 * hull, so this contains the drawn stroke. null for a path with no x.
 */
export function pathXExtent(d: string): readonly [number, number] | null {
  let x0 = Infinity;
  let x1 = -Infinity;
  let command = "M";
  let index = 0;
  for (const token of d.match(/[MLHVCQ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []) {
    if (/^[MLHVCQ]$/i.test(token)) {
      command = token.toUpperCase();
      index = 0;
      continue;
    }
    // H takes x only; V takes y only; M, L, C and Q take (x, y) pairs.
    const isX = command === "H" || (command !== "V" && index % 2 === 0);
    index += 1;
    if (!isX) continue;
    const x = Number(token);
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
  }
  return x0 <= x1 ? [x0, x1] : null;
}

/**
 * Each routed edge's world x-extent, from its path, once per layout. Not from its from/to cards: a trunk's ends follow
 * placement order, not its extremes (C3a hand-off), and rails may run left of both cards.
 */
export function edgeExtents(layout: CanvasLayout): ReadonlyMap<string, readonly [number, number]> {
  const cached = extentCache.get(layout);
  if (cached !== undefined) return cached;
  const out = new Map<string, readonly [number, number]>();
  for (const edge of layout.edges) {
    const extent = edge.d === null ? null : pathXExtent(edge.d);
    if (extent !== null) out.set(edge.id, extent);
  }
  extentCache.set(layout, out);
  return out;
}

/**
 * Rest edges plus the selection's one-hop edges. "over" holds the lifted paths drawn above the frames with a halo:
 * `shape: "direct"` (the contradicts fallback) and the selection's lane-less edges (`d: null`, spec §7.5) via directPath.
 */
export function drawnEdges(
  layout: CanvasLayout,
  selectedKey: string | null,
  layer: "under" | "over",
  cullRange: CullRange | null = null,
): DrawnEdge[] {
  const out: DrawnEdge[] = [];
  const extents = cullRange === null ? null : edgeExtents(layout);
  for (const edge of layout.edges) {
    // A trunk's from/to are only its first and last placed story frames, not relations of the selection: it never
    // turns accent, it dims like any other edge (canvas-camera's zoomToSelection skips it the same way).
    const hop =
      selectedKey !== null && edge.kind !== "trunk" && (edge.from === selectedKey || edge.to === selectedKey);
    if (!edge.rest && !hop) continue;
    // Spike risk 2 ruling: an edge wholly outside the cull range is not mounted; the selection's edges always are.
    const extent = extents?.get(edge.id);
    if (cullRange !== null && !hop && extent !== undefined && (extent[1] < cullRange.x0 || extent[0] > cullRange.x1)) continue;
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
  /** World x range to draw (CULL_FRAMES); null draws every edge. */
  cullRange?: CullRange | null;
  onSelectEdge(edge: CanvasEdge): void;
}

function dimClass(hop: boolean, selecting: boolean): string | undefined {
  return hop ? undefined : selecting ? styles.dim : undefined;
}

function strokeClass(edge: CanvasEdge, hop: boolean, selecting: boolean): string {
  return [styles.edge, hop ? styles.hop : dimClass(hop, selecting), edge.tone === "bad" ? styles.bad : undefined]
    .filter((name): name is string => name !== undefined)
    .join(" ");
}

/** One SVG in world px; strokes stay 1.5 CSS px through --tv-inv-k (written at settle). No arrowheads. */
function EdgeLayerView({ layout, layer, selectedKey, cullRange = null, onSelectEdge }: EdgeLayerProps): React.JSX.Element {
  const edges = drawnEdges(layout, selectedKey, layer, cullRange);
  const junctions =
    layer !== "under"
      ? []
      : cullRange === null
        ? layout.junctions
        : layout.junctions.filter((point) => point.x >= cullRange.x0 && point.x <= cullRange.x1);
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
          {layer === "over" ? <path className={[styles.halo, dimClass(hop, selectedKey !== null)].filter(Boolean).join(" ")} d={d} /> : null}
          <path className={strokeClass(edge, hop, selectedKey !== null)} d={d} data-stroke="" />
          {edge.kind === "contradicts" ? (
            <path className={styles.hit} d={d} data-hit="contradicts" onClick={() => onSelectEdge(edge)} />
          ) : null}
        </g>
      ))}
      {junctions.map((point, index) => (
        <circle key={`${index}:${point.x}:${point.y}`} className={styles.junction} cx={point.x} cy={point.y} r={2.5} />
      ))}
    </svg>
  );
}

/** Memoized: the live tick and selection-independent World renders never touch the edges. */
export const EdgeLayer = memo(EdgeLayerView);
