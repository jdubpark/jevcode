export interface Point { x: number; y: number }
export interface Size { w: number; h: number }
export interface Rect { x: number; y: number; w: number; h: number }
export interface UniformCamera { mode: "uniform"; tx: number; ty: number; k: number }
export interface XOnlyCamera { mode: "xOnly"; u0: number; k: number }
export type Camera = UniformCamera | XOnlyCamera;
export interface ZoomLimits { minK: number; maxK: number }

export const TWEEN_MS = 180;
export const WHEEL_ZOOM_RATE = 0.02;
export const WHEEL_ZOOM_MIN = 0.8;
export const WHEEL_ZOOM_MAX = 1.25;
export const WHEEL_LINE_PX = 16;
/** Uniform clamp: at least this many screen px of content stay inside the viewport. */
export const CLAMP_KEEP_PX = 64;
/** xOnly clamp: the visible range may run this many screen px past either end of the content. */
export const CLAMP_PAD_PX = 24;

const clamp = (lo: number, hi: number, value: number): number => Math.min(hi, Math.max(lo, value));
const clampK = (k: number, limits: ZoomLimits): number => clamp(limits.minK, limits.maxK, k);

/** screen = world · k + t */
export function worldToScreen(camera: UniformCamera, world: Point): Point {
  return { x: world.x * camera.k + camera.tx, y: world.y * camera.k + camera.ty };
}

export function screenToWorld(camera: UniformCamera, screen: Point): Point {
  return { x: (screen.x - camera.tx) / camera.k, y: (screen.y - camera.ty) / camera.k };
}

/** x = (u − u0) · k */
export function uToScreenX(camera: XOnlyCamera, u: number): number {
  return (u - camera.u0) * camera.k;
}

export function screenXToU(camera: XOnlyCamera, x: number): number {
  return x / camera.k + camera.u0;
}

/** Keeps the world point (uniform) or u (xOnly) under `anchor` fixed; k clamped to limits. */
export function zoomAt<C extends Camera>(camera: C, anchor: Point, factor: number, limits: ZoomLimits): C {
  const cam = camera as Camera;
  const k = clampK(cam.k * factor, limits);
  if (cam.mode === "uniform") {
    const world = screenToWorld(cam, anchor);
    return { mode: "uniform", k, tx: anchor.x - world.x * k, ty: anchor.y - world.y * k } as C;
  }
  const u = screenXToU(cam, anchor.x);
  return { mode: "xOnly", k, u0: u - anchor.x / k } as C;
}

/** xOnly ignores dy. */
export function panBy<C extends Camera>(camera: C, dx: number, dy: number): C {
  const cam = camera as Camera;
  if (cam.mode === "uniform") return { ...cam, tx: cam.tx + dx, ty: cam.ty + dy } as C;
  return { ...cam, u0: cam.u0 - dx / cam.k } as C;
}

export function fitBounds(bounds: Rect, viewport: Size, options: { padding: number; limits: ZoomLimits }): UniformCamera {
  const availW = Math.max(0, viewport.w - 2 * options.padding);
  const availH = Math.max(0, viewport.h - 2 * options.padding);
  const kx = bounds.w > 0 ? availW / bounds.w : Number.POSITIVE_INFINITY;
  const ky = bounds.h > 0 ? availH / bounds.h : Number.POSITIVE_INFINITY;
  const raw = Math.min(kx, ky);
  const k = clampK(Number.isFinite(raw) ? raw : options.limits.maxK, options.limits);
  return {
    mode: "uniform",
    k,
    tx: (viewport.w - bounds.w * k) / 2 - bounds.x * k,
    ty: (viewport.h - bounds.h * k) / 2 - bounds.y * k,
  };
}

export function fitRange(u0: number, u1: number, widthPx: number, options: { padFraction: number; limits: ZoomLimits }): XOnlyCamera {
  const span = Math.max(u1 - u0, 1e-9);
  const width = Math.max(0, widthPx);
  const k = Math.max(1e-12, clampK(width / (span * (1 + 2 * options.padFraction)), options.limits));
  return { mode: "xOnly", k, u0: (u0 + u1) / 2 - width / (2 * k) };
}

