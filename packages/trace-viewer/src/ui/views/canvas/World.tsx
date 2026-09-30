import { memo, useMemo } from "react";
import type React from "react";

import type { CanvasFrame, CanvasLayout } from "../../../layout/canvas-layout.js";
import type { CanvasEdge } from "../../../layout/canvas-routes.js";
import type { Level } from "../../../model/index.js";
import type { Tool } from "../../state/view-state.js";
import { EdgeLayer } from "./EdgeLayer.js";
import { Frame } from "./Frame.js";
import { frameRunning, type FrameContext } from "./frame-label.js";
import styles from "./World.module.css";

export interface CullRange {
  x0: number;
  x1: number;
}

export interface WorldProps {
  layout: CanvasLayout | null;
  ctx: FrameContext | null;
  level: Level;
  /** Frame key of the selection. */
  selectedKey: string | null;
  expanded: ReadonlySet<string>;
  /** Gesture-time will-change (R17). */
  gesturing: boolean;
  tool: Tool;
  /** Spike risk 2 ruling (CULL_FRAMES): world x range to draw; null draws every frame. */
  cullRange: CullRange | null;
  viewportRef: React.Ref<HTMLDivElement>;
  worldRef: React.Ref<HTMLDivElement>;
  overlay: React.ReactNode;
  /**
   * The source's now() on the 1 Hz live tick. Only frames with a running step receive it, so the tick re-renders
   * those frames alone (C3-6 hand-off). Keep onSelect and onToggle stable for the same reason.
   */
  nowMs?: number | null;
  onSelect(frame: CanvasFrame): void;
  onToggle(frame: CanvasFrame): void;
  onSelectEdge(edge: CanvasEdge): void;
}

/**
 * Spike risk 2 ruling: frames whose card overlaps [x0, x1], by binary search on x. Frames are in column order and share
 * one width per level, so card edges are non-decreasing.
 */
export function cullFrames(frames: readonly CanvasFrame[], range: CullRange | null): readonly CanvasFrame[] {
  if (range === null) return frames;
  let lo = 0;
  let hi = frames.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const frame = frames[mid];
    if (frame !== undefined && frame.card.x + frame.card.w < range.x0) lo = mid + 1;
    else hi = mid;
  }
  const out: CanvasFrame[] = [];
  for (let i = lo; i < frames.length; i += 1) {
    const frame = frames[i];
    if (frame === undefined || frame.card.x > range.x1) break;
    out.push(frame);
  }
  return out;
}

/** Focuses the frame element for `key` with preventScroll; false when it is not in the DOM. */
export function focusFrameElement(root: ParentNode, key: string): boolean {
  for (const element of root.querySelectorAll<HTMLElement>('[role="group"][data-key]')) {
    if (element.dataset.key !== key) continue;
    element.focus({ preventScroll: true });
    return true;
  }
  return false;
}

/** The culled frames plus the selection and the tab stop, which stay mounted (focus and roving), in time order. */
function mountedFrames(
  layout: CanvasLayout,
  order: ReadonlyMap<string, number>,
  range: CullRange | null,
  keep: readonly (string | null)[],
): readonly CanvasFrame[] {
  const culled = cullFrames(layout.frames, range);
  if (culled === layout.frames) return culled;
  const extra: CanvasFrame[] = [];
  for (const key of keep) {
    const frame = key === null ? undefined : layout.frameByKey.get(key);
    if (frame !== undefined && !culled.includes(frame) && !extra.includes(frame)) extra.push(frame);
  }
  if (extra.length === 0) return culled;
  return [...culled, ...extra].sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
}

function WorldView(props: WorldProps): React.JSX.Element {
  const { layout, ctx, selectedKey, nowMs } = props;
  const order = useMemo(() => new Map(layout?.frames.map((frame, i) => [frame.key, i]) ?? []), [layout]);
  // Per (layout, ctx): which frames the live tick must reach.
  const running = useMemo(
    () => new Set(layout === null || ctx === null ? [] : layout.frames.filter((frame) => frameRunning(frame, ctx)).map((frame) => frame.key)),
    [layout, ctx],
  );
  const focusKey =
    layout !== null && selectedKey !== null && layout.frameByKey.has(selectedKey) ? selectedKey : (layout?.frames[0]?.key ?? null);
  const frames = layout === null ? [] : mountedFrames(layout, order, props.cullRange, [selectedKey, focusKey]);
  return (
    <div
      ref={props.viewportRef}
      className={styles.viewport}
      data-tv-viewport="canvas"
      data-pannable=""
      data-zoom-band="full"
      data-tool={props.tool}
      onScroll={(event) => {
        // overflow: hidden still scrolls on focus; the camera is the only way to move.
        event.currentTarget.scrollLeft = 0;
        event.currentTarget.scrollTop = 0;
      }}
    >
      <div
        ref={props.worldRef}
        className={styles.world}
        data-tv-world=""
        style={{ willChange: props.gesturing ? "transform" : undefined }}
      >
        {layout === null || ctx === null ? null : (
          <>
            {layout.separators.map((sep) => (
              <div
                key={`${sep.kind}:${sep.x}`}
                className={styles.separator}
                data-sep={sep.kind}
                aria-hidden="true"
                style={{ left: sep.x, height: Math.max(1, layout.bounds.h) }}
              />
            ))}
            <EdgeLayer layout={layout} layer="under" selectedKey={selectedKey} onSelectEdge={props.onSelectEdge} />
            {frames.map((frame) => (
              <Frame
                key={frame.key}
                frame={frame}
                level={props.level}
                ctx={ctx}
                selected={frame.key === selectedKey}
                focusTarget={frame.key === focusKey}
                expanded={props.expanded.has(frame.key) || props.expanded.has(frame.selId)}
                nowMs={running.has(frame.key) ? nowMs : undefined}
                onSelect={props.onSelect}
                onToggle={props.onToggle}
              />
            ))}
            <EdgeLayer layout={layout} layer="over" selectedKey={selectedKey} onSelectEdge={props.onSelectEdge} />
          </>
        )}
      </div>
      {props.overlay}
    </div>
  );
}

/** Viewport (camera custom properties, zoom band, scroll guard) holding the transformed world and the overlay. */
export const World = memo(WorldView);
