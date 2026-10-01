import { canvasXMap, type CanvasFrame, type CanvasLayout } from "../../../layout/canvas-layout.js";
import { LEVEL_SPECS } from "../../../layout/canvas-levels.js";
import type { TimeScale, XMap } from "../../../layout/time-scale.js";
import { brushSeqRange, type Brush, type TraceIndex } from "../../../layout/trace-index.js";
import {
  fitBounds,
  isInsideInset,
  screenToWorld,
  setCenter,
  worldToScreen,
  type Rect,
  type Size,
  type UniformCamera,
  type ZoomLimits,
} from "../../../layout/viewport.js";
import type { Level, TraceSession } from "../../../model/index.js";

export const FIT_PADDING_PX = 48;
export const REVEAL_INSET_PX = 48;
export const FIT_MAX_K = 1;
export const FIT_LEVEL_SWITCH_K = 0.35;
export const SELECTION_MAX_K = 1.5;
export const NEIGHBOR_FIT_MIN_K = 0.75;
export const DEFAULT_CAMERA: UniformCamera = { mode: "uniform", tx: FIT_PADDING_PX, ty: FIT_PADDING_PX, k: 1 };

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function hasArea(viewport: Size): boolean {
  return viewport.w > 0 && viewport.h > 0;
}

function rawFitK(rect: Rect, viewport: Size): number {
  return Math.min(
    (viewport.w - 2 * FIT_PADDING_PX) / Math.max(1, rect.w),
    (viewport.h - 2 * FIT_PADDING_PX) / Math.max(1, rect.h),
  );
}

/** The width-only fit a whole-session show makes (it keeps ty, so height never binds). */
function rawShowK(rect: Rect, viewport: Size): number {
  return (viewport.w - 2 * FIT_PADDING_PX) / Math.max(1, rect.w);
}

