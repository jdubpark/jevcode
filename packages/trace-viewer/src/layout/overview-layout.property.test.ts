import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { LANES, type TraceSession } from "../model/index.js";
import { arbTraceSession } from "../test-support/arbitraries.js";
import { largeSession } from "../test-support/session-builder.js";
import { buildOverviewIndex } from "./overview-index.js";
import { K_MAX, layoutOverview, MAX_OVERLAY_NODES, PIN_MIN_GAP_PX, type MarkOp, type OverviewLayout } from "./overview-layout.js";
import { buildTimeScale, timeScaleInputOf } from "./time-scale.js";
import { stepTone } from "./tone.js";
import { buildTraceIndex } from "./trace-index.js";
import { fitRange } from "./viewport.js";

function prepare(session: TraceSession) {
  const index = buildTraceIndex(session);
  const scale = buildTimeScale(timeScaleInputOf(session));
  return { index, scale, overview: buildOverviewIndex(session, index, scale) };
}

function shiftOp(op: MarkOp, dx: number): MarkOp {
  if ("x" in op) return { ...op, x: op.x + dx };
  return { ...op, x0: op.x0 + dx, x1: op.x1 + dx };
}

function expectShifted(a: OverviewLayout, b: OverviewLayout, dx: number): void {
  expect(b.marks).toHaveLength(a.marks.length);
  a.marks.forEach((op, i) => {
    const want = shiftOp(op, dx);
    const got = b.marks[i];
    expect(got?.op).toBe(want.op);
    for (const [key, value] of Object.entries(want)) {
      const actual = (got as Record<string, unknown> | undefined)?.[key];
      if (typeof value === "number") expect(actual as number).toBeCloseTo(value, 6);
      else expect(actual).toEqual(value);
    }
  });
  expect(b.pins.map((p) => p.key)).toEqual(a.pins.map((p) => p.key));
  b.pins.forEach((p, i) => expect(p.x).toBeCloseTo((a.pins[i]?.x ?? 0) + dx, 6));
  expect(b.bands.map((x) => [x.key, x.tier, x.iconOnly])).toEqual(a.bands.map((x) => [x.key, x.tier, x.iconOnly]));
  b.bands.forEach((band, i) => expect(band.x0).toBeCloseTo((a.bands[i]?.x0 ?? 0) + dx, 6));
  expect(b.turnLines.map((t) => t.label)).toEqual(a.turnLines.map((t) => t.label));
  expect(b.links).toEqual(a.links);
  expect([...b.strip]).toEqual([...a.strip]);
}

const level = fc.constantFrom("session" as const, "chapter" as const, "step" as const);

describe("overview layout properties (spec §7.6.1)", () => {
  it("a pan changes only x offsets", () => {
    fc.assert(fc.property(arbTraceSession({ maxSteps: 50, maxChapters: 5, maxTurns: 3 }), fc.double({ min: 1e-4, max: 0.05, noNaN: true }), fc.double({ min: 0, max: 100, noNaN: true }), level, (session, k, dx, lvl) => {
      const { overview } = prepare(session);
      const widthPx = overview.endU * k + 600;
      const a = layoutOverview({ overview, camera: { mode: "xOnly", u0: -200 / k, k }, widthPx, level: lvl });
      const b = layoutOverview({ overview, camera: { mode: "xOnly", u0: -200 / k - dx / k, k }, widthPx, level: lvl });
      expectShifted(a, b, dx);
    }), { numRuns: 80 });
  });

  it("every problem tick survives at every k from fit to K_MAX", () => {
    fc.assert(fc.property(arbTraceSession({ maxSteps: 40, maxChapters: 4 }), fc.double({ min: 0, max: 1, noNaN: true }), level, (session, f, lvl) => {
      const { index, scale, overview } = prepare(session);
      const fitK = fitRange(0, overview.endU, 1_000, { padFraction: 0.02, limits: { minK: 1e-9, maxK: K_MAX } }).k;
      const k = fitK + (Math.min(K_MAX, 0.01) - fitK) * f;
      const camera = { mode: "xOnly" as const, u0: -50 / k, k };
      const layout = layoutOverview({ overview, camera, widthPx: overview.endU * k + 200, level: lvl });
      for (const step of session.steps) {
        if (stepTone(step, index.findingsById) !== "bad") continue;
        const x = (scale.toU(step.tMs) - camera.u0) * k;
        const found = layout.marks.some((m) => m.op === "problem" && m.lane === step.lane && Math.abs(m.x - x) < 1e-6);
        expect(found, step.id).toBe(true);
      }
    }), { numRuns: 80 });
  });

  it("pins on one lane never overlap", () => {
    fc.assert(fc.property(arbTraceSession({ maxSteps: 60, maxChapters: 4 }), fc.double({ min: 1e-5, max: K_MAX, noNaN: true }), fc.double({ min: -1e6, max: 1e6, noNaN: true }), level, (session, k, u0, lvl) => {
      const { overview } = prepare(session);
      const layout = layoutOverview({ overview, camera: { mode: "xOnly", u0, k }, widthPx: 1_200, level: lvl });
      for (const lane of LANES) {
        const xs = layout.pins.filter((p) => p.lane === lane).map((p) => p.x).sort((a, b) => a - b);
        for (let i = 1; i < xs.length; i += 1) expect((xs[i] ?? 0) - (xs[i - 1] ?? 0)).toBeGreaterThanOrEqual(PIN_MIN_GAP_PX - 1e-9);
      }
    }), { numRuns: 100 });
  });

  it("the overlay stays within 150 nodes at Session level on 5k-step sessions", () => {
    fc.assert(fc.property(fc.constantFrom(1, 2, 3), (seed) => {
      const { overview } = prepare(largeSession({ seed }));
      const camera = fitRange(0, overview.endU, 1_200, { padFraction: 0.02, limits: { minK: 1e-9, maxK: K_MAX } });
      const layout = layoutOverview({ overview, camera, widthPx: 1_200, level: "session" });
      const nodes = layout.pins.length + layout.bands.filter((b) => b.tier !== null).length + layout.turnLines.length + layout.links.length;
      expect(nodes).toBeLessThanOrEqual(MAX_OVERLAY_NODES);
    }), { numRuns: 3 });
  });
});
