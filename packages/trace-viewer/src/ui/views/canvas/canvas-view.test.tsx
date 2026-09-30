// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { layoutCanvas } from "../../../layout/canvas-layout.js";
import { MINIMAP_H, MINIMAP_MIN_SCALE, MINIMAP_W } from "../../../layout/canvas-minimap.js";
import { buildTraceIndex } from "../../../layout/trace-index.js";
import type { UniformCamera } from "../../../layout/viewport.js";
import type { TraceSession } from "../../../model/index.js";
import {
  buildCanvasSession,
  canvasScale,
  oauthCanvasSession,
  syntheticCanvasSession,
  type CanvasSeed,
} from "../../../test-support/canvas-arbitraries.js";
import {
  cameraVars,
  canvasViewport,
  canvasWorld,
  renderWithViewer,
  stubAnimationFrames,
  stubElementBox,
  stubReducedMotion,
  stubResizeObserver,
} from "../../../test-support/canvas-view-harness.js";
import { initialViewState, type ViewAction, type ViewState } from "../../state/view-state.js";
import { createCameraStore } from "./canvas-camera.js";
import { CanvasRuler } from "./CanvasRuler.js";
import { CanvasView } from "./CanvasView.js";

// Counts programmatic camera moves (controller.set) while keeping the real controller.
const moves = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../viewport/controller.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../viewport/controller.js")>();
  return {
    ...actual,
    createViewportController: ((options) => {
      const controller = actual.createViewportController(options);
      return {
        ...controller,
        set: (camera, setOptions) => {
          moves.count += 1;
          return controller.set(camera, setOptions);
        },
      };
    }) as typeof actual.createViewportController,
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Layout at Chapter level (spec §7.5 rules): intent col 0; plan opens col 1 (x 264) with chapters c3, c4;
// the decision opens col 2 (x 528) with chapter c6; a claim at 43 s opens col 3 (x 792, right edge 1016).
const BASE: CanvasSeed[] = [
  { atMs: 8_000, kind: "plan" },
  { atMs: 10_000, kind: "chapter" },
  { atMs: 15_000, kind: "chapter" },
  { atMs: 25_000, kind: "decision" },
  { atMs: 30_000, kind: "chapter" },
];
const s1 = buildCanvasSession(BASE, { live: true });
const s1WithWork = buildCanvasSession([...BASE, { atMs: 31_000, kind: "work" }], { live: true });
const s2 = buildCanvasSession([...BASE, { atMs: 31_000, kind: "work" }, { atMs: 43_000, kind: "claim" }], { live: true });

function saved(tx: number, ty: number, k: number): ViewState["cameras"] {
  return { canvas: { mode: "uniform", tx, ty, k, syncedRev: initialViewState({ live: true }).focusRev }, hybrid: null };
}

function setup(width = 600, height = 600) {
  stubElementBox(width, height);
  const observers = stubResizeObserver();
  const frames = stubAnimationFrames();
  stubReducedMotion(true);
  return { observers, frames };
}

function frameStyles(): Map<string, string> {
  return new Map(
    [...document.querySelectorAll<HTMLElement>('[role="group"][data-key]')].map((element) => [
      element.dataset.key ?? "",
      element.getAttribute("style") ?? "",
    ]),
  );
}

function numericCamera(): UniformCamera {
  const vars = cameraVars(canvasViewport());
  return { mode: "uniform", tx: parseFloat(vars.tx), ty: parseFloat(vars.ty), k: Number(vars.k) };
}

function screenOf(key: string): { x: number; y: number } {
  const element = [...document.querySelectorAll<HTMLElement>("[data-key]")].find((candidate) => candidate.dataset.key === key);
  if (element === undefined) throw new Error(`no frame ${key}`);
  const camera = numericCamera();
  return { x: parseFloat(element.style.left) * camera.k + camera.tx, y: parseFloat(element.style.top) * camera.k + camera.ty };
}

describe("CanvasView", () => {
  it("an append leaves every placed frame's rect unchanged", () => {
    const { frames } = setup();
    const harness = renderWithViewer(<CanvasView active />, { session: s1, state: { follow: false, cameras: saved(0, 0, 1) } });
    act(() => frames.flush());
    const before = frameStyles();
    act(() => harness.setSession(s2));
    act(() => frames.flush());
    const after = frameStyles();
    for (const [key, style] of before) expect(after.get(key), key).toBe(style);
    expect(after.size).toBe(before.size + 1);
    expect(document.activeElement).toBe(document.body);
  });

  it("in Live the camera pans x only when the frontier column leaves the view", () => {
    const { frames } = setup();
    const harness = renderWithViewer(<CanvasView active />, { session: s1, state: { follow: true, cameras: saved(-200, 0, 1) } });
    act(() => frames.flush());
    expect(cameraVars(canvasViewport())).toEqual({ tx: "-200px", ty: "0px", k: "1" });
    act(() => harness.setSession(s1WithWork));
    act(() => frames.flush());
    expect(cameraVars(canvasViewport())).toEqual({ tx: "-200px", ty: "0px", k: "1" });
    act(() => harness.setSession(s2));
    act(() => frames.flush());
    // Column 3's right edge (1016) lands at viewport width − 48 = 552: tx = 552 − 1016.
    expect(cameraVars(canvasViewport())).toEqual({ tx: "-464px", ty: "0px", k: "1" });
  });

  it("in Review it never moves and shows N frames → for frames past the right edge", () => {
    const { frames } = setup();
    const harness = renderWithViewer(<CanvasView active />, {
      session: s1,
      state: { follow: false, lastSeenSeq: s1.loadedThroughSeq, cameras: saved(-150, 0, 1) },
    });
    act(() => frames.flush());
    act(() => harness.setSession(s2));
    act(() => frames.flush());
    expect(cameraVars(canvasViewport())).toEqual({ tx: "-150px", ty: "0px", k: "1" });
    expect(screen.getByRole("button", { name: "1 frame →" })).toBeDefined();
  });

  it("registers a ViewPort whose reading order adds an expanded frame's steps", () => {
    setup();
    const harness = renderWithViewer(<CanvasView active />, { session: s1, state: { expanded: new Set(["ch:3"]) } });
    // Columns left → right, story cells then work rows (spec §7.5): intent, plan, c3 (+ its step), c4, decision, c6.
    expect(harness.registry.get("canvas")?.readingOrder()).toEqual([
      "step:1",
      "step:2",
      "unit:c3",
      "step:3",
      "unit:c4",
      "step:5",
      "unit:c6",
    ]);
  });

  it("a settled user pan writes brush/set and a programmatic move never does", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { frames } = setup();
    const harness = renderWithViewer(<CanvasView active />, { session: s2, state: { follow: false, cameras: saved(0, 0, 1) } });
    act(() => frames.flush());
    const dispatch = vi.spyOn(harness.store, "dispatch");
    const brushWrites = (): ViewAction[] =>
      dispatch.mock.calls.map(([action]) => action).filter((action) => action.type === "brush/set");
    act(() => harness.registry.get("canvas")?.zoom.fitAll());
    act(() => {
      frames.flush();
      vi.advanceTimersByTime(200);
      frames.flush();
    });
    expect(brushWrites()).toEqual([]);
    act(() => {
      fireEvent.wheel(canvasViewport(), { deltaX: 120, deltaY: 0 });
      frames.flush();
    });
    act(() => {
      vi.advanceTimersByTime(200);
      frames.flush();
    });
    expect(brushWrites()).toEqual([
      expect.objectContaining({ type: "brush/set", by: "canvas", brush: expect.objectContaining({ kind: "range" }) }),
    ]);
  });

  it("a level switch keeps the focus frame on the same screen point", () => {
    const { frames } = setup();
    const harness = renderWithViewer(<CanvasView active />, {
      session: s2,
      state: { follow: false, selection: "unit:c4", cameras: saved(-100, 20, 1) },
    });
    act(() => frames.flush());
    const before = screenOf("ch:4");
    act(() => harness.store.dispatch({ type: "level/set", level: "session", by: "shell" }));
    act(() => frames.flush());
    const after = screenOf("ch:4");
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("reveals a selection made outside the canvas and leaves canvas clicks alone", () => {
    const { frames } = setup();
    const harness = renderWithViewer(<CanvasView active />, { session: s2, state: { follow: false, cameras: saved(0, 0, 1) } });
    act(() => frames.flush());
    act(() => harness.store.dispatch({ type: "select", id: "step:8", by: "shell" }));
    act(() => frames.flush());
    // The claim card (792, 22, 224, 96) is centered at the same k: tx = 300 − 904, ty = 300 − 70.
    expect(cameraVars(canvasViewport())).toEqual({ tx: "-604px", ty: "230px", k: "1" });
    act(() => harness.store.dispatch({ type: "select", id: "unit:c3", by: "canvas" }));
    act(() => frames.flush());
    expect(cameraVars(canvasViewport())).toEqual({ tx: "-604px", ty: "230px", k: "1" });
  });
  it("dragging the minimap outline pans by the world delta times k, the content moving the other way", () => {
    const { frames } = setup();
    renderWithViewer(<CanvasView active />, { session: s2, state: { follow: false, cameras: saved(0, 0, 0.5) } });
    act(() => frames.flush());
    const bounds = layoutCanvas(s2, buildTraceIndex(s2), canvasScale(s2), "chapter").bounds;
    // Spec §7.5 minimap scale: s = max(min(140 / B.w, 84 / B.h), 0.03).
    const s = Math.max(Math.min(MINIMAP_W / bounds.w, MINIMAP_H / bounds.h), MINIMAP_MIN_SCALE);
    const outline = document.querySelector("[data-viewport]");
    if (outline === null) throw new Error("no minimap outline");
    act(() => {
      fireEvent.pointerDown(outline, { clientX: 10, clientY: 10, pointerId: 1, button: 0 });
      fireEvent.pointerMove(outline, { clientX: 20, clientY: 10, pointerId: 1, buttons: 1 });
      fireEvent.pointerUp(outline, { pointerId: 1 });
      frames.flush();
    });
    const camera = numericCamera();
    expect(camera.tx).toBeCloseTo(-(10 / s) * 0.5, 6);
    expect(camera.ty).toBe(0);
  });

  it("wheel over the minimap or the toolbar leaves the camera alone", () => {
    const { frames } = setup();
    renderWithViewer(<CanvasView active />, { session: s2, state: { follow: false, cameras: saved(0, 0, 1) } });
    act(() => frames.flush());
    const minimap = document.querySelector("svg[data-minimap]");
    if (minimap === null) throw new Error("no minimap");
    act(() => {
      fireEvent.wheel(minimap, { deltaX: 120, deltaY: 0 });
      fireEvent.wheel(screen.getByRole("toolbar", { name: "Canvas tools" }), { deltaX: 120, deltaY: 0 });
      frames.flush();
    });
    expect(cameraVars(canvasViewport())).toEqual({ tx: "0px", ty: "0px", k: "1" });
  });

  it("releases the gesture when the view unmounts mid-gesture", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { frames } = setup();
    const harness = renderWithViewer(<CanvasView active />, { session: s2, state: { follow: false, cameras: saved(0, 0, 1) } });
    act(() => frames.flush());
    act(() => {
      fireEvent.wheel(canvasViewport(), { deltaX: 120, deltaY: 0 });
      frames.flush();
    });
    expect(harness.store.get().gesture).toBe("pan");
    act(() => harness.result.unmount());
    expect(harness.store.get().gesture).toBeNull();
  });

  it("moves the camera once when j selects and the keyboard layer reveals the same frame", async () => {
    const { frames } = setup();
    const harness = renderWithViewer(<CanvasView active />, { session: s2, state: { follow: false, cameras: saved(0, 0, 1) } });
    act(() => frames.flush());
    const before = moves.count;
    await act(async () => {
      harness.store.dispatch({ type: "select", id: "step:8", by: "shell" });
      harness.registry.get("canvas")?.reveal("step:8", { animate: false });
    });
    await act(async () => {
      frames.flush();
      await Promise.resolve();
    });
    expect(moves.count - before).toBe(1);
    expect(cameraVars(canvasViewport())).toEqual({ tx: "-604px", ty: "230px", k: "1" });
  });

  it("the toolbar's level radios write the level as the canvas, which leaves Live", () => {
    const { frames } = setup();
    const harness = renderWithViewer(<CanvasView active />, { session: s2, state: { follow: true } });
    act(() => frames.flush());
    act(() => {
      fireEvent.click(screen.getByRole("radio", { name: "Session" }));
      frames.flush();
    });
    expect(harness.store.get().level).toBe("session");
    expect(harness.store.get().follow).toBe(false);
    expect(harness.store.get().focusBy).toBe("canvas");
  });

  it("the ruler draws the selection's band and playhead and a tick for each critical finding", () => {
    const { frames } = setup(1200, 600);
    const flagged = buildCanvasSession([...BASE, { atMs: 31_000, kind: "loose", flagged: true }, { atMs: 43_000, kind: "claim", flagged: true }]);
    renderWithViewer(<CanvasView active />, {
      session: flagged,
      state: { follow: false, selection: "unit:c4", cameras: saved(0, 0, 1) },
    });
    act(() => frames.flush());
    const band = document.querySelector<HTMLElement>("[data-ruler-band]");
    const playhead = document.querySelector("[data-ruler-playhead]");
    expect(band).not.toBeNull();
    expect(playhead).not.toBeNull();
    // Spec §7.5 P3 (truthful ruler): the playhead at c4's start lies inside c4's column (x 264 to 528 at k = 1).
    const x = Number(playhead?.getAttribute("x")) + 1;
    expect(x).toBeGreaterThanOrEqual(264);
    expect(x).toBeLessThanOrEqual(528);
    expect(document.querySelectorAll("[data-ruler-problem]").length).toBeGreaterThanOrEqual(1);
  });

  it("mounts only the frames within a viewport width of the view (spike risk 2 ruling), plus the selection", () => {
    const { frames } = setup();
    const wide = syntheticCanvasSession({ chapters: 60, steps: 600, turns: 3 });
    const layout = layoutCanvas(wide, buildTraceIndex(wide), canvasScale(wide), "chapter");
    const last = layout.frames.at(-1);
    if (last === undefined) throw new Error("no frames");
    renderWithViewer(<CanvasView active />, {
      session: wide,
      state: { follow: false, level: "chapter", selection: last.selId, cameras: saved(0, 0, 1) },
    });
    act(() => frames.flush());
    const mounted = [...document.querySelectorAll<HTMLElement>('[role="group"][data-key]')];
    // Cull range at k = 1, tx = 0 in a 600 px viewport: world x in [−600, 1200].
    const expected = layout.frames.filter((frame) => frame.card.x + frame.card.w >= -600 && frame.card.x <= 1_200);
    expect(expected.length).toBeLessThan(layout.frames.length - 1);
    expect(mounted.map((element) => element.dataset.key)).toEqual([...expected.map((frame) => frame.key), last.key]);
  });
});

// Fix round 1 (C3-10 review I-1, I-2, M1-M7): per-frame camera writes stay compositor-only (spec §7.5 "one
// requestAnimationFrame write per frame goes to the world layer, the ruler and the minimap rectangle"; spike C1-7).
describe("CanvasView camera writes", () => {
  it("writes the camera as the world's transform, the dot grid on the viewport and the variables on the overlay only", () => {
    const { frames } = setup();
    renderWithViewer(<CanvasView active />, { session: s2, state: { follow: false, cameras: saved(-200, 10, 0.5) } });
    act(() => frames.flush());
    const viewport = canvasViewport();
    expect(canvasWorld().style.transform).toBe("translate(-200px, 10px) scale(0.5)");
    // Non-inherited properties on the viewport itself: the 20 px grid scales with k and moves with the camera.
    expect(viewport.style.backgroundPosition).toBe("-200px 10px");
    expect(viewport.style.backgroundSize).toBe("10px 10px");
    // Inherited custom properties on the viewport would restyle every world descendant per frame.
    for (const name of ["--tv-tx", "--tv-ty", "--tv-k", "--tv-inv-k"]) expect(viewport.style.getPropertyValue(name), name).toBe("");
    expect(cameraVars(viewport)).toEqual({ tx: "-200px", ty: "10px", k: "0.5" });
    expect(canvasWorld().style.getPropertyValue("--tv-inv-k")).toBe("2");
  });

  it("writes --tv-inv-k at settle and at a tween's end, never on gesture or tween frames", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { frames } = setup();
    stubReducedMotion(false);
    const harness = renderWithViewer(<CanvasView active />, { session: s2, state: { follow: false, cameras: saved(0, 0, 1) } });
    act(() => frames.flush());
    const world = canvasWorld();
    const invK = (): string => world.style.getPropertyValue("--tv-inv-k");
    expect(invK()).toBe("1");
    act(() => {
      fireEvent.wheel(canvasViewport(), { deltaY: -100, ctrlKey: true, clientX: 300, clientY: 300 });
      frames.flush();
    });
    expect(numericCamera().k).toBeGreaterThan(1);
    expect(invK()).toBe("1");
    act(() => {
      vi.advanceTimersByTime(200);
      frames.flush();
    });
    expect(Number(invK())).toBeCloseTo(1 / numericCamera().k, 9);
    // An animated fit: 180 ms of tween frames, then the end.
    act(() => harness.registry.get("canvas")?.zoom.fitAll());
    const settledInvK = invK();
    act(() => frames.step());
    act(() => frames.step());
    expect(numericCamera().k).not.toBeCloseTo(1 / Number(settledInvK), 6);
    expect(invK()).toBe(settledInvK);
    // The tween's end resolves the move (a microtask after the last tween frame, before that frame paints).
    await act(async () => {
      frames.flush();
      await Promise.resolve();
    });
    expect(Number(invK())).toBeCloseTo(1 / numericCamera().k, 9);
  });

  it("holds will-change on the world only while a gesture or a tween runs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { frames } = setup();
    stubReducedMotion(false);
    const harness = renderWithViewer(<CanvasView active />, { session: s2, state: { follow: false, cameras: saved(0, 0, 1) } });
    act(() => frames.flush());
    const world = canvasWorld();
    expect(world.style.willChange).toBe("");
    act(() => {
      fireEvent.wheel(canvasViewport(), { deltaX: 40, deltaY: 0 });
      frames.flush();
    });
    expect(world.style.willChange).toBe("transform");
    act(() => {
      vi.advanceTimersByTime(200);
      frames.flush();
    });
    expect(world.style.willChange).toBe("");
    act(() => harness.registry.get("canvas")?.zoom.fitAll());
    act(() => frames.step());
    act(() => frames.step());
    expect(world.style.willChange).toBe("transform");
    await act(async () => {
      frames.flush();
      await Promise.resolve();
    });
    expect(world.style.willChange).toBe("");
  });

  it("mounts the frames ahead during a long pan before the pan settles (M2)", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { frames } = setup();
    const wide = syntheticCanvasSession({ chapters: 60, steps: 600, turns: 3 });
    const layout = layoutCanvas(wide, buildTraceIndex(wide), canvasScale(wide), "chapter");
    renderWithViewer(<CanvasView active />, { session: wide, state: { follow: false, level: "chapter", cameras: saved(0, 0, 1) } });
    act(() => frames.flush());
    // Three viewport widths to the right, in wheel steps less than the 150 ms settle apart.
    for (let i = 0; i < 18; i += 1) {
      act(() => {
        fireEvent.wheel(canvasViewport(), { deltaX: 100, deltaY: 0 });
        frames.flush();
        vi.advanceTimersByTime(40);
      });
    }
    expect(numericCamera().tx).toBe(-1_800);
    const mounted = new Set([...document.querySelectorAll<HTMLElement>('[role="group"][data-key]')].map((element) => element.dataset.key));
    // The viewport now shows world x 1800..2400; every frame there is mounted though no settle has run.
    const visible = layout.frames.filter((frame) => frame.card.x + frame.card.w > 1_800 && frame.card.x < 2_400);
    expect(visible.length).toBeGreaterThan(0);
    for (const frame of visible) expect(mounted.has(frame.key), frame.key).toBe(true);
  });

  it("opens a small session at the k 1.5 cap (spec §7.8 rule 3)", () => {
    const { frames } = setup(2_000, 600);
    renderWithViewer(<CanvasView active />, { session: s2, state: { follow: false } });
    act(() => frames.flush());
    // (2000 − 2 · 48) / 1016 ≈ 1.87 would fit the session; the show camera caps it.
    expect(numericCamera().k).toBe(1.5);
  });

  it("releases the gesture when the view is hidden mid-gesture", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { frames } = setup();
    const harness = renderWithViewer(<CanvasView active />, { session: s2, state: { follow: false, cameras: saved(0, 0, 1) } });
    act(() => frames.flush());
    act(() => {
      fireEvent.wheel(canvasViewport(), { deltaX: 120, deltaY: 0 });
      frames.flush();
    });
    expect(harness.store.get().gesture).toBe("pan");
    act(() => harness.setUi(<CanvasView active={false} />));
    expect(harness.store.get().gesture).toBeNull();
  });

  it("a view hidden mid-show-tween does not stamp its camera as agreeing with focus (M4)", () => {
    const { frames } = setup();
    stubReducedMotion(false);
    const harness = renderWithViewer(<CanvasView active />, { session: s2, state: { follow: false } });
    act(() => frames.step());
    act(() => harness.setUi(<CanvasView active={false} />));
    const state = harness.store.get();
    expect(state.cameras.canvas === null || state.cameras.canvas.syncedRev !== state.focusRev).toBe(true);
  });

  it("ticks once a second only while shown, Live, not terminal and with a running frame", () => {
    const live: TraceSession = structuredClone(oauthCanvasSession());
    const run = live.steps.find((step) => step.command?.command === "pnpm test");
    if (run === undefined) throw new Error("no pnpm test step");
    run.endTMs = null;
    run.endTs = null;
    run.durationMs = null;
    run.status = "running";
    live.live = true;
    const { frames } = setup();
    const intervals = vi.spyOn(window, "setInterval");
    const ticks = (): number => intervals.mock.calls.filter(([, ms]) => ms === 1_000).length;
    const harness = renderWithViewer(<CanvasView active />, { session: live, state: { follow: true } });
    act(() => frames.flush());
    expect(ticks()).toBe(1);
    const cleared = vi.spyOn(window, "clearInterval");
    act(() => harness.setUi(<CanvasView active={false} />));
    expect(cleared).toHaveBeenCalled();
    cleanup();
    intervals.mockClear();
    // The same session loaded as finished (terminal): no tick.
    const done: TraceSession = { ...structuredClone(live), live: false };
    renderWithViewer(<CanvasView active />, { session: done, state: { follow: false } });
    act(() => frames.flush());
    expect(ticks()).toBe(0);
    cleanup();
    // Live but with nothing running: no tick.
    renderWithViewer(<CanvasView active />, { session: { ...oauthCanvasSession(), live: true }, state: { follow: true } });
    act(() => frames.flush());
    expect(ticks()).toBe(0);
  });

  it("the ruler translates on a pan at the same zoom without a React render, and re-lays ticks on a zoom (M6)", () => {
    const layout = layoutCanvas(s2, buildTraceIndex(s2), canvasScale(s2), "chapter");
    const base: UniformCamera = { mode: "uniform", tx: 0, ty: 0, k: 1 };
    const cameraStore = createCameraStore(base);
    let renders = 0;
    const view = render(
      <Profiler id="ruler" onRender={() => (renders += 1)}>
        <CanvasRuler
          layout={layout}
          scale={canvasScale(s2)}
          cameraStore={cameraStore}
          base={base}
          widthPx={600}
          playheadT={null}
          band={null}
          problemTs={[]}
          hatchFromT={null}
        />
      </Profiler>,
    );
    const strip = view.container.firstElementChild as HTMLElement | null;
    const mounted = renders;
    for (let i = 1; i <= 5; i += 1) act(() => cameraStore.set({ mode: "uniform", tx: -30 * i, ty: 0, k: 1 }));
    expect(renders).toBe(mounted);
    expect(strip?.style.transform).toBe("translateX(-150px)");
    act(() => cameraStore.set({ mode: "uniform", tx: -150, ty: 0, k: 1.25 }));
    expect(renders).toBeGreaterThan(mounted);
    expect(strip?.style.transform).toBe("translateX(0px)");
  });
});
