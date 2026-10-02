// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { Activity } from "react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { layoutCanvas } from "../../layout/canvas-layout.js";
import { LEVEL_SPECS } from "../../layout/canvas-levels.js";
import type { Level } from "../../model/index.js";
import { createStaticBundleSource } from "../../sources/static-bundle.js";
import { buildCanvasSession, oauthCanvasBundle, oauthCanvasSession } from "../../test-support/canvas-arbitraries.js";
import {
  cameraVars,
  canvasViewport,
  renderWithViewer,
  sessionViewOf,
  stubAnimationFrames,
  stubElementBox,
  stubReducedMotion,
  stubResizeObserver,
} from "../../test-support/canvas-view-harness.js";
import { TraceViewer } from "../shell/TraceViewer.js";
import type { ViewerLocation } from "../state/location.js";
import { useView } from "../state/store.js";
import { initialViewState, type ViewState } from "../state/view-state.js";
import { KEEP_HIDDEN_VIEWS_MOUNTED, VIEWS } from "./registry.js";

// A pass-through spy: every call runs the real layout (lane review I-5 counts them).
vi.mock("../../layout/canvas-layout.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../layout/canvas-layout.js")>();
  return { ...actual, layoutCanvas: vi.fn(actual.layoutCanvas) };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The real Canvas from VIEWS beside an inert Hybrid stand-in, so listener and rAF counts belong to the Canvas. */
function Switcher(): React.JSX.Element {
  const view = useView((state) => state.view);
  const canvas = VIEWS.find((definition) => definition.kind === "canvas");
  if (canvas === undefined) throw new Error("Canvas is not registered");
  const Canvas = canvas.Component;
  const hybrid = <section aria-label="Hybrid stand-in" />;
  if (!KEEP_HIDDEN_VIEWS_MOUNTED) {
    return view === "canvas" ? <Canvas active /> : hybrid;
  }
  return (
    <>
      <Activity mode={view === "canvas" ? "visible" : "hidden"}>
        <Canvas active={view === "canvas"} />
      </Activity>
      <Activity mode={view === "hybrid" ? "visible" : "hidden"}>{hybrid}</Activity>
    </>
  );
}

function withoutCameras(state: ViewState): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...state };
  delete copy.cameras;
  return copy;
}

const SYNCED = initialViewState({ live: false }).focusRev;

describe("view registry", () => {
  it("registers Console, Canvas, Hybrid and Map in key order", () => {
    expect(VIEWS.map((definition) => [definition.kind, definition.label, definition.icon])).toEqual([
      ["console", "Console", "view-console"],
      ["canvas", "Canvas", "view-canvas"],
      ["hybrid", "Hybrid", "view-hybrid"],
      ["map", "Map", "view-map"],
    ]);
  });
});

