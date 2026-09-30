import { describe, expect, it, vi } from "vitest";

import { layoutCanvas, type CanvasFrame, type CanvasLayout } from "../../../layout/canvas-layout.js";
import { LEVEL_SPECS } from "../../../layout/canvas-levels.js";
import { buildTraceIndex } from "../../../layout/trace-index.js";
import { isInsideInset, worldToScreen, type Size, type UniformCamera } from "../../../layout/viewport.js";
import type { Level, TraceSession } from "../../../model/index.js";
import { buildCanvasSession, canvasScale, oauthCanvasSession } from "../../../test-support/canvas-arbitraries.js";
import {
  brushForWindow,
  createCameraStore,
  focusFrame,
  framesAhead,
  frontierFollowCamera,
  levelLimits,
  pinFrameCamera,
  planFit,
  revealCamera,
  screenXMap,
  showCamera,
  zoomToSelection,
} from "./canvas-camera.js";

// Expected values: spec §7.5 "Viewport commands", §7.8 item 3 and §7.10 (Canvas row).

function fresh(session: TraceSession, level: Level = "chapter"): CanvasLayout {
  return layoutCanvas(session, buildTraceIndex(session), canvasScale(session), level);
}

function camera(tx: number, ty: number, k: number): UniformCamera {
  return { mode: "uniform", tx, ty, k };
}

const oauth = oauthCanvasSession();
const layout = fresh(oauth);

function frame(predicate: (candidate: CanvasFrame) => boolean): CanvasFrame {
  const found = layout.frames.find(predicate);
  if (found === undefined) throw new Error("frame not found");
  return found;
}

const claim = frame((candidate) => candidate.item === "claim");
const linkingTest = frame((candidate) => candidate.selId === "unit:oauth-linking-test-failure");

describe("planFit", () => {
  it("switches the shared level to Session when a Chapter fit falls below 0.35", () => {
    const wide = buildCanvasSession(
      Array.from({ length: 80 }, (_, i) => ({ atMs: 1_000 * (i + 1), kind: "chapter" as const })),
    );
    expect(planFit(fresh(wide), { w: 800, h: 600 })).toEqual({ kind: "switch", level: "session" });
    const plan = planFit(fresh(wide, "session"), { w: 800, h: 600 });
    if (plan?.kind !== "camera") throw new Error("expected a camera plan");
    expect(plan.camera.k).toBeGreaterThanOrEqual(LEVEL_SPECS.session.minZoom);
    expect(plan.camera.k).toBeLessThanOrEqual(1);
  });

  it("fits oauth width-bound in the 1440 × 900 window's main area", () => {
    // Spec §7.5: (1440 − 216 − 280 − 2 · 48) / 1016 ≈ 0.83.
    const plan = planFit(layout, { w: 1440 - 216 - 280, h: 900 - 40 - 28 });
    if (plan?.kind !== "camera") throw new Error("expected a camera plan");
    expect(plan.camera.k).toBeCloseTo((1440 - 216 - 280 - 96) / 1016, 6);
  });

  it("never fits a 0x0 viewport", () => {
    expect(planFit(layout, { w: 0, h: 0 })).toBeNull();
  });
});

describe("zoomToSelection", () => {
  it("caps at 1.5", () => {
    expect(zoomToSelection(layout, linkingTest.key, { w: 4_000, h: 3_000 })?.k).toBe(1.5);
  });

  it("includes rest-edge neighbors when they fit at 0.75 or more, else the selection alone", () => {
    const roomy: Size = { w: 1_400, h: 900 };
    const both = zoomToSelection(layout, claim.key, roomy);
    if (both === null) throw new Error("no camera");
    expect(isInsideInset(both, claim.card, roomy, 0)).toBe(true);
    expect(isInsideInset(both, linkingTest.card, roomy, 0)).toBe(true);
    const tight = zoomToSelection(layout, claim.key, { w: 400, h: 300 });
    expect(tight?.k).toBeCloseTo((400 - 96) / 224, 6);
  });
});

describe("revealCamera", () => {
  it("does nothing when the card is inside the 48 px inset and never zooms", () => {
    const at = camera(0, 0, 1);
    expect(revealCamera(at, { x: 100, y: 100, w: 200, h: 100 }, { w: 800, h: 600 })).toBeNull();
    const moved = revealCamera(at, { x: 2_000, y: 100, w: 200, h: 100 }, { w: 800, h: 600 });
    if (moved === null) throw new Error("expected a move");
    expect(moved.k).toBe(1);
    expect(worldToScreen(moved, { x: 2_100, y: 150 })).toEqual({ x: 400, y: 300 });
  });

  it("does nothing for a 0x0 viewport", () => {
    expect(revealCamera(camera(0, 0, 1), { x: 2_000, y: 100, w: 200, h: 100 }, { w: 0, h: 0 })).toBeNull();
  });
});

