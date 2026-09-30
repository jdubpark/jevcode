import type { CanvasLayout } from "./canvas-layout.js";
import type { Point, Rect } from "./viewport.js";

export const MINIMAP_W = 140;
export const MINIMAP_H = 84;
export const MINIMAP_STRIP_H = 3;
export const MINIMAP_MIN_SCALE = 0.03;

export type MinimapSource = Pick<CanvasLayout, "bounds" | "frames" | "edges" | "separators">;

export interface MinimapModel {
  scale: number;
  origin: Point;
  /** World x-window shown when s · bounds.w > 140; null when the whole session fits. */
  window: { x0: number; x1: number } | null;
  frames: readonly { key: string; rect: Rect; mark: "frame" | "selected" | "critical" | "noise" }[];
  edges: readonly { d: string }[];
  separators: readonly { x: number }[];
  viewport: Rect;
  strip: { bracket: readonly [number, number]; critical: readonly number[] } | null;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** Spec §7.5 "Minimap": everything derives from the layout; holes are not drawn. */
export function buildMinimap(
  layout: MinimapSource,
  input: { viewportWorld: Rect; selectedKey: string | null; criticalKeys: ReadonlySet<string> },
): MinimapModel {
  const bounds = layout.bounds;
  const fitW = bounds.w > 0 ? MINIMAP_W / bounds.w : 1;
  const fitH = bounds.h > 0 ? MINIMAP_H / bounds.h : 1;
  const scale = Math.max(Math.min(fitW, fitH), MINIMAP_MIN_SCALE);
  let window: MinimapModel["window"] = null;
  if (scale * bounds.w > MINIMAP_W) {
    const span = MINIMAP_W / scale;
    const center = input.viewportWorld.x + input.viewportWorld.w / 2;
    const x0 = clamp(center - span / 2, bounds.x, bounds.x + bounds.w - span);
    window = { x0, x1: x0 + span };
  }
  const origin: Point = { x: window === null ? bounds.x : window.x0, y: bounds.y };
  const toMini = (rect: Rect): Rect => ({
    x: (rect.x - origin.x) * scale,
    y: (rect.y - origin.y) * scale,
    w: rect.w * scale,
    h: rect.h * scale,
  });
  const visible = (x0: number, x1: number): boolean => window === null || (x1 >= window.x0 && x0 <= window.x1);
  const frames = layout.frames
    .filter((frame) => visible(frame.card.x, frame.card.x + frame.card.w))
    .map((frame) => ({
      key: frame.key,
      rect: toMini(frame.card),
      mark:
        frame.key === input.selectedKey
          ? ("selected" as const)
          : input.criticalKeys.has(frame.key)
            ? ("critical" as const)
            : frame.kind === "noise"
              ? ("noise" as const)
              : ("frame" as const),
    }));
  const edges = layout.edges
    .filter((edge) => edge.kind === "contradicts" && edge.rest && edge.d !== null)
    .map((edge) => ({ d: edge.d ?? "" }));
  const separators = layout.separators
    .filter((sep) => sep.kind === "turn" && visible(sep.x, sep.x))
    .map((sep) => ({ x: (sep.x - origin.x) * scale }));
  const strip =
    window === null || bounds.w <= 0
      ? null
      : {
          bracket: [
            ((window.x0 - bounds.x) / bounds.w) * MINIMAP_W,
            ((window.x1 - bounds.x) / bounds.w) * MINIMAP_W,
          ] as const,
          critical: layout.frames
            .filter((frame) => input.criticalKeys.has(frame.key))
            .map((frame) => ((frame.card.x + frame.card.w / 2 - bounds.x) / bounds.w) * MINIMAP_W),
        };
  return { scale, origin, window, frames, edges, separators, viewport: toMini(input.viewportWorld), strip };
}

export function minimapToWorld(model: MinimapModel, point: Point): Point {
  return { x: model.origin.x + point.x / model.scale, y: model.origin.y + point.y / model.scale };
}