describe("switching views under <Activity>", () => {
  it("1, 2, 1 leaves every non-camera field unchanged and restores the canvas camera exactly", () => {
    stubElementBox(900, 600);
    stubResizeObserver();
    const frames = stubAnimationFrames();
    stubReducedMotion(true);
    const harness = renderWithViewer(<Switcher />, {
      session: oauthCanvasSession(),
      state: { view: "canvas", cameras: { canvas: { mode: "uniform", tx: -120, ty: 30, k: 0.8, syncedRev: SYNCED }, hybrid: null } },
    });
    act(() => frames.flush());
    const before = cameraVars(canvasViewport());
    expect(before).toEqual({ tx: "-120px", ty: "30px", k: "0.8" });
    const start = withoutCameras(harness.store.get());
    act(() => harness.store.dispatch({ type: "view/switch", view: "hybrid" }));
    act(() => harness.store.dispatch({ type: "view/switch", view: "canvas" }));
    act(() => frames.flush());
    expect(cameraVars(canvasViewport())).toEqual(before);
    expect(withoutCameras(harness.store.get())).toEqual(start);
  });

  it("refits the brush horizontally within [minZoom, 1.5] and keeps ty when focus changed while hidden", () => {
    stubElementBox(900, 600);
    stubResizeObserver();
    const frames = stubAnimationFrames();
    stubReducedMotion(true);
    const session = oauthCanvasSession();
    const harness = renderWithViewer(<Switcher />, {
      session,
      state: { view: "canvas", cameras: { canvas: { mode: "uniform", tx: -120, ty: 30, k: 0.8, syncedRev: SYNCED }, hybrid: null } },
    });
    act(() => frames.flush());
    act(() => harness.store.dispatch({ type: "view/switch", view: "hybrid" }));
    act(() => harness.store.dispatch({ type: "select", id: "unit:oauth-linking-test-failure", by: "shell" }));
    act(() => harness.store.dispatch({ type: "view/switch", view: "canvas" }));
    act(() => frames.flush());
    const after = cameraVars(canvasViewport());
    const k = Number(after.k);
    expect(k).toBeGreaterThanOrEqual(LEVEL_SPECS.chapter.minZoom);
    expect(k).toBeLessThanOrEqual(1.5);
    // Spec §7.8 item 3: the brush (whole session, 1016 px) fits horizontally: k = (900 − 2 · 48) / 1016.
    expect(k).toBeCloseTo((900 - 96) / 1016, 6);
    expect(after.ty).toBe("30px");
  });

  it.each<Level>(["session", "step"])(
    "level/set %s while hidden: the Canvas returns at the new level with the brush refit",
    (level) => {
      stubElementBox(900, 600);
      stubResizeObserver();
      const frames = stubAnimationFrames();
      stubReducedMotion(true);
      const session = oauthCanvasSession();
      const harness = renderWithViewer(<Switcher />, {
        session,
        state: { view: "canvas", cameras: { canvas: { mode: "uniform", tx: -120, ty: 30, k: 0.8, syncedRev: SYNCED }, hybrid: null } },
      });
      act(() => frames.flush());
      act(() => harness.store.dispatch({ type: "view/switch", view: "hybrid" }));
      act(() => harness.store.dispatch({ type: "level/set", level, by: "shell" }));
      act(() => harness.store.dispatch({ type: "view/switch", view: "canvas" }));
      act(() => frames.flush());
      // Spec §7.8 item 3 at the new level: the whole-session brush fits horizontally, clamped to [minZoom, 1.5].
      const view = sessionViewOf(session);
      const bounds = layoutCanvas(session, view.index, view.scale, level).bounds;
      const k = Math.min(1.5, Math.max(LEVEL_SPECS[level].minZoom, (900 - 96) / bounds.w));
      const after = cameraVars(canvasViewport());
      expect(Number(after.k)).toBeGreaterThanOrEqual(LEVEL_SPECS[level].minZoom);
      expect(Number(after.k)).toBeLessThanOrEqual(1.5);
      expect(Number(after.k)).toBeCloseTo(k, 6);
      expect(Number.parseFloat(after.tx)).toBeCloseTo((900 - bounds.w * k) / 2 - bounds.x * k, 4);
      expect(after.ty).toBe("30px");
    },
  );

  it("a Live append while hidden does not run the follow pan on show; the synced camera is restored exactly", () => {
    stubElementBox(900, 600);
    stubResizeObserver();
    const frames = stubAnimationFrames();
    stubReducedMotion(true);
    const early = buildCanvasSession([{ atMs: 8_000, kind: "plan" }, { atMs: 10_000, kind: "chapter" }], { live: true });
    const later = buildCanvasSession(
      [
        { atMs: 8_000, kind: "plan" },
        { atMs: 10_000, kind: "chapter" },
        { atMs: 25_000, kind: "decision" },
        { atMs: 40_000, kind: "chapter" },
        { atMs: 55_000, kind: "chapter" },
        { atMs: 70_000, kind: "chapter" },
      ],
      { live: true },
    );
    const harness = renderWithViewer(<Switcher />, {
      session: early,
      state: { view: "canvas", cameras: { canvas: { mode: "uniform", tx: 40, ty: 30, k: 1, syncedRev: SYNCED }, hybrid: null } },
    });
    act(() => frames.flush());
    expect(harness.store.get().follow).toBe(true);
    const before = cameraVars(canvasViewport());
    act(() => harness.store.dispatch({ type: "view/switch", view: "hybrid" }));
    act(() => harness.setSession(later));
    const rev = harness.store.get().focusRev;
    act(() => harness.store.dispatch({ type: "view/switch", view: "canvas" }));
    act(() => frames.flush());
    expect(harness.store.get().focusRev).toBe(rev);
    expect(cameraVars(canvasViewport())).toEqual(before);
  });

  it("a hidden Canvas does not call layoutCanvas on a data commit, and lays out once on show", () => {
    stubElementBox(900, 600);
    stubResizeObserver();
    const frames = stubAnimationFrames();
    stubReducedMotion(true);
    const seeds = [{ atMs: 8_000, kind: "plan" as const }, { atMs: 10_000, kind: "chapter" as const }];
    const early = buildCanvasSession(seeds, { live: true });
    const mid = buildCanvasSession([...seeds, { atMs: 25_000, kind: "decision" }], { live: true });
    const later = buildCanvasSession([...seeds, { atMs: 25_000, kind: "decision" }, { atMs: 40_000, kind: "chapter" }], { live: true });
    const harness = renderWithViewer(<Switcher />, { session: early, state: { view: "canvas" } });
    act(() => frames.flush());
    act(() => harness.store.dispatch({ type: "view/switch", view: "hybrid" }));
    const layoutSpy = vi.mocked(layoutCanvas);
    layoutSpy.mockClear();
    act(() => harness.setSession(mid));
    act(() => harness.setSession(later));
    act(() => frames.flush());
    expect(layoutSpy).not.toHaveBeenCalled();
    act(() => harness.store.dispatch({ type: "view/switch", view: "canvas" }));
    act(() => frames.flush());
    expect(layoutSpy).toHaveBeenCalledTimes(1);
    // Same level and session: the show layout is sticky, chained through the last committed one (P6 skips appends).
    expect(layoutSpy.mock.calls[0]?.[0]).toBe(later);
    expect(layoutSpy.mock.calls[0]?.[4]).toBeDefined();
    const chapters = later.chapters.length;
    expect(canvasViewport().querySelectorAll('[role="group"][data-kind="chapter"]')).toHaveLength(chapters);
  });

  it("a Canvas mounted hidden lays out nothing until it is shown", () => {
    stubElementBox(900, 600);
    stubResizeObserver();
    const frames = stubAnimationFrames();
    stubReducedMotion(true);
    const layoutSpy = vi.mocked(layoutCanvas);
    layoutSpy.mockClear();
    const harness = renderWithViewer(<Switcher />, { session: oauthCanvasSession(), state: { view: "hybrid" } });
    act(() => frames.flush());
    expect(layoutSpy).not.toHaveBeenCalled();
    act(() => harness.store.dispatch({ type: "view/switch", view: "canvas" }));
    act(() => frames.flush());
    expect(layoutSpy).toHaveBeenCalledTimes(1);
    expect(layoutSpy.mock.calls[0]?.[4]).toBeUndefined();
  });

  it("never fits a 0x0 rect", () => {
    const observers = stubResizeObserver();
    const frames = stubAnimationFrames();
    stubReducedMotion(true);
    renderWithViewer(<Switcher />, { session: oauthCanvasSession(), state: { view: "canvas" } });
    act(() => frames.flush());
    // jsdom lays nothing out: the viewport is 0 × 0, so the default camera stays and no fit runs.
    expect(cameraVars(canvasViewport())).toEqual({ tx: "48px", ty: "48px", k: "1" });
    act(() => observers.resize(0, 600));
    act(() => frames.flush());
    expect(cameraVars(canvasViewport())).toEqual({ tx: "48px", ty: "48px", k: "1" });
    act(() => observers.resize(900, 600));
    act(() => frames.flush());
    expect(Number(cameraVars(canvasViewport()).k)).toBeCloseTo((900 - 96) / 1016, 6);
  });

  it("a hidden view holds no listeners and schedules no animation frames", () => {
    stubElementBox(900, 600);
    const observers = stubResizeObserver();
    const frames = stubAnimationFrames();
    stubReducedMotion(true);
    const add = vi.spyOn(EventTarget.prototype, "addEventListener");
    const remove = vi.spyOn(EventTarget.prototype, "removeEventListener");
    const early = buildCanvasSession([{ atMs: 8_000, kind: "plan" }, { atMs: 10_000, kind: "chapter" }], { live: true });
    const later = buildCanvasSession(
      [{ atMs: 8_000, kind: "plan" }, { atMs: 10_000, kind: "chapter" }, { atMs: 25_000, kind: "decision" }],
      { live: true },
    );
    const harness = renderWithViewer(<Switcher />, { session: early, state: { view: "canvas" } });
    act(() => frames.flush());
    const viewport = canvasViewport();
    const net = (): number =>
      add.mock.calls.filter((call, i) => call[0] === "wheel" && add.mock.contexts[i] === viewport).length -
      remove.mock.calls.filter((call, i) => call[0] === "wheel" && remove.mock.contexts[i] === viewport).length;
    expect(net()).toBe(1);
    act(() => harness.store.dispatch({ type: "view/switch", view: "hybrid" }));
    expect(net()).toBe(0);
    expect(observers.count()).toBe(0);
    const callsWhileHidden = frames.calls();
    act(() => harness.setSession(later));
    act(() => frames.flush());
    expect(frames.calls()).toBe(callsWhileHidden);
  });
});

