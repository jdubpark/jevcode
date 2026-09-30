import { computeTicks, type BreakMark, type Tick } from "../../../layout/ticks.js";
import type { TimeScale, XMap } from "../../../layout/time-scale.js";
import { formatOffset } from "../../../model/index.js";

/** Target spacing of ruler labels (the mockup labels every 15 s at about 120-250 px). */
export const RULER_LABEL_GAP_PX = 120;
/** Minimum spacing of the fine unlabeled ticks between labels. */
export const RULER_MINOR_GAP_PX = 8;

/**
 * Ruler ticks for any XMap: labels about 120 px apart (the first §7.4 step at least that wide), plus fine unlabeled
 * ticks at the finest step that divides the label step and stays ≥ 8 px apart. computeTicks does both, so no tick
 * falls inside a break and the step list is the spec's.
 */
export function rulerTicks(map: XMap, scale: TimeScale, range: { x0: number; x1: number }): { ticks: Tick[]; breaks: BreakMark[] } {
  return computeTicks(map, scale, range, { labelGapPx: RULER_LABEL_GAP_PX, minorGapPx: RULER_MINOR_GAP_PX });
}

/** "0:15", "1:02:03": the ruler reads as a clock, so its labels drop formatOffset's plus sign. */
export function rulerLabel(tMs: number): string {
  return formatOffset(tMs).replace(/^\+/u, "");
}
