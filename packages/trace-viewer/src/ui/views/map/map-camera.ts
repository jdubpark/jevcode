import { layoutMap, mapLevelForZoom, type MapCard, type MapLayout, type MapLayoutState, type MapLevel } from "../../../layout/map-layout.js";
import { isInsideInset, screenToWorld, setCenter, type Point, type Size, type UniformCamera, type ZoomLimits } from "../../../layout/viewport.js";
import type { OverviewModel } from "../../../model/index.js";

export const MAP_LIMITS: ZoomLimits = { minK: 0.1, maxK: 2 };

/**
 * Gesture limits: MAP_LIMITS, with the floor lowered to the Fit zoom when Fit needs less than 10% (a band of 200
 * cards), so Fit always shows the whole map and zooming out never jumps past it.
 */
export function mapZoomLimits(fitK: number | null): ZoomLimits {
  return fitK === null || fitK >= MAP_LIMITS.minK ? MAP_LIMITS : { minK: fitK, maxK: MAP_LIMITS.maxK };
}
/** Fit leaves 20 px at the sides and the top and 68 px at the bottom, which clears the zoom bar (revised Map mockup). */
export const MAP_FIT_PADDING = { x: 20, top: 20, bottom: 68 } as const;
export const MAP_REVEAL_INSET_PX = 48;
/** Below this zoom card names hide and only the footer icon and bar show (spec alignment note 7). */
export const MAP_ICON_ONLY_K = 0.48;
export const MAP_ZOOM_PRESETS = [
  { id: "fit", label: "Fit" },
  { id: "100", label: "100%" },
] as const;

export interface MapFitPlan { level: MapLevel; camera: UniformCamera; layout: MapLayout }

/**
 * Fit (spec §3.4): the whole map, centered on both axes, filling the stage up to 100%. The geometry is the same at
 * every level, so there is one layout; `level` is the zoom band the fit lands in. k stays at or below 1, so the level
 * is chip or card, never detail.
 */
export function planMapFit(overview: OverviewModel, viewport: Size, prev?: MapLayoutState): MapFitPlan | null {
  const availW = viewport.w - 2 * MAP_FIT_PADDING.x;
  const availH = viewport.h - MAP_FIT_PADDING.top - MAP_FIT_PADDING.bottom;
  if (availW <= 0 || availH <= 0) return null;
  const laid = layoutMap(overview, { level: "card" }, prev);
  const { w, h } = laid.bounds;
  if (w <= 0 || h <= 0) return null;
  const k = Math.min(availW / w, availH / h, 1);
  const level = mapLevelForZoom(k);
  return {
    level,
    layout: { ...laid, level },
    camera: { mode: "uniform", k, tx: (viewport.w - w * k) / 2, ty: MAP_FIT_PADDING.top + (availH - h * k) / 2 },
  };
}

export function cardCenter(card: MapCard): Point {
  return { x: card.x + card.w / 2, y: card.y + card.h / 2 };
}

/** null when the card is inside the view inset by MAP_REVEAL_INSET_PX; else the camera that centers it. */
export function revealCamera(camera: UniformCamera, card: MapCard, viewport: Size): UniformCamera | null {
  if (viewport.w <= 0 || viewport.h <= 0) return null;
  if (isInsideInset(camera, card, viewport, MAP_REVEAL_INSET_PX)) return null;
  return setCenter(camera, cardCenter(card), viewport);
}

/** The camera at zoom k that puts `world` at `screen`. */
export function anchoredCamera(k: number, world: Point, screen: Point): UniformCamera {
  return { mode: "uniform", k, tx: screen.x - world.x * k, ty: screen.y - world.y * k };
}

export function zoomedAtCenter(camera: UniformCamera, k: number, viewport: Size): UniformCamera {
  const center = { x: viewport.w / 2, y: viewport.h / 2 };
  return anchoredCamera(k, screenToWorld(camera, center), center);
}
