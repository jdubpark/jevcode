import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { layoutMap } from "../../../layout/map-layout.js";
import { worldToScreen } from "../../../layout/viewport.js";
import { buildOverviewModel } from "../../../model/index.js";
import { arbOverviewSeed } from "../../../test-support/overview-arbitraries.js";
import { overviewSnapshot, syntheticOverview } from "../../../test-support/overview-builder.js";
import { cardCenter, MAP_FIT_PADDING, MAP_ICON_ONLY_K, MAP_LIMITS, mapZoomLimits, planMapFit, revealCamera } from "./map-camera.js";

const small = buildOverviewModel(
  overviewSnapshot({ components: [{ rootPath: "apps/web", role: "ui" }, { rootPath: "srv/api", role: "api" }, { rootPath: "pkg/db", role: "storage" }] }),
  1,
);
// One band of 20 cards: 172 wide, 1,900 tall (16 + 140 + 16; 60 + 20 × 92 − 16 + 16).
const tall = buildOverviewModel(
  overviewSnapshot({ components: Array.from({ length: 20 }, (_, i) => ({ rootPath: `pkg/c${String(i).padStart(2, "0")}`, role: "domain" as const })) }),
  1,
);
const large = buildOverviewModel(syntheticOverview({ components: 200, edges: 1_000, seed: 3 }), 1);
const VIEWPORT = { w: 944, h: 700 };