function unionRect(rects: readonly Rect[]): Rect {
  const x0 = Math.min(...rects.map((rect) => rect.x));
  const y0 = Math.min(...rects.map((rect) => rect.y));
  const x1 = Math.max(...rects.map((rect) => rect.x + rect.w));
  const y1 = Math.max(...rects.map((rect) => rect.y + rect.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function levelLimits(level: Level): ZoomLimits {
  const spec = LEVEL_SPECS[level];
  return { minK: spec.minZoom, maxK: spec.maxZoom };
}

export type FitPlan = { kind: "switch"; level: "session" } | { kind: "camera"; camera: UniformCamera };

export function planFit(layout: CanvasLayout, viewport: Size): FitPlan | null {
  const bounds = layout.bounds;
  if (!hasArea(viewport) || bounds.w <= 0 || bounds.h <= 0) return null;
  if (layout.level !== "session" && rawFitK(bounds, viewport) < FIT_LEVEL_SWITCH_K) {
    return { kind: "switch", level: "session" };
  }
  const spec = LEVEL_SPECS[layout.level];
  return {
    kind: "camera",
    camera: fitBounds(bounds, viewport, { padding: FIT_PADDING_PX, limits: { minK: spec.minZoom, maxK: FIT_MAX_K } }),
  };
}

export function zoomToSelection(layout: CanvasLayout, frameKey: string, viewport: Size): UniformCamera | null {
  const frame = layout.frameByKey.get(frameKey);
  if (frame === undefined || !hasArea(viewport)) return null;
  const limits = { minK: LEVEL_SPECS[layout.level].minZoom, maxK: SELECTION_MAX_K };
  // "Rest-edge neighbors" (spec §7.5) excludes the trunk: it is drawn at rest too, but its ends are the first and last
  // story frames of a whole turn, so following it would fit the turn rather than the selection's own relations.
  const neighbors = layout.edges
    .filter((edge) => edge.rest && edge.kind !== "trunk" && (edge.from === frameKey || edge.to === frameKey))
    .map((edge) => layout.frameByKey.get(edge.from === frameKey ? edge.to : edge.from))
    .filter((other): other is CanvasFrame => other !== undefined);
  if (neighbors.length > 0) {
    const union = unionRect([frame.card, ...neighbors.map((other) => other.card)]);
    if (rawFitK(union, viewport) >= NEIGHBOR_FIT_MIN_K) {
      return fitBounds(union, viewport, { padding: FIT_PADDING_PX, limits });
    }
  }
  return fitBounds(frame.card, viewport, { padding: FIT_PADDING_PX, limits });
}

export function revealCamera(camera: UniformCamera, card: Rect, viewport: Size): UniformCamera | null {
  if (!hasArea(viewport) || isInsideInset(camera, card, viewport, REVEAL_INSET_PX)) return null;
  return setCenter(camera, { x: card.x + card.w / 2, y: card.y + card.h / 2 }, viewport);
}

export function pinFrameCamera(camera: UniformCamera, before: Rect, after: Rect, limits: ZoomLimits): UniformCamera {
  const screen = worldToScreen(camera, { x: before.x, y: before.y });
  const k = clamp(camera.k, limits.minK, limits.maxK);
  return { mode: "uniform", k, tx: screen.x - after.x * k, ty: screen.y - after.y * k };
}

export function intersectsViewport(camera: UniformCamera, rect: Rect, viewport: Size): boolean {
  const a = worldToScreen(camera, { x: rect.x, y: rect.y });
  const b = worldToScreen(camera, { x: rect.x + rect.w, y: rect.y + rect.h });
  return b.x > 0 && a.x < viewport.w && b.y > 0 && a.y < viewport.h;
}

export function nearestFrameToCenter(layout: CanvasLayout, camera: UniformCamera, viewport: Size): CanvasFrame | undefined {
  const center = screenToWorld(camera, { x: viewport.w / 2, y: viewport.h / 2 });
  let best: CanvasFrame | undefined;
  let bestDistance = Infinity;
  for (const frame of layout.frames) {
    const distance = Math.hypot(frame.card.x + frame.card.w / 2 - center.x, frame.card.y + frame.card.h / 2 - center.y);
    if (distance < bestDistance) {
      best = frame;
      bestDistance = distance;
    }
  }
  return best;
}

export function focusFrame(
  layout: CanvasLayout,
  camera: UniformCamera,
  viewport: Size,
  selected: CanvasFrame | undefined,
): CanvasFrame | undefined {
  if (selected !== undefined && hasArea(viewport) && intersectsViewport(camera, selected.card, viewport)) return selected;
  return nearestFrameToCenter(layout, camera, viewport);
}

export function frontierFollowCamera(layout: CanvasLayout, camera: UniformCamera, viewport: Size): UniformCamera | null {
  const column = layout.columns[layout.columns.length - 1];
  if (column === undefined || !hasArea(viewport)) return null;
  const right = column.x + LEVEL_SPECS[layout.level].w;
  const limit = viewport.w - REVEAL_INSET_PX;
  if (right * camera.k + camera.tx <= limit) return null;
  // A viewport narrower than the column plus the inset cannot show it whole: keep its left edge at the inset
  // instead of panning that edge off screen, and ask for no further pan once it sits there.
  const tx = Math.max(limit - right * camera.k, REVEAL_INSET_PX - column.x * camera.k);
  return Math.abs(tx - camera.tx) < 1e-6 ? null : { ...camera, tx };
}

export function framesAhead(layout: CanvasLayout, camera: UniformCamera, viewport: Size): number {
  if (!hasArea(viewport)) return 0;
  return layout.frames.filter((frame) => frame.card.x * camera.k + camera.tx >= viewport.w).length;
}

export function columnXAt(layout: CanvasLayout, t: number): number {
  let x = layout.bounds.x;
  for (const column of layout.columns) {
    if (column.t0 > t) break;
    x = column.x;
  }
  return x;
}

export interface ShowCameraInput {
  layout: CanvasLayout;
  session: TraceSession;
  index: TraceIndex;
  brush: Brush;
  camera: UniformCamera;
  viewport: Size;
  selectionCard: Rect | null;
}

export function showCamera(input: ShowCameraInput): UniformCamera | null {
  const { layout, viewport } = input;
  if (!hasArea(viewport) || layout.frames.length === 0) return null;
  const spec = LEVEL_SPECS[layout.level];
  let x0 = layout.bounds.x;
  let x1 = layout.bounds.x + layout.bounds.w;
  if (input.brush.kind !== "session") {
    const { fromSeq, toSeq } = brushSeqRange(input.brush, input.index);
    const first = input.session.steps[input.index.stepIndexAtOrAfter(fromSeq)];
    const last = input.session.steps[input.index.stepIndexAtOrBefore(toSeq)];
    if (first !== undefined && last !== undefined && first.firstSeq <= last.firstSeq) {
      x0 = columnXAt(layout, first.tMs);
      x1 = Math.max(columnXAt(layout, last.tMs), x0) + spec.w;
    }
  }
  const k = clamp((viewport.w - 2 * FIT_PADDING_PX) / Math.max(1, x1 - x0), spec.minZoom, SELECTION_MAX_K);
  const fitted: UniformCamera = {
    mode: "uniform",
    k,
    tx: (viewport.w - (x1 - x0) * k) / 2 - x0 * k,
    ty: input.camera.ty,
  };
  const revealed = input.selectionCard === null ? null : revealCamera(fitted, input.selectionCard, viewport);
  return revealed ?? fitted;
}

export type ShowPlan = { kind: "switch"; level: "session" } | { kind: "camera"; camera: UniformCamera };

/**
 * The open (show) path of the Fit rule (spec §7.5, §7.8 rule 3): a whole-session show at Chapter or Step whose raw
 * fit falls below FIT_LEVEL_SWITCH_K switches to Session first, as planFit does, so the cards never open icon-only.
 * A brushed show keeps the level the person chose.
 */
export function planShow(input: ShowCameraInput): ShowPlan | null {
  const { layout, viewport } = input;
  if (!hasArea(viewport) || layout.frames.length === 0) return null;
  if (layout.level !== "session" && input.brush.kind === "session" && rawShowK(layout.bounds, viewport) < FIT_LEVEL_SWITCH_K) {
    return { kind: "switch", level: "session" };
  }
  const camera = showCamera(input);
  return camera === null ? null : { kind: "camera", camera };
}

export interface BrushWindowInput {
  layout: CanvasLayout;
  scale: TimeScale;
  session: TraceSession;
  camera: UniformCamera;
  viewport: Size;
}

export function brushForWindow(input: BrushWindowInput): Brush | null {
  const { camera, viewport, session } = input;
  if (!hasArea(viewport)) return null;
  const map = canvasXMap(input.layout, input.scale);
  // Both binary searches need session.steps sorted by tMs: steps are in seq order and Step.tMs never decreases with
  // seq (the display clock, spec §6.5).
  const t0 = map.tOf(screenToWorld(camera, { x: 0, y: 0 }).x);
  const t1 = map.tOf(screenToWorld(camera, { x: viewport.w, y: 0 }).x);
  const steps = session.steps;
  let lo = 0;
  let hi = steps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((steps[mid]?.tMs ?? Infinity) < t0) lo = mid + 1;
    else hi = mid;
  }
  const first = lo;
  lo = 0;
  hi = steps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((steps[mid]?.tMs ?? Infinity) <= t1) lo = mid + 1;
    else hi = mid;
  }
  const last = lo - 1;
  const from = steps[first];
  const to = steps[last];
  if (from === undefined || to === undefined || first > last) return null;
  return { kind: "range", fromSeq: from.firstSeq, toSeq: to.lastSeq };
}

export function screenXMap(map: XMap, camera: UniformCamera): XMap {
  return {
    xOf: (tMs) => map.xOf(tMs) * camera.k + camera.tx,
    tOf: (x) => map.tOf((x - camera.tx) / camera.k),
  };
}

export interface CameraStore {
  get(): UniformCamera;
  set(camera: UniformCamera): void;
  subscribe(listener: () => void): () => void;
}

/** Holds the live camera outside React so per-frame writes reach only the ruler, minimap and badge. */
export function createCameraStore(initial: UniformCamera): CameraStore {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (camera) => {
      if (camera.tx === current.tx && camera.ty === current.ty && camera.k === current.k) return;
      current = camera;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
