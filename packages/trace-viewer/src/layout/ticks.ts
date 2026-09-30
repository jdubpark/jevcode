import { BREAK_MIN_MS, type ScaleSegment, type TimeScale, type XMap } from "./time-scale.js";

export const TICK_STEPS_MS: readonly number[] = [1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5];
export const MIN_TICK_LABEL_GAP_PX = 64;
const MIN_TICK_GAP_PX = 8;

export interface Tick { tMs: number; x: number; labeled: boolean }
export interface BreakMark { x0: number; x1: number; ms: number }

/** Largest px-per-ms slope on work segments inside [t0, t1]. */
function workSlope(map: XMap, scale: TimeScale, t0: number, t1: number): number {
  let slope = 0;
  for (const seg of scale.segments) {
    if (seg.idle !== null || seg.t1 <= t0 || seg.t0 >= t1) continue;
    const a = Math.max(seg.t0, t0);
    const b = Math.min(seg.t1, t1);
    if (b > a) slope = Math.max(slope, (map.xOf(b) - map.xOf(a)) / (b - a));
  }
  if (slope > 0) return slope;
  const probe = Math.max(1, (t1 - t0) / 100);
  return Math.max(1e-12, (map.xOf(t0 + probe) - map.xOf(t0)) / probe);
}

/** Ticks inside [x0, x1]; none inside breaks; the Ruler formats labels with formatOffset(tMs). */
export function computeTicks(map: XMap, scale: TimeScale, range: { x0: number; x1: number }): { ticks: Tick[]; breaks: BreakMark[] } {
  const x0 = Math.min(range.x0, range.x1);
  const x1 = Math.max(range.x0, range.x1);
  const t0 = Math.max(0, map.tOf(x0));
  const t1 = Math.max(t0, map.tOf(x1));
  const breakSegs: ScaleSegment[] = scale.segments.filter((s) => s.idle !== null && s.idle.ms >= BREAK_MIN_MS && s.t1 > t0 && s.t0 < t1);
  const breaks = breakSegs.map((s) => ({ x0: map.xOf(s.t0), x1: map.xOf(s.t1), ms: s.idle?.ms ?? 0 }));
  const slope = workSlope(map, scale, t0, t1);
  const step = TICK_STEPS_MS.find((s) => s * slope >= MIN_TICK_LABEL_GAP_PX) ?? TICK_STEPS_MS[TICK_STEPS_MS.length - 1] ?? 3_600_000;
  const ticks: Tick[] = [];
  let lastLabeledX = Number.NEGATIVE_INFINITY;
  let lastX = Number.NEGATIVE_INFINITY;
  let t = Math.ceil(t0 / step) * step;
  while (t <= t1) {
    const inside = breakSegs.find((s) => s.t0 < t && t < s.t1);
    if (inside !== undefined) {
      t = Math.ceil(inside.t1 / step) * step;
      continue;
    }
    const x = map.xOf(t);
    if (x >= x0 - 1e-9 && x <= x1 + 1e-9 && x - lastX >= MIN_TICK_GAP_PX) {
      const labeled = x - lastLabeledX >= MIN_TICK_LABEL_GAP_PX - 1e-9;
      ticks.push({ tMs: t, x, labeled });
      lastX = x;
      if (labeled) lastLabeledX = x;
    }
    t += step;
  }
  return { ticks, breaks };
}
