import { describe, expect, it, vi } from "vitest";

import { layoutCanvas, type CanvasFrame, type CanvasLayout } from "../../../layout/canvas-layout.js";
import type { CanvasEdge } from "../../../layout/canvas-routes.js";
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
  planShow,
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

  it("does not widen the fit along a trunk edge, which spans a whole turn", () => {
    const intent = frame((candidate) => candidate.item === "intent");
    const roomy: Size = { w: 1_400, h: 900 };
    const trunk: CanvasEdge = {
      id: "trunk:turn:1",
      kind: "trunk",
      from: intent.key,
      to: claim.key,
      shape: "comb",
      lane: null,
      d: "M0 0",
      rest: true,
      tone: "neutral",
      badge: null,
      findingId: null,
    };
    // The claim card alone fits far past the 1.5 cap; the intent-to-claim union (x 0 to 1016) would give 1.28.
    expect(zoomToSelection({ ...layout, edges: [trunk] }, claim.key, roomy)?.k).toBe(1.5);
  });

  it("does nothing for a 0x0 viewport", () => {
    expect(zoomToSelection(layout, claim.key, { w: 0, h: 0 })).toBeNull();
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

  it("reveals a card whose edge is inside the 48 px margin and leaves one exactly at it", () => {
    const view: Size = { w: 800, h: 600 };
    expect(revealCamera(camera(0, 0, 1), { x: 40, y: 100, w: 200, h: 100 }, view)).not.toBeNull();
    expect(revealCamera(camera(0, 0, 1), { x: 48, y: 100, w: 200, h: 100 }, view)).toBeNull();
    expect(revealCamera(camera(0, 0, 1), { x: 552, y: 100, w: 200, h: 100 }, view)).toBeNull();
    expect(revealCamera(camera(0, 0, 1), { x: 560, y: 100, w: 200, h: 100 }, view)).not.toBeNull();
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

  it("writes nothing for a 0x0 viewport", () => {
    expect(
      brushForWindow({ layout, scale: canvasScale(oauth), session: oauth, camera: camera(0, 0, 1), viewport: { w: 0, h: 0 } }),
    ).toBeNull();
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

  it("keeps the frontier column's left edge in view when the viewport is narrower than the column", () => {
    const column = layout.columns[layout.columns.length - 1];
    if (column === undefined) throw new Error("no column");
    const view: Size = { w: 120, h: 600 };
    const target = frontierFollowCamera(layout, camera(0, 12, 1), view);
    expect(target).not.toBeNull();
    // The left edge sits inside the window (not panned off to the left), at the reveal inset.
    expect(column.x * (target?.k ?? 1) + (target?.tx ?? Number.NaN)).toBeGreaterThanOrEqual(0);
    expect(column.x + (target?.tx ?? Number.NaN)).toBeLessThan(view.w);
    // Already there: following again must not request another pan.
    expect(frontierFollowCamera(layout, target ?? camera(0, 12, 1), view)).toBeNull();
  });

  it("counts frames that start beyond the right edge", () => {
    expect(framesAhead(layout, camera(-150, 0, 1), { w: 600, h: 600 })).toBe(1);
    expect(framesAhead(layout, camera(-464, 0, 1), { w: 600, h: 600 })).toBe(0);
  });

  it("neither pans nor counts for a 0x0 viewport", () => {
    expect(frontierFollowCamera(layout, camera(0, 12, 1), { w: 0, h: 0 })).toBeNull();
    expect(framesAhead(layout, camera(-150, 0, 1), { w: 0, h: 0 })).toBe(0);
  });
});

describe("planShow (open path of the fit rule, spec §7.5/§7.8)", () => {
  const index = buildTraceIndex(oauth);
  const input = (target: CanvasLayout, brush: Parameters<typeof showCamera>[0]["brush"], w: number) => ({
    layout: target, session: oauth, index, brush, camera: camera(0, 0, 1), viewport: { w, h: 700 } as Size, selectionCard: null,
  });

  it("switches to Session when a whole-session show at Step fits below 0.35 (a 1000 px window's ~540 px main area)", () => {
    const step = fresh(oauth, "step");
    expect(planShow(input(step, { kind: "session" }, 540))).toEqual({ kind: "switch", level: "session" });
    expect(planShow(input(fresh(oauth, "chapter"), { kind: "session" }, 540))?.kind).toBe("camera");
    expect(planShow(input(fresh(oauth, "session"), { kind: "session" }, 300))?.kind).toBe("camera");
  });

  it("leaves a brushed show at the level the person chose", () => {
    const step = fresh(oauth, "step");
    expect(planShow(input(step, { kind: "range", fromSeq: 0, toSeq: 1 }, 540))?.kind).toBe("camera");
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

  it("fits the whole session for a session brush, 48 px from each side", () => {
    const index = buildTraceIndex(oauth);
    const view: Size = { w: 1_200, h: 600 };
    const shown = showCamera({
      layout,
      session: oauth,
      index,
      brush: { kind: "session" },
      camera: camera(0, 37, 1),
      viewport: view,
      selectionCard: null,
    });
    if (shown === null) throw new Error("no camera");
    expect(shown.k).toBeCloseTo((1_200 - 96) / layout.bounds.w, 9);
    expect(shown.ty).toBe(37);
    expect(worldToScreen(shown, { x: layout.bounds.x, y: 0 }).x).toBeCloseTo(48, 9);
    expect(worldToScreen(shown, { x: layout.bounds.x + layout.bounds.w, y: 0 }).x).toBeCloseTo(1_152, 9);
  });

  it("centers a range brush's columns and caps k at 1.5", () => {
    const index = buildTraceIndex(oauth);
    const step = oauth.steps.find((candidate) => candidate.id === claim.selId);
    if (step === undefined) throw new Error("no claim step");
    const view: Size = { w: 800, h: 600 };
    const shown = showCamera({
      layout,
      session: oauth,
      index,
      brush: { kind: "range", fromSeq: step.firstSeq, toSeq: step.lastSeq },
      camera: camera(0, 0, 1),
      viewport: view,
      selectionCard: null,
    });
    if (shown === null) throw new Error("no camera");
    // One 224 px column in 800 − 96 px would take k ≈ 3.1; the cap holds it at 1.5, centered.
    expect(shown.k).toBe(1.5);
    expect(worldToScreen(shown, { x: claim.card.x + claim.card.w / 2, y: 0 }).x).toBeCloseTo(400, 9);
  });

  it("reveals the selection without zooming when the fit leaves it off screen", () => {
    const index = buildTraceIndex(oauth);
    const view: Size = { w: 1_200, h: 600 };
    const input = {
      layout,
      session: oauth,
      index,
      brush: { kind: "session" } as const,
      camera: camera(0, -2_000, 1),
      viewport: view,
    };
    const fitted = showCamera({ ...input, selectionCard: null });
    const shown = showCamera({ ...input, selectionCard: linkingTest.card });
    if (fitted === null || shown === null) throw new Error("no camera");
    expect(shown.k).toBe(fitted.k);
    const center = worldToScreen(shown, {
      x: linkingTest.card.x + linkingTest.card.w / 2,
      y: linkingTest.card.y + linkingTest.card.h / 2,
    });
    expect(center.x).toBeCloseTo(600, 9);
    expect(center.y).toBeCloseTo(300, 9);
    // On screen already: the fit stands.
    expect(showCamera({ ...input, camera: camera(0, 0, 1), selectionCard: linkingTest.card })).toEqual(
      showCamera({ ...input, camera: camera(0, 0, 1), selectionCard: null }),
    );
  });

  it("never fits a 0x0 viewport", () => {
    const index = buildTraceIndex(oauth);
    expect(
      showCamera({
        layout,
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
