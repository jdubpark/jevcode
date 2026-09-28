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

  it("uses the published step list", () => {
    expect(TICK_STEPS_MS).toEqual([1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5]);
  });
});
