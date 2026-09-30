import { describe, expect, it } from "vitest";

import {
  clampCamera, fitBounds, fitRange, isInsideInset, panBy, screenToWorld, setCenter, tweenCamera,
  wheelZoomFactor, worldToScreen, zoomAt, type UniformCamera, type XOnlyCamera,
} from "./viewport.js";

const WIDE = { minK: 0.01, maxK: 100 };

describe("viewport math", () => {
  it("maps world to screen as world · k + t and back", () => {
    const cam: UniformCamera = { mode: "uniform", tx: 10, ty: 20, k: 2 };
    expect(worldToScreen(cam, { x: 5, y: 5 })).toEqual({ x: 20, y: 30 });
    expect(screenToWorld(cam, { x: 20, y: 30 })).toEqual({ x: 5, y: 5 });
  });

  it("zoomAt keeps the world point under the cursor and clamps k", () => {
    const cam: UniformCamera = { mode: "uniform", tx: 0, ty: 0, k: 1 };
    const next = zoomAt(cam, { x: 200, y: 100 }, 2, WIDE);
    expect(next.k).toBe(2);
    expect(worldToScreen(next, { x: 200, y: 100 })).toEqual({ x: 200, y: 100 });
    expect(zoomAt(cam, { x: 0, y: 0 }, 1_000, { minK: 0.5, maxK: 4 }).k).toBe(4);
  });

  it("xOnly zoom keeps u under the cursor; pan ignores dy", () => {
    const cam: XOnlyCamera = { mode: "xOnly", u0: 1_000, k: 0.1 };
    const next = zoomAt(cam, { x: 50, y: 999 }, 2, WIDE);
    expect(next).toEqual({ mode: "xOnly", u0: 1_250, k: 0.2 });
    expect(panBy(cam, 20, 500)).toEqual({ mode: "xOnly", u0: 800, k: 0.1 });
  });

  it("fitBounds centers the box inside the padded viewport", () => {
    const cam = fitBounds({ x: 0, y: 0, w: 1_000, h: 500 }, { w: 1_200, h: 800 }, { padding: 100, limits: WIDE });
    expect(cam).toEqual({ mode: "uniform", k: 1, tx: 100, ty: 150 });
  });

  it("fitBounds on a 0x0 viewport stays finite", () => {
    const cam = fitBounds({ x: 10, y: 10, w: 1_000, h: 500 }, { w: 0, h: 0 }, { padding: 48, limits: { minK: 0.1, maxK: 2 } });
    expect(cam.k).toBe(0.1);
    expect(Number.isFinite(cam.tx) && Number.isFinite(cam.ty)).toBe(true);
  });

  it("fitRange covers the span edge to edge without padding", () => {
    const cam = fitRange(0, 45_000, 1_000, { padFraction: 0, limits: { minK: 1e-6, maxK: 0.4 } });
    expect(cam.k).toBeCloseTo(1_000 / 45_000, 12);
    expect(cam.u0).toBeCloseTo(0, 9);
  });

  it("setCenter centers a world point at the current k", () => {
    const cam = setCenter({ mode: "uniform", tx: 0, ty: 0, k: 2 }, { x: 100, y: 50 }, { w: 800, h: 600 });
    expect(worldToScreen(cam, { x: 100, y: 50 })).toEqual({ x: 400, y: 300 });
  });

  it("clampCamera keeps content reachable and keeps an xOnly range inside its padding", () => {
    const content = { x: 0, y: 0, w: 2_000, h: 1_000 };
    const far = clampCamera({ mode: "uniform", tx: 5_000, ty: -9_000, k: 1 } as UniformCamera, content, { w: 800, h: 600 }, WIDE);
    expect(far.tx).toBe(800 - 64);
    expect(far.ty).toBe(64 - 1_000);
    const limitsX = { minK: 1e-4, maxK: 100 };
    const x = clampCamera({ mode: "xOnly", u0: 90_000, k: 0.05 } as XOnlyCamera, { x: 0, y: 0, w: 45_000, h: 0 }, { w: 1_000, h: 288 }, limitsX);
    expect(x.u0).toBeCloseTo(45_000 + 24 / 0.05 - 1_000 / 0.05, 9);
    const wide = clampCamera({ mode: "xOnly", u0: 5, k: 0.001 } as XOnlyCamera, { x: 0, y: 0, w: 45_000, h: 0 }, { w: 1_000, h: 288 }, limitsX);
    expect(wide.u0).toBeCloseTo(22_500 - 500 / 0.001, 6);
  });

  it("isInsideInset checks the screen rect against the inset viewport", () => {
    const cam: UniformCamera = { mode: "uniform", tx: 0, ty: 0, k: 1 };
    expect(isInsideInset(cam, { x: 48, y: 48, w: 100, h: 100 }, { w: 800, h: 600 }, 48)).toBe(true);
    expect(isInsideInset(cam, { x: 40, y: 48, w: 100, h: 100 }, { w: 800, h: 600 }, 48)).toBe(false);
  });

  it("tweens translation linearly in eased t and k geometrically", () => {
    const a: UniformCamera = { mode: "uniform", tx: 0, ty: 0, k: 1 };
    const b: UniformCamera = { mode: "uniform", tx: 100, ty: -100, k: 4 };
    expect(tweenCamera(a, b, 0)).toBe(a);
    expect(tweenCamera(a, b, 1)).toBe(b);
    const t = 1 - Math.cbrt(0.5);
    const mid = tweenCamera(a, b, t);
    expect(mid.k).toBeCloseTo(2, 9);
    expect(mid.tx).toBeCloseTo(50, 9);
  });

  it("wheelZoomFactor is 2^(−deltaY·0.02) and clamps line-mode deltas", () => {
    expect(wheelZoomFactor(-10, 0, 800)).toBeCloseTo(2 ** 0.2, 12);
    expect(wheelZoomFactor(100, 0, 800)).toBe(0.8);
    expect(wheelZoomFactor(-3, 1, 800)).toBe(1.25);
    expect(wheelZoomFactor(1, 2, 800)).toBe(0.8);
    expect(wheelZoomFactor(0, 0, 800)).toBe(1);
  });
});
