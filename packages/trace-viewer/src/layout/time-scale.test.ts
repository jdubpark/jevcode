import { describe, expect, it } from "vitest";

import { buildSession } from "../test-support/session-builder.js";
import {
  BREAK_MIN_MS, buildTimeScale, displayGapMs, timeScaleInputOf, xOnlyXMap,
} from "./time-scale.js";

describe("displayGapMs (spec §7.4)", () => {
  it("is linear up to the 10 s knee, then 10 s + 5 s · log2(g / 10 s)", () => {
    expect(displayGapMs(4_000)).toBe(4_000);
    expect(displayGapMs(10_000)).toBe(10_000);
    expect(displayGapMs(20_000)).toBeCloseTo(15_000, 6);
    expect(displayGapMs(60_000)).toBeCloseTo(22_924.8, 1);
    expect(displayGapMs(300_000)).toBeCloseTo(34_534.5, 1);
    expect(displayGapMs(3_600_000)).toBeCloseTo(52_459.3, 1);
  });
});

describe("buildTimeScale", () => {
  it("is the identity when no gap exceeds 10 s", () => {
    const scale = buildTimeScale({ originMs: 0, work: [[0, 4_000], [9_000, 12_000], [20_000, 20_000]], awaitingFrom: [] });
    for (const t of [0, 3_000, 6_500, 12_000, 19_999, 20_000]) expect(scale.toU(t)).toBe(t);
    expect(scale.endU).toBe(20_000);
    expect(scale.breaks(0, scale.endU)).toHaveLength(0);
  });

  it("a one-hour gap compresses to 52.5 s with one break", () => {
    const scale = buildTimeScale({ originMs: 0, work: [[0, 1_000], [3_601_000, 3_602_000]], awaitingFrom: [] });
    expect(scale.toU(3_601_000)).toBeCloseTo(1_000 + 52_459.3, 1);
    expect(scale.endU).toBeCloseTo(2_000 + 52_459.3, 1);
    const breaks = scale.breaks(0, scale.endU);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]?.idle).toEqual({ reason: "agent_quiet", ms: 3_600_000 });
    expect(scale.toT(scale.toU(1_801_000))).toBeCloseTo(1_801_000, 3);
  });

  it("a 10-minute decision wait is one awaiting_supervisor segment and one break", () => {
    const session = buildSession({
      steps: [
        { kind: "command", tMs: 0, durationMs: 1_000, target: "pnpm build" },
        { kind: "decision", tMs: 2_000, durationMs: 600_000, headline: "Pick a policy" },
        { kind: "command", tMs: 602_000, durationMs: 1_000, target: "pnpm test" },
      ],
    });
    const scale = buildTimeScale(timeScaleInputOf(session));
    // The decision is not work: its open point splits the quiet second before it from the wait after it.
    const awaited = scale.segments.filter((s) => s.idle?.reason === "awaiting_supervisor");
    expect(awaited).toHaveLength(1);
    expect(awaited[0]?.idle).toEqual({ reason: "awaiting_supervisor", ms: 600_000 });
    expect(scale.breaks(0, scale.endU, BREAK_MIN_MS)).toHaveLength(1);
  });

  it("the live edge extends the scale continuously past the last work", () => {
    const base = { originMs: 0, work: [[0, 1_000]] as const, awaitingFrom: [] };
    const a = buildTimeScale({ ...base, liveTMs: 30_000 });
    const b = buildTimeScale({ ...base, liveTMs: 30_001 });
    expect(b.endU - a.endU).toBeGreaterThan(0);
    expect(b.endU - a.endU).toBeLessThanOrEqual(1);
    const closed = buildTimeScale({ originMs: 0, work: [[0, 1_000], [30_000, 31_000]], awaitingFrom: [] });
    expect(closed.toU(30_000)).toBeCloseTo(a.endU, 9);
  });

  it("maps display time to x for a Hybrid camera and back", () => {
    const scale = buildTimeScale({ originMs: 0, work: [[0, 45_000]], awaitingFrom: [] });
    const map = xOnlyXMap(scale, { mode: "xOnly", u0: 5_000, k: 0.02 });
    expect(map.xOf(15_000)).toBeCloseTo(200, 9);
    expect(map.tOf(200)).toBeCloseTo(15_000, 9);
  });
});
