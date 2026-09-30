import { describe, expect, it } from "vitest";

import { computeTicks, MIN_TICK_LABEL_GAP_PX, TICK_STEPS_MS } from "./ticks.js";
import { buildTimeScale, xOnlyXMap } from "./time-scale.js";

function labeledGaps(xs: readonly number[]): number[] {
  return xs.slice(1).map((x, i) => x - (xs[i] ?? 0));
}

describe("computeTicks (spec §7.4)", () => {
  it("picks the smallest step whose labels stay ≥ 64 px apart", () => {
    const scale = buildTimeScale({ originMs: 0, work: [[0, 45_000]], awaitingFrom: [] });
    const map = xOnlyXMap(scale, { mode: "xOnly", u0: 0, k: 0.02 });
    const { ticks, breaks } = computeTicks(map, scale, { x0: 0, x1: 900 });
    expect(ticks.map((t) => t.tMs)).toEqual([0, 5_000, 10_000, 15_000, 20_000, 25_000, 30_000, 35_000, 40_000, 45_000]);
    expect(ticks.every((t) => t.labeled)).toBe(true);
    expect(ticks[1]?.x).toBeCloseTo(100, 9);
    expect(breaks).toHaveLength(0);
  });

  it("no tick inside a break, and labeled ticks stay ≥ 64 px apart at every zoom", () => {
    const scale = buildTimeScale({ originMs: 0, work: [[0, 30_000], [3_630_000, 3_660_000]], awaitingFrom: [] });
    const [gap] = scale.breaks(0, scale.endU);
    expect(gap).toBeDefined();
    for (const k of [0.002, 0.01, 0.05, 0.2]) {
      const map = xOnlyXMap(scale, { mode: "xOnly", u0: 0, k });
      const { ticks, breaks } = computeTicks(map, scale, { x0: 0, x1: scale.endU * k });
      expect(breaks).toHaveLength(1);
      for (const tick of ticks) expect(tick.tMs <= (gap?.t0 ?? 0) || tick.tMs >= (gap?.t1 ?? 0)).toBe(true);
      const xs = ticks.filter((t) => t.labeled).map((t) => t.x);
      for (const d of labeledGaps(xs)) expect(d).toBeGreaterThanOrEqual(MIN_TICK_LABEL_GAP_PX - 1e-9);
    }
  });

  it("takes a wider label gap and finer unlabeled minor ticks as options (visual audit 2-4)", () => {
    const scale = buildTimeScale({ originMs: 0, work: [[0, 45_000]], awaitingFrom: [] });
    const map = xOnlyXMap(scale, { mode: "xOnly", u0: 0, k: 0.02 });
    const { ticks } = computeTicks(map, scale, { x0: 0, x1: 900 }, { labelGapPx: 120, minorGapPx: 20 });
    // 20 px per s: labels every 10 s (200 px, the first step ≥ 120 px), minor ticks every 1 s.
    expect(ticks.filter((t) => t.labeled).map((t) => t.tMs)).toEqual([0, 10_000, 20_000, 30_000, 40_000]);
    expect(ticks.map((t) => t.tMs)).toEqual(Array.from({ length: 46 }, (_, i) => i * 1_000));
  });

  it("puts minor ticks on the finest step that divides the label step, so every label step keeps its label", () => {
    const scale = buildTimeScale({ originMs: 0, work: [[0, 45_000]], awaitingFrom: [] });
    const map = xOnlyXMap(scale, { mode: "xOnly", u0: 0, k: 0.01 });
    // 10 px per s: labels every 15 s (150 px). The first step ≥ 15 px is 2 s, which does not divide 15 s; 5 s does.
    const { ticks } = computeTicks(map, scale, { x0: 0, x1: 450 }, { labelGapPx: 120, minorGapPx: 15 });
    expect(ticks.filter((t) => t.labeled).map((t) => t.tMs)).toEqual([0, 15_000, 30_000, 45_000]);
    expect(ticks.map((t) => t.tMs)).toEqual(Array.from({ length: 10 }, (_, i) => i * 5_000));
  });

  it("minor ticks never cost a label, across breaks and zooms", () => {
    // Zoomed out (k = 0.00015, 0.0003) the 60 s break is under 8 px wide, so the minor tick at its start (29:00) would
    // crowd out the 30:00 label right after it.
    const scale = buildTimeScale({ originMs: 0, work: [[0, 1_740_000], [1_800_000, 3_600_000]], awaitingFrom: [] });
    for (const k of [0.00015, 0.0003, 0.0005, 0.002, 0.01, 0.08]) {
      const map = xOnlyXMap(scale, { mode: "xOnly", u0: 0, k });
      const range = { x0: 0, x1: scale.endU * k };
      const labelsOnly = computeTicks(map, scale, range, { labelGapPx: 120 }).ticks.filter((t) => t.labeled).map((t) => t.tMs);
      const withMinor = computeTicks(map, scale, range, { labelGapPx: 120, minorGapPx: 8 }).ticks;
      expect(withMinor.filter((t) => t.labeled).map((t) => t.tMs), `k=${k}`).toEqual(labelsOnly);
      for (let i = 1; i < withMinor.length; i += 1) expect((withMinor[i]?.x ?? 0) - (withMinor[i - 1]?.x ?? 0)).toBeGreaterThanOrEqual(8 - 1e-9);
    }
  });

  it("uses the published step list", () => {
    expect(TICK_STEPS_MS).toEqual([1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5]);
  });
});
