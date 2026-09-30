import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { LANES, type TraceSession, type UnitStableId } from "../model/index.js";
import { arbTraceSession } from "../test-support/arbitraries.js";
import { bandsOverview, largeSession } from "../test-support/session-builder.js";
import { buildOverviewIndex, type BandSpan, type OverviewIndex } from "./overview-index.js";
import { BAND_MERGE_GAP_PX, K_MAX, layoutOverview, MAX_OVERLAY_NODES, PIN_MIN_GAP_PX, type MarkOp, type OverviewLayout } from "./overview-layout.js";
import { buildTimeScale, timeScaleInputOf } from "./time-scale.js";
import { stepTone } from "./tone.js";
import { buildTraceIndex } from "./trace-index.js";
import { fitRange, type XOnlyCamera } from "./viewport.js";

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

/** The per-frame band merge before the index-time grouping (c76b363), geometry only: group every
 *  piece by key, sort, merge under BAND_MERGE_GAP_PX, then keep what intersects the viewport. */
function referenceBands(overview: OverviewIndex, camera: XOnlyCamera, widthPx: number): [string, string | null, number, number, string][] {
  const k = camera.k;
  const xOf = (u: number): number => (u - camera.u0) * k;
  const byKey = new Map<string, BandSpan[]>();
  for (const band of overview.bands) byKey.set(band.key, [...(byKey.get(band.key) ?? []), band]);
  const merged: { key: string; id: string | null; u0: number; u1: number; title: string }[] = [];
  for (const [key, pieces] of byKey) {
    let current: { key: string; id: string | null; u0: number; u1: number; title: string } | null = null;
    for (const piece of [...pieces].sort((a, b) => a.u0 - b.u0)) {
      if (current !== null && (piece.u0 - current.u1) * k < BAND_MERGE_GAP_PX) current.u1 = Math.max(current.u1, piece.u1);
      else {
        if (current !== null) merged.push(current);
        current = { key, id: piece.id, u0: piece.u0, u1: piece.u1, title: piece.title };
      }
    }
    if (current !== null) merged.push(current);
  }
  const seen = new Map<string, number>();
  return merged
    .filter((b) => xOf(b.u1) >= 0 && xOf(b.u0) <= widthPx)
    .sort((a, b) => a.u0 - b.u0 || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((b) => {
      const n = seen.get(b.key) ?? 0;
      seen.set(b.key, n + 1);
      return [n === 0 ? b.key : `${b.key}#${n}`, b.id, xOf(b.u0), xOf(b.u1), b.title];
    });
}

/** Soak-shaped bands: every chapter holds pieces spread over the whole session (shared hub steps). */
const arbBands = fc.integer({ min: 1, max: 12 }).chain((keys) => fc.array(
  fc.record({
    key: fc.integer({ min: 1, max: keys }),
    chapter: fc.integer({ min: 0, max: 3 }),
    u0: fc.integer({ min: 0, max: 100_000 }),
    w: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 5_000 })),
  }),
  { maxLength: 120 },
)).map((pieces) => pieces.map((p): BandSpan => ({
  key: `ch:${p.key}`, id: `unit:${p.key}-${p.chapter}` as UnitStableId, u0: p.u0, u1: p.u0 + p.w, title: `Chapter ${p.key}.${p.chapter}`,
})));

describe("band placement equals the per-frame merge it replaced (perf fix 2)", () => {
  it("same keys, ids, titles and x ranges for any camera", () => {
    fc.assert(fc.property(arbBands, fc.double({ min: 1e-4, max: K_MAX, noNaN: true }), fc.double({ min: -20_000, max: 110_000, noNaN: true }), fc.integer({ min: 50, max: 2_000 }), (bands, k, u0, widthPx) => {
      const overview = bandsOverview(bands, 100_000);
      const camera: XOnlyCamera = { mode: "xOnly", u0, k };
      const got = layoutOverview({ overview, camera, widthPx, level: "chapter" }).bands.map((b) => [b.key, b.id, b.x0, b.x1, b.title]);
      expect(got).toEqual(referenceBands(overview, camera, widthPx));
    }), { numRuns: 300 });
  });

  it("also on folded sessions", () => {
    fc.assert(fc.property(arbTraceSession({ maxSteps: 50, maxChapters: 6, maxTurns: 3 }), fc.double({ min: 1e-5, max: K_MAX, noNaN: true }), fc.double({ min: -1e5, max: 1e5, noNaN: true }), (session, k, u0) => {
      const { overview } = prepare(session);
      const camera: XOnlyCamera = { mode: "xOnly", u0, k };
      const got = layoutOverview({ overview, camera, widthPx: 1_200, level: "chapter" }).bands.map((b) => [b.key, b.id, b.x0, b.x1, b.title]);
      expect(got).toEqual(referenceBands(overview, camera, 1_200));
    }), { numRuns: 100 });
  });
});