/** Centers `world` at the current k. */
export function setCenter(camera: UniformCamera, world: Point, viewport: Size): UniformCamera {
  return { ...camera, tx: viewport.w / 2 - world.x * camera.k, ty: viewport.h / 2 - world.y * camera.k };
}

/** Clamps k to limits (keeping the viewport center) and translation so `content` stays reachable. */
export function clampCamera<C extends Camera>(camera: C, content: Rect, viewport: Size, limits: ZoomLimits): C {
  const cam = camera as Camera;
  const k = clampK(cam.k, limits);
  if (cam.mode === "uniform") {
    const center = screenToWorld(cam, { x: viewport.w / 2, y: viewport.h / 2 });
    const tx0 = viewport.w / 2 - center.x * k;
    const ty0 = viewport.h / 2 - center.y * k;
    const mx = Math.max(0, Math.min(CLAMP_KEEP_PX, content.w * k, viewport.w));
    const my = Math.max(0, Math.min(CLAMP_KEEP_PX, content.h * k, viewport.h));
    const tx = clamp(mx - (content.x + content.w) * k, viewport.w - mx - content.x * k, tx0);
    const ty = clamp(my - (content.y + content.h) * k, viewport.h - my - content.y * k, ty0);
    return { mode: "uniform", k, tx, ty } as C;
  }
  const centerU = cam.u0 + viewport.w / 2 / cam.k;
  const u0 = centerU - viewport.w / (2 * k);
  const pad = CLAMP_PAD_PX / k;
  const lo = content.x - pad;
  const hi = content.x + content.w + pad - viewport.w / k;
  if (hi < lo) return { mode: "xOnly", k, u0: content.x + content.w / 2 - viewport.w / (2 * k) } as C;
  return { mode: "xOnly", k, u0: clamp(lo, hi, u0) } as C;
}

/** True when `rect` (world) lies inside the viewport inset by `inset` px. */
export function isInsideInset(camera: UniformCamera, rect: Rect, viewport: Size, inset: number): boolean {
  const tl = worldToScreen(camera, { x: rect.x, y: rect.y });
  const br = worldToScreen(camera, { x: rect.x + rect.w, y: rect.y + rect.h });
  return tl.x >= inset && tl.y >= inset && br.x <= viewport.w - inset && br.y <= viewport.h - inset;
}

export function easeOutCubic(t: number): number {
  const c = clamp(0, 1, t);
  return 1 - (1 - c) ** 3;
}

/** t ∈ [0, 1]; translation linear in eased t, k geometric. */
export function tweenCamera<C extends Camera>(from: C, to: C, t: number): C {
  if (t <= 0) return from;
  if (t >= 1) return to;
  const a = from as Camera;
  const b = to as Camera;
  const e = easeOutCubic(t);
  const k = a.k * (b.k / a.k) ** e;
  if (a.mode === "uniform" && b.mode === "uniform") {
    return { mode: "uniform", k, tx: a.tx + (b.tx - a.tx) * e, ty: a.ty + (b.ty - a.ty) * e } as C;
  }
  if (a.mode === "xOnly" && b.mode === "xOnly") return { mode: "xOnly", k, u0: a.u0 + (b.u0 - a.u0) * e } as C;
  return to;
}

/** 2^(−deltaY · 0.02), line mode ×16, page mode ×viewportHeight, clamped to [0.8, 1.25]. */
export function wheelZoomFactor(deltaY: number, deltaMode: 0 | 1 | 2, pageHeight: number): number {
  const px = deltaMode === 1 ? deltaY * WHEEL_LINE_PX : deltaMode === 2 ? deltaY * pageHeight : deltaY;
  return clamp(WHEEL_ZOOM_MIN, WHEEL_ZOOM_MAX, 2 ** (-px * WHEEL_ZOOM_RATE));
}