describe("switching views in TraceViewer", () => {
  it(
    "1, 2, 1 on the keyboard restores the canvas camera and carries the location",
    async () => {
      stubElementBox(1000, 700);
      stubResizeObserver();
      stubReducedMotion(true);
      const bundle = oauthCanvasBundle();
      const locations: ViewerLocation[] = [];
      render(
        <TraceViewer
          source={createStaticBundleSource(bundle)}
          host={{ onLocation: (location) => locations.push(location) }}
          location={{ v: 1, sessionId: bundle.session.sessionId, view: "hybrid", level: "chapter", brush: { kind: "session" } }}
          pollMs={60_000}
        />,
      );
      await waitFor(() => expect(locations.at(-1)?.selected).toBeDefined(), { timeout: 5_000 });
      const user = userEvent.setup();
      screen.getByRole("main").querySelector<HTMLElement>('[tabindex="0"]')?.focus();
      await user.keyboard("1");
      await screen.findByRole("group", { name: /^OAuth account-linking test failure/ });
      await waitFor(() => expect(canvasViewport().style.getPropertyValue("--tv-k")).not.toBe("1"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const shown = cameraVars(canvasViewport());
      const canvasLocation = locations.at(-1);
      expect(canvasLocation?.view).toBe("canvas");
      await user.keyboard("2");
      await waitFor(() => expect(locations.at(-1)?.view).toBe("hybrid"));
      await user.keyboard("1");
      await waitFor(() => expect(locations.at(-1)?.view).toBe("canvas"));
      expect(cameraVars(canvasViewport())).toEqual(shown);
      expect(locations.at(-1)).toEqual(canvasLocation);
    },
    15_000,
  );
});