describe("planMapFit (spec §3.4: Fit centers the map and fills the stage)", () => {
  it("centers a small map at 100% with the padding of the zoom bar", () => {
    expect(MAP_FIT_PADDING).toEqual({ x: 20, top: 20, bottom: 68 });
    // The map is 496 × 152 (16 + 3 × 140 + 2 × 22 + 16 by 60 + 76 + 16). k = min(904 / 496, 612 / 152, 1) = 1.
    // tx = (944 − 496) / 2; ty = 20 + ((700 − 88) − 152) / 2.
    const plan = planMapFit(small, VIEWPORT);
    expect(plan?.camera).toEqual({ mode: "uniform", k: 1, tx: 224, ty: 250 });
    expect(plan?.level).toBe("card");
    expect(plan?.layout.level).toBe("card");
  });

  it("fills the height of a tall map, from the top padding to the bottom padding, at the chip level", () => {
    const plan = planMapFit(tall, VIEWPORT);
    const k = 612 / 1_900; // (700 − 20 − 68) / 1,900
    expect(plan?.camera.k).toBeCloseTo(k, 10);
    expect(plan?.camera.ty).toBeCloseTo(20, 8);
    expect(plan?.camera.tx).toBeCloseTo((944 - 172 * k) / 2, 8);
    expect(plan?.level).toBe("chip");
    expect(plan?.layout.level).toBe("chip");
  });

  it("fits a 200-component map at the chip level and shows all of it", () => {
    const plan = planMapFit(large, VIEWPORT);
    expect(plan?.level).toBe("chip");
    expect(plan?.camera.k).toBeLessThan(0.7);
    const { w, h } = plan?.layout.bounds ?? { w: 0, h: 0 };
    const k = plan?.camera.k ?? 0;
    expect(w * k).toBeLessThanOrEqual(VIEWPORT.w - 40 + 1e-6);
    expect(h * k).toBeLessThanOrEqual(VIEWPORT.h - 88 + 1e-6);
  });

  it("fits the two approved widths: the card level on a wide stage, the chip level with names on a narrow one", () => {
    // The mockup's 21 components are 946 wide (32 + 5 × 140 + 104 + 5 × 22) and about 796 tall.
    const mockup = buildOverviewModel(
      overviewSnapshot({
        components: [
          ...Array.from({ length: 8 }, (_, i) => ({ rootPath: `d/c${i}`, role: "domain" as const })),
          ...(["ui", "api", "agent", "storage", "tests"] as const).map((role) => ({ rootPath: `r/${role}`, role })),
        ],
      }),
      1,
    );
    const wide = planMapFit(mockup, { w: 944, h: 700 });
    expect(wide?.level).toBe("card");
    const narrow = planMapFit(mockup, { w: 552, h: 700 });
    expect(narrow?.level).toBe("chip");
    expect(narrow?.camera.k).toBeGreaterThanOrEqual(MAP_ICON_ONLY_K);
  });

  it("waits for a real size", () => {
    expect(planMapFit(small, { w: 0, h: 0 })).toBeNull();
    expect(planMapFit(small, { w: 30, h: 700 })).toBeNull();
  });

  it("property: Fit centers on both axes, stays inside the padded stage, fills one axis unless capped at 100%, and never picks detail", () => {
    fc.assert(
      fc.property(
        arbOverviewSeed({ maxComponents: 12 }),
        fc.record({ w: fc.integer({ min: 400, max: 2_400 }), h: fc.integer({ min: 500, max: 1_400 }) }),
        (seed, viewport) => {
          const plan = planMapFit(buildOverviewModel(overviewSnapshot(seed), 1), viewport);
          expect(plan).not.toBeNull();
          if (plan === null) return;
          const { w, h } = plan.layout.bounds;
          const { k, tx, ty } = plan.camera;
          const availW = viewport.w - 2 * MAP_FIT_PADDING.x;
          const availH = viewport.h - MAP_FIT_PADDING.top - MAP_FIT_PADDING.bottom;
          expect(k).toBeLessThanOrEqual(1 + 1e-9);
          expect(tx).toBeCloseTo((viewport.w - w * k) / 2, 6);
          expect(ty).toBeCloseTo(MAP_FIT_PADDING.top + (availH - h * k) / 2, 6);
          expect(tx).toBeGreaterThanOrEqual(MAP_FIT_PADDING.x - 1e-6);
          expect(ty).toBeGreaterThanOrEqual(MAP_FIT_PADDING.top - 1e-6);
          expect(ty + h * k).toBeLessThanOrEqual(viewport.h - MAP_FIT_PADDING.bottom + 1e-6);
          const fills = Math.abs(w * k - availW) < 1e-6 || Math.abs(h * k - availH) < 1e-6;
          expect(k === 1 || fills).toBe(true);
          expect(plan.level).toBe(k < 0.7 ? "chip" : "card");
          expect(plan.layout.level).toBe(plan.level);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("revealCamera", () => {
  const layout = layoutMap(small, { level: "card" });
  const camera = { mode: "uniform" as const, tx: 0, ty: 0, k: 1 };

  it("leaves a card that is already well inside the view", () => {
    const first = layout.cards[0];
    if (first === undefined) throw new Error("no card");
    // At tx 0 the first card sits 16 px from the left edge, inside the reveal inset; 200 px in, it is well inside.
    expect(revealCamera({ ...camera, tx: 200, ty: 200 }, first, { w: 2_000, h: 1_000 })).toBeNull();
  });

  it("centers a card that is outside the view", () => {
    const last = layout.cards.at(-1);
    if (last === undefined) throw new Error("no card");
    const viewport = { w: 300, h: 300 };
    const moved = revealCamera(camera, last, viewport);
    expect(moved).not.toBeNull();
    const center = worldToScreen(moved ?? camera, cardCenter(last));
    expect(center.x).toBeCloseTo(150, 5);
    expect(center.y).toBeCloseTo(150, 5);
  });
});

describe("mapZoomLimits", () => {
  it("keeps 10% to 200%, and lowers the floor to a Fit zoom below 10% so Fit stays reachable", () => {
    expect(mapZoomLimits(null)).toEqual(MAP_LIMITS);
    expect(mapZoomLimits(0.5)).toEqual({ minK: 0.1, maxK: 2 });
    expect(mapZoomLimits(0.04)).toEqual({ minK: 0.04, maxK: 2 });
  });
});
