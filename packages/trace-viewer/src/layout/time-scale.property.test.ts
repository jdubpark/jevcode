import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { buildTimeScale, IDLE_KNEE_MS } from "./time-scale.js";

const spans = (maxGap: number) =>
  fc.array(fc.record({ gap: fc.integer({ min: 0, max: maxGap }), len: fc.integer({ min: 0, max: 30_000 }) }), { minLength: 1, maxLength: 30 })
    .map((parts) => {
      let t = 0;
      return parts.map(({ gap, len }) => {
        const a = t + gap;
        t = a + len;
        return [a, t] as const;
      });
    });

describe("TimeScale properties (R18)", () => {
  it("toU is monotone", () => {
    fc.assert(fc.property(spans(4_000_000), fc.array(fc.integer({ min: -1_000, max: 60_000_000 }), { minLength: 2, maxLength: 40 }), (work, ts) => {
      const scale = buildTimeScale({ originMs: 0, work, awaitingFrom: [] });
      const sorted = [...ts].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i += 1) {
        expect(scale.toU(sorted[i] ?? 0)).toBeGreaterThanOrEqual(scale.toU(sorted[i - 1] ?? 0));
      }
    }));
  });

  it("toT inverts toU on work segments", () => {
    fc.assert(fc.property(spans(4_000_000), fc.double({ min: 0, max: 1, noNaN: true }), (work, f) => {
      const scale = buildTimeScale({ originMs: 0, work, awaitingFrom: [] });
      for (const seg of scale.segments.filter((s) => s.idle === null)) {
        const t = seg.t0 + (seg.t1 - seg.t0) * f;
        expect(Math.abs(scale.toT(scale.toU(t)) - t)).toBeLessThan(1e-6);
      }
    }));
  });

  it("appending work after T leaves toU(t) unchanged for t ≤ T", () => {
    fc.assert(fc.property(spans(4_000_000), fc.integer({ min: 0, max: 600_000 }), spans(4_000_000), fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 1, maxLength: 10 }), (work, live, more, fractions) => {
      const last = work.at(-1)?.[1] ?? 0;
      const liveTMs = last + live;
      const before = buildTimeScale({ originMs: 0, work, awaitingFrom: [], liveTMs });
      const shifted = more.map(([a, b]) => [a + liveTMs, b + liveTMs] as const);
      const after = buildTimeScale({ originMs: 0, work: [...work, ...shifted], awaitingFrom: [] });
      for (const f of fractions) {
        const t = liveTMs * f;
        expect(Math.abs(after.toU(t) - before.toU(t))).toBeLessThan(1e-6);
      }
    }));
  });

  it("the live edge is continuous and never faster than real time", () => {
    fc.assert(fc.property(spans(4_000_000), fc.integer({ min: 0, max: 7_200_000 }), fc.integer({ min: 1, max: 1_000 }), (work, extra, delta) => {
      const last = work.at(-1)?.[1] ?? 0;
      const a = buildTimeScale({ originMs: 0, work, awaitingFrom: [], liveTMs: last + extra });
      const b = buildTimeScale({ originMs: 0, work, awaitingFrom: [], liveTMs: last + extra + delta });
      expect(b.endU).toBeGreaterThanOrEqual(a.endU);
      expect(b.endU - a.endU).toBeLessThanOrEqual(delta + 1e-9);
    }));
  });

  it("is the identity when no gap exceeds the knee", () => {
    fc.assert(fc.property(spans(IDLE_KNEE_MS), fc.double({ min: 0, max: 1, noNaN: true }), (work, f) => {
      const scale = buildTimeScale({ originMs: 0, work, awaitingFrom: [] });
      const t = Math.round(scale.endT * f);
      expect(scale.toU(t)).toBeCloseTo(t, 6);
    }));
  });
});