describe("pinFrameCamera", () => {
  it("keeps the focus card's top-left on the same screen point and clamps k to the new level", () => {
    const before = { x: 264, y: 172, w: 224, h: 112 };
    const after = { x: 192, y: 116, w: 168, h: 28 };
    const from = camera(10, 20, 0.8);
    const pinned = pinFrameCamera(from, before, after, levelLimits("session"));
    const was = worldToScreen(from, { x: before.x, y: before.y });
    const now = worldToScreen(pinned, { x: after.x, y: after.y });
    expect(now.x).toBeCloseTo(was.x, 9);
    expect(now.y).toBeCloseTo(was.y, 9);
    expect(pinFrameCamera(camera(10, 20, 0.1), before, after, levelLimits("session")).k).toBe(0.25);
  });
});

describe("focusFrame", () => {
  it("prefers the selection when it is on screen, else the frame nearest the center", () => {
    const view: Size = { w: 800, h: 600 };
    const at = camera(0, 0, 1);
    expect(focusFrame(layout, at, view, linkingTest)?.key).toBe(linkingTest.key);
    const offscreenClaim = focusFrame(layout, camera(0, 0, 1), { w: 500, h: 400 }, claim);
    expect(offscreenClaim?.key).not.toBe(claim.key);
  });
});

describe("brushForWindow", () => {
  it("writes the steps inside a settled window", () => {
    // World x ∈ [0, 600] maps to [+0:00, +0:34]: between Linking test (592 px, 33 s) and the claim's
    // breakpoint (672 px, 43 s), x = 600 is 33 s + 8/80 · 10 s. The last step starting by then is the
    // tests/auth/oauth.test.ts edit (33.0 s); `pnpm test` starts at 35.0 s.
    const brush = brushForWindow({
      layout,
      scale: canvasScale(oauth),
      session: oauth,
      camera: camera(0, 0, 1),
      viewport: { w: 600, h: 600 },
    });
    const lastInside = oauth.steps.find((step) => step.edit?.path === "tests/auth/oauth.test.ts");
    expect(brush).toEqual({ kind: "range", fromSeq: oauth.steps[0]?.firstSeq, toSeq: lastInside?.lastSeq });
  });

  it("writes nothing for an empty window", () => {
    const brush = brushForWindow({
      layout,
      scale: canvasScale(oauth),
      session: oauth,
      camera: camera(-5_000, 0, 1),
      viewport: { w: 600, h: 600 },
    });
    expect(brush).toBeNull();
  });
});

describe("live follow and the N frames badge", () => {
  it("pans x only when the frontier column leaves the view", () => {
    const view: Size = { w: 600, h: 600 };
    expect(frontierFollowCamera(layout, camera(-464, 12, 1), view)).toBeNull();
    expect(frontierFollowCamera(layout, camera(0, 12, 1), view)).toEqual(camera(-464, 12, 1));
  });

  it("counts frames that start beyond the right edge", () => {
    expect(framesAhead(layout, camera(-150, 0, 1), { w: 600, h: 600 })).toBe(1);
    expect(framesAhead(layout, camera(-464, 0, 1), { w: 600, h: 600 })).toBe(0);
  });
});

describe("showCamera", () => {
  it("fits a chapter brush horizontally within [minZoom, 1.5], keeps ty and shows the chapter's column", () => {
    const index = buildTraceIndex(oauth);
    const unit = oauth.chapters.find((chapter) => chapter.changeUnitId === "oauth-linking-test-failure");
    const key = unit === undefined ? undefined : index.chapterKey(unit.id);
    if (key === undefined) throw new Error("no chapter key");
    const view: Size = { w: 800, h: 600 };
    const shown = showCamera({
      layout,
      scale: canvasScale(oauth),
      session: oauth,
      index,
      brush: { kind: "chapter", anchorSeq: Number(key.slice(3)) },
      camera: camera(0, 37, 1),
      viewport: view,
      selectionCard: null,
    });
    if (shown === null) throw new Error("no camera");
    expect(shown.ty).toBe(37);
    expect(shown.k).toBeGreaterThanOrEqual(LEVEL_SPECS.chapter.minZoom);
    expect(shown.k).toBeLessThanOrEqual(1.5);
    expect(worldToScreen(shown, { x: 528, y: 0 }).x).toBeGreaterThanOrEqual(0);
    expect(worldToScreen(shown, { x: 752, y: 0 }).x).toBeLessThanOrEqual(view.w);
  });

  it("never fits a 0x0 viewport", () => {
    const index = buildTraceIndex(oauth);
    expect(
      showCamera({
        layout,
        scale: canvasScale(oauth),
        session: oauth,
        index,
        brush: { kind: "session" },
        camera: camera(0, 0, 1),
        viewport: { w: 0, h: 0 },
        selectionCard: null,
      }),
    ).toBeNull();
  });
});

describe("screenXMap and the camera store", () => {
  it("composes the world map with the camera", () => {
    const screen = screenXMap({ xOf: (t) => t / 10, tOf: (x) => x * 10 }, camera(5, 0, 2));
    expect(screen.xOf(100)).toBe(25);
    expect(screen.tOf(25)).toBe(100);
  });

  it("notifies subscribers only when the camera changes", () => {
    const store = createCameraStore(camera(0, 0, 1));
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    store.set(camera(0, 0, 1));
    store.set(camera(3, 0, 1));
    stop();
    store.set(camera(4, 0, 1));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).toEqual(camera(4, 0, 1));
  });
});
