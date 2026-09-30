// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { layoutCanvas } from "../../../layout/canvas-layout.js";
import { buildTraceIndex } from "../../../layout/trace-index.js";
import type { Level } from "../../../model/index.js";
import { canvasScale, oauthCanvasSession } from "../../../test-support/canvas-arbitraries.js";
import type { Tool } from "../../state/view-state.js";
import { createCameraStore } from "./canvas-camera.js";
import { Minimap } from "./Minimap.js";
import { Toolbar } from "./Toolbar.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const session = oauthCanvasSession();
const layout = layoutCanvas(session, buildTraceIndex(session), canvasScale(session), "chapter");
// Spec §7.5: s = max(min(140 / 1016, 84 / 658), 0.03) = 84 / 658 for oauth.
const SCALE = 84 / 658;

function renderMinimap() {
  const onCenter = vi.fn();
  const onPan = vi.fn();
  const view = render(
    <Minimap
      layout={layout}
      cameraStore={createCameraStore({ mode: "uniform", tx: 0, ty: 0, k: 1 })}
      viewport={{ w: 800, h: 600 }}
      selectedKey={null}
      criticalKeys={new Set()}
      onCenter={onCenter}
      onPan={onPan}
    />,
  );
  return { onCenter, onPan, view };
}

describe("Minimap", () => {
  it("centers at the clicked world point", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, width: 140, height: 84, right: 140, bottom: 84, toJSON: () => ({}),
    } as DOMRect);
    const { onCenter, view } = renderMinimap();
    const svg = view.container.querySelector("svg[data-minimap]");
    if (svg === null) throw new Error("no minimap");
    fireEvent.pointerDown(svg, { clientX: 70, clientY: 42 });
    const [world] = onCenter.mock.calls[0] ?? [];
    expect(world?.x).toBeCloseTo(70 / SCALE, 6);
    expect(world?.y).toBeCloseTo(42 / SCALE, 6);
  });

  it("pans when the viewport outline is dragged, without centering", () => {
    const { onCenter, onPan, view } = renderMinimap();
    const outline = view.container.querySelector("[data-viewport]");
    if (outline === null) throw new Error("no viewport outline");
    fireEvent.pointerDown(outline, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(outline, { clientX: 24, clientY: 10, pointerId: 1, buttons: 1 });
    fireEvent.pointerUp(outline, { pointerId: 1 });
    expect(onCenter).not.toHaveBeenCalled();
    const [dx, dy] = onPan.mock.calls[0] ?? [];
    expect(dx).toBeCloseTo(14 / SCALE, 6);
    expect(dy).toBe(0);
  });

  it("centers only for the primary button and stops a drag whose pointer capture is lost", () => {
    const { onCenter, onPan, view } = renderMinimap();
    const svg = view.container.querySelector("svg[data-minimap]");
    const outline = view.container.querySelector("[data-viewport]");
    if (svg === null || outline === null) throw new Error("no minimap");
    fireEvent.pointerDown(svg, { clientX: 70, clientY: 42, button: 2 });
    expect(onCenter).not.toHaveBeenCalled();
    fireEvent.pointerDown(outline, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.lostPointerCapture(outline, { pointerId: 1 });
    fireEvent.pointerMove(outline, { clientX: 30, clientY: 10, pointerId: 1, buttons: 1 });
    fireEvent.pointerDown(outline, { clientX: 10, clientY: 10, pointerId: 2 });
    fireEvent.pointerMove(outline, { clientX: 30, clientY: 10, pointerId: 2, buttons: 0 });
    fireEvent.pointerMove(outline, { clientX: 50, clientY: 10, pointerId: 2, buttons: 1 });
    expect(onPan).not.toHaveBeenCalled();
  });

  it("keys strip ticks and separators without clashes when two critical frames share a column", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Wider than 140 / 0.03 world px, so the minimap shows a window and the full-width strip.
    const wide = { ...layout, bounds: { ...layout.bounds, w: 6_000 } };
    const column = layout.frames.filter((frame) => frame.card.x === layout.frames.find((f) => f.kind === "chapter")?.card.x);
    expect(column.length).toBeGreaterThanOrEqual(2);
    const view = render(
      <Minimap
        layout={wide}
        cameraStore={createCameraStore({ mode: "uniform", tx: 0, ty: 0, k: 1 })}
        viewport={{ w: 800, h: 600 }}
        selectedKey={null}
        criticalKeys={new Set(column.map((frame) => frame.key))}
        onCenter={vi.fn()}
        onPan={vi.fn()}
      />,
    );
    expect(view.container.querySelectorAll("svg:not([data-minimap]) rect")).toHaveLength(1 + column.length);
    expect(error.mock.calls.filter(([message]) => String(message).includes("same key"))).toEqual([]);
  });

  it("moves only the viewport outline on a camera frame, with no React render (C3-10 review I-2)", () => {
    const cameraStore = createCameraStore({ mode: "uniform", tx: 0, ty: 0, k: 1 });
    let renders = 0;
    const view = render(
      <Profiler id="minimap" onRender={() => (renders += 1)}>
        <Minimap
          layout={layout}
          cameraStore={cameraStore}
          viewport={{ w: 800, h: 600 }}
          selectedKey={null}
          criticalKeys={new Set()}
          onCenter={vi.fn()}
          onPan={vi.fn()}
        />
      </Profiler>,
    );
    const outline = view.container.querySelector("[data-viewport]");
    if (outline === null) throw new Error("no viewport outline");
    const mounted = renders;
    for (let i = 1; i <= 5; i += 1) act(() => cameraStore.set({ mode: "uniform", tx: -40 * i, ty: -10 * i, k: 1 }));
    act(() => cameraStore.set({ mode: "uniform", tx: -200, ty: -50, k: 2 }));
    expect(renders).toBe(mounted);
    // The viewport's world rect (100, 25, 400, 300) in minimap px: (world − bounds origin) · s.
    expect(Number(outline.getAttribute("x"))).toBeCloseTo((100 - layout.bounds.x) * SCALE, 6);
    expect(Number(outline.getAttribute("y"))).toBeCloseTo((25 - layout.bounds.y) * SCALE, 6);
    expect(Number(outline.getAttribute("width"))).toBeCloseTo(400 * SCALE, 6);
    expect(Number(outline.getAttribute("height"))).toBeCloseTo(300 * SCALE, 6);
  });

  it("re-windows a wide session only when the view moves a quarter of the window span", () => {
    // 6000 world px at the 0.03 floor: the window spans 140 / 0.03 ≈ 4667 world px.
    const wide = { ...layout, bounds: { ...layout.bounds, w: 6_000 } };
    const cameraStore = createCameraStore({ mode: "uniform", tx: 0, ty: 0, k: 1 });
    let renders = 0;
    const view = render(
      <Profiler id="minimap" onRender={() => (renders += 1)}>
        <Minimap
          layout={wide}
          cameraStore={cameraStore}
          viewport={{ w: 800, h: 600 }}
          selectedKey={null}
          criticalKeys={new Set()}
          onCenter={vi.fn()}
          onPan={vi.fn()}
        />
      </Profiler>,
    );
    const bracket = (): number => Number(view.container.querySelector("svg:not([data-minimap]) rect")?.getAttribute("x"));
    const mounted = renders;
    expect(bracket()).toBe(0);
    act(() => cameraStore.set({ mode: "uniform", tx: -600, ty: 0, k: 1 }));
    expect(renders).toBe(mounted);
    // Center 400 → 2600 world px, more than a quarter span: the window slides to x0 = 1333 (clamped at 6000 − span).
    act(() => cameraStore.set({ mode: "uniform", tx: -2_200, ty: 0, k: 1 }));
    expect(renders).toBe(mounted + 1);
    expect(bracket()).toBeGreaterThan(0);
  });

  it("draws the rest contradicts edge and one mark per frame", () => {
    const { view } = renderMinimap();
    expect(view.container.querySelectorAll("path")).toHaveLength(1);
    expect(view.container.querySelectorAll("rect[data-mark]")).toHaveLength(layout.frames.length);
  });
});

