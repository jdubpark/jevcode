import { computeTicks, MIN_TICK_LABEL_GAP_PX, type BreakMark, type Tick } from "../../../layout/ticks.js";
import type { TimeScale, XMap } from "../../../layout/time-scale.js";
import { formatOffset } from "../../../model/index.js";

/** Target spacing of ruler labels (the mockup labels every 15 s at about 120-250 px). */
export const RULER_LABEL_GAP_PX = 120;
/** Minimum spacing of the fine unlabeled ticks between labels. */
export const RULER_MINOR_GAP_PX = 8;

/** The XMap stretched by `f`: computeTicks, which keeps labels ≥ 64 px apart, then spaces them ≥ 64 / f real px. */
function stretched(map: XMap, f: number): XMap {
  return { xOf: (t) => map.xOf(t) * f, tOf: (x) => map.tOf(x / f) };
}

function ticksAtGap(map: XMap, scale: TimeScale, range: { x0: number; x1: number }, gapPx: number): { ticks: Tick[]; breaks: BreakMark[] } {
  const f = MIN_TICK_LABEL_GAP_PX / gapPx;
  const { ticks, breaks } = computeTicks(stretched(map, f), scale, { x0: range.x0 * f, x1: range.x1 * f });
  return {
    ticks: ticks.map((tick) => ({ tMs: tick.tMs, x: tick.x / f, labeled: tick.labeled })),
    breaks: breaks.map((mark) => ({ x0: mark.x0 / f, x1: mark.x1 / f, ms: mark.ms })),
  };
}

/**
 * Ruler ticks for any XMap: labels about 120 px apart (never under 64 px), plus fine unlabeled ticks at the largest
 * step that divides the label step and stays ≥ 8 px apart. Both passes reuse computeTicks (§7.4), so no tick falls
 * inside a break and the step list is the spec's.
 */
export function rulerTicks(map: XMap, scale: TimeScale, range: { x0: number; x1: number }): { ticks: Tick[]; breaks: BreakMark[] } {
  const major = ticksAtGap(map, scale, range, RULER_LABEL_GAP_PX);
  const minor = ticksAtGap(map, scale, range, RULER_MINOR_GAP_PX).ticks;
  let minorStep = Number.POSITIVE_INFINITY;
  for (let i = 1; i < minor.length; i += 1) minorStep = Math.min(minorStep, (minor[i]?.tMs ?? 0) - (minor[i - 1]?.tMs ?? 0));
  const aligned = Number.isFinite(minorStep) && major.ticks.every((tick) => tick.tMs % minorStep === 0);
  const byT = new Map<number, Tick>();
  if (aligned) for (const tick of minor) byT.set(tick.tMs, { tMs: tick.tMs, x: tick.x, labeled: false });
  for (const tick of major.ticks) byT.set(tick.tMs, tick);
  return { ticks: [...byT.values()].sort((a, b) => a.x - b.x), breaks: major.breaks };
}

/** "0:15", "1:02:03": the ruler reads as a clock, so its labels drop formatOffset's plus sign. */
export function rulerLabel(tMs: number): string {
  return formatOffset(tMs).replace(/^\+/u, "");
}
