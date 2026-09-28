import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  fitBounds, screenToWorld, screenXToU, tweenCamera, uToScreenX, wheelZoomFactor, worldToScreen, zoomAt,
  type UniformCamera, type XOnlyCamera,
} from "./viewport.js";

const LIMITS = { minK: 1e-3, maxK: 1e3 };
const num = (min: number, max: number) => fc.double({ min, max, noNaN: true, noDefaultInfinity: true });
const uniform = fc.record({ tx: num(-1e4, 1e4), ty: num(-1e4, 1e4), k: num(0.01, 10) })
  .map((c): UniformCamera => ({ mode: "uniform", ...c }));
const xOnly = fc.record({ u0: num(-1e6, 1e6), k: num(1e-4, 0.4) }).map((c): XOnlyCamera => ({ mode: "xOnly", ...c }));
const point = fc.record({ x: num(0, 2_000), y: num(0, 1_200) });

describe("viewport properties", () => {
  it("zoomAt keeps the world point under the anchor (uniform)", () => {
    fc.assert(fc.property(uniform, point, num(0.5, 2), (cam, anchor, factor) => {
      const world = screenToWorld(cam, anchor);
      const after = worldToScreen(zoomAt(cam, anchor, factor, LIMITS), world);
      expect(after.x).toBeCloseTo(anchor.x, 6);
      expect(after.y).toBeCloseTo(anchor.y, 6);
    }));
  });

  it("zoomAt keeps u under the anchor (xOnly)", () => {
    fc.assert(fc.property(xOnly, point, num(0.5, 2), (cam, anchor, factor) => {
      const u = screenXToU(cam, anchor.x);
      const next = zoomAt(cam, anchor, factor, { minK: 1e-6, maxK: 10 });
      expect(uToScreenX(next, u)).toBeCloseTo(anchor.x, 6);
    }));
  });

  it("screenToWorld inverts worldToScreen", () => {
    fc.assert(fc.property(uniform, point, (cam, p) => {
      const back = screenToWorld(cam, worldToScreen(cam, p));
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }));
  });

  it("fitBounds shows the whole box inside the padding", () => {
    const box = fc.record({ x: num(-5_000, 5_000), y: num(-5_000, 5_000), w: num(1, 20_000), h: num(1, 20_000) });
    const view = fc.record({ w: num(200, 3_000), h: num(200, 2_000) });
    fc.assert(fc.property(box, view, num(0, 80), (b, v, padding) => {
      const cam = fitBounds(b, v, { padding, limits: { minK: 1e-9, maxK: 1e9 } });
      const tl = worldToScreen(cam, { x: b.x, y: b.y });
      const br = worldToScreen(cam, { x: b.x + b.w, y: b.y + b.h });
      expect(tl.x).toBeGreaterThanOrEqual(padding - 1e-6);
      expect(tl.y).toBeGreaterThanOrEqual(padding - 1e-6);
      expect(br.x).toBeLessThanOrEqual(v.w - padding + 1e-6);
      expect(br.y).toBeLessThanOrEqual(v.h - padding + 1e-6);
    }));
  });

  it("tweenCamera starts at from and ends at to", () => {
    fc.assert(fc.property(uniform, uniform, (a, b) => {
      expect(tweenCamera(a, b, 0)).toEqual(a);
      expect(tweenCamera(a, b, 1)).toEqual(b);
    }));
  });

  it("wheelZoomFactor stays in [0.8, 1.25]", () => {
    fc.assert(fc.property(num(-1e6, 1e6), fc.constantFrom(0 as const, 1 as const, 2 as const), num(1, 4_000), (dy, mode, page) => {
      const f = wheelZoomFactor(dy, mode, page);
      expect(f).toBeGreaterThanOrEqual(0.8);
      expect(f).toBeLessThanOrEqual(1.25);
    }));
  });
});