describe("Toolbar", () => {
  function props(overrides: Partial<{ tool: Tool; level: Level; holes: number }> = {}) {
    return {
      tool: overrides.tool ?? ("select" as Tool),
      level: overrides.level ?? ("chapter" as Level),
      holes: overrides.holes ?? 0,
      onTool: vi.fn(),
      onLevel: vi.fn(),
      onFit: vi.fn(),
      onTidy: vi.fn(),
    };
  }

  it("offers Tidy only when the layout has holes and has no comment tool", () => {
    const base = props();
    const view = render(<Toolbar {...base} />);
    expect(screen.queryByRole("button", { name: "Tidy layout" })).toBeNull();
    expect(screen.queryByRole("button", { name: /comment/i })).toBeNull();
    view.rerender(<Toolbar {...base} holes={2} />);
    fireEvent.click(screen.getByRole("button", { name: "Tidy layout" }));
    expect(base.onTidy).toHaveBeenCalledTimes(1);
  });

  it("reflects the tool and level and reports changes", () => {
    const base = props({ tool: "hand" });
    render(<Toolbar {...base} />);
    expect(screen.getByRole("button", { name: "Hand (H)" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("radio", { name: "Chapter" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Session" }));
    expect(base.onLevel).toHaveBeenCalledWith("session");
    fireEvent.click(screen.getByRole("button", { name: "Select (V)" }));
    expect(base.onTool).toHaveBeenCalledWith("select");
    fireEvent.click(screen.getByRole("button", { name: "Fit (Shift+1)" }));
    expect(base.onFit).toHaveBeenCalledTimes(1);
    for (const button of screen.getAllByRole("button")) expect(button.getAttribute("tabindex")).toBe("-1");
  });

  it("moves the level with the arrow keys and wraps", () => {
    const base = props({ level: "step" });
    render(<Toolbar {...base} />);
    fireEvent.keyDown(screen.getByRole("radio", { name: "Step" }), { key: "ArrowRight" });
    expect(base.onLevel).toHaveBeenCalledWith("session");
  });
});
