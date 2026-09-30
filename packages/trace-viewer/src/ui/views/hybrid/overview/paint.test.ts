// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildOverviewIndex } from "../../../../layout/overview-index.js";
import { K_MAX, layoutOverview, type OverviewLayout } from "../../../../layout/overview-layout.js";
import { buildTimeScale, timeScaleInputOf } from "../../../../layout/time-scale.js";
import { buildTraceIndex } from "../../../../layout/trace-index.js";
import { fitRange } from "../../../../layout/viewport.js";
import { RecordingContext } from "../../../../test-support/recording-context.js";
import { oauthLikeSession } from "../../../../test-support/session-builder.js";
import { LIGHT_TOKENS } from "../../../tokens/tokens.js";
import { OverviewCanvas } from "./OverviewCanvas.js";
import { laneCenter, paintOverview, STRIP_TOP, type PaintInput } from "./paint.js";

afterEach(() => {
  cleanup();
});

function input(layout: OverviewLayout, overrides: Partial<PaintInput> = {}): PaintInput {
  return {
    layout,
    ticks: [],
    widthPx: 600,
    dpr: 2,
    tokens: LIGHT_TOKENS,
    emphasizedBands: new Set(),
    strip: { brush: null, playheadX: null, viewport: null },
    paintPins: false,
    ...overrides,
  };
}

function emptyLayout(marks: OverviewLayout["marks"]): OverviewLayout {
  return { marks, pins: [], bands: [], turnLines: [], links: [], strip: new Float64Array(600) };
}

describe("paintOverview", () => {
  it("scales by DPR, paints heat in the mark token and problems last in red", () => {
    const ctx = new RecordingContext();
    paintOverview(
      ctx,
      input(
        emptyLayout([
          { op: "problem", lane: "tests", x: 100 },
          { op: "heat", lane: "tests", x: 100, count: 12, h: 8 },
          { op: "dot", lane: "agent", x: 40, tone: "neutral" },
          { op: "dot", lane: "tests", x: 60, tone: "bad" },
        ]),
      ),
    );
    expect(ctx.ops[0]).toMatchObject({ op: "setTransform", args: [2, 0, 0, 2, 0, 0] });
    const heat = ctx.ops.findIndex((op) => op.op === "fillRect" && op.fillStyle === LIGHT_TOKENS.mark && op.args[3] === 8);
    const problem = ctx.ops.findIndex(
      (op) => op.op === "fillRect" && op.fillStyle === LIGHT_TOKENS.bad && op.args[2] === 2 && op.args[3] === 10,
    );
    expect(heat).toBeGreaterThanOrEqual(0);
    expect(problem).toBeGreaterThan(heat);
    expect(ctx.ops[problem]?.args).toEqual([99, laneCenter("tests") - 5, 2, 10]);
    expect(ctx.filledArcs(LIGHT_TOKENS.bad).map((arc) => arc.args[0])).toEqual([60]);
    expect(ctx.filledArcs(LIGHT_TOKENS.mark).map((arc) => arc.args[0])).toEqual([40]);
    expect(ctx.ops.some((op) => op.op === "fillRect" && op.fillStyle === LIGHT_TOKENS.ink4 && op.args[3] === 8)).toBe(false);
  });

  it("keeps every problem tick of a real Session-level layout", () => {
    const session = oauthLikeSession();
    const index = buildTraceIndex(session);
    const scale = buildTimeScale(timeScaleInputOf(session));
    const overview = buildOverviewIndex(session, index, scale);
    const camera = fitRange(0, scale.endU, 600, { padFraction: 0.04, limits: { minK: 1e-6, maxK: K_MAX } });
    const layout = layoutOverview({ overview, camera, widthPx: 600, level: "session" });
    const problems = layout.marks.filter((mark) => mark.op === "problem");
    expect(problems.length).toBeGreaterThan(0);
    const ctx = new RecordingContext();
    paintOverview(ctx, input(layout));
    const ticks = ctx.fillRects(LIGHT_TOKENS.bad).filter((op) => op.args[2] === 2 && op.args[3] === 10);
    expect(ticks).toHaveLength(problems.length);
  });

  it("paints the strip overlays and, under the risk 5 ruling, the pins", () => {
    const layout: OverviewLayout = {
      ...emptyLayout([]),
      pins: [
        { key: "p1", lane: "tests", x: 200, kind: "failed", critical: true, stepIndexes: [3], cluster: false, findingId: null },
        { key: "p2", lane: "agent", x: 260, kind: "instruction", critical: false, stepIndexes: [0], cluster: false, findingId: null },
      ],
    };
    const ctx = new RecordingContext();
    paintOverview(ctx, input(layout, { strip: { brush: { x0: 100, x1: 300 }, playheadX: 250, viewport: null }, paintPins: true }));
    expect(ctx.fillRects(LIGHT_TOKENS.accentSoft).some((op) => op.args[0] === 100 && op.args[1] === STRIP_TOP)).toBe(true);
    expect(ctx.fillRects(LIGHT_TOKENS.accent).some((op) => op.args[0] === 250 && op.args[2] === 1)).toBe(true);
    expect(ctx.ops.filter((op) => op.op === "arc" && op.args[2] === 11)).toHaveLength(2);
  });
});

describe("OverviewCanvas", () => {
  it("sizes the backing store at width × DPR, hides itself from assistive tech and hands out the context", () => {
    const original = window.devicePixelRatio;
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    const recording = new RecordingContext();
    const onSurface = vi.fn();
    const { container } = render(
      createElement(OverviewCanvas, { widthPx: 600, heightPx: 288, onSurface, createContext: () => recording }),
    );
    const canvas = container.querySelector("canvas");
    expect(canvas?.getAttribute("aria-hidden")).toBe("true");
    expect(canvas?.getAttribute("width")).toBe("1200");
    expect(canvas?.getAttribute("height")).toBe("576");
    expect(onSurface).toHaveBeenLastCalledWith({ ctx: recording, dpr: 2, widthPx: 600, heightPx: 288 });
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: original });
  });

  it("re-creates the surface when the DPR changes and detaches its listener on unmount", () => {
    const original = window.devicePixelRatio;
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
    const listeners = new Set<() => void>();
    window.matchMedia = ((): MediaQueryList =>
      ({
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
    const recording = new RecordingContext();
    const onSurface = vi.fn();
    const { container, unmount } = render(
      createElement(OverviewCanvas, { widthPx: 600, heightPx: 288, onSurface, createContext: () => recording }),
    );
    expect(container.querySelector("canvas")?.getAttribute("width")).toBe("600");
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    act(() => {
      for (const listener of listeners) listener();
    });
    expect(container.querySelector("canvas")?.getAttribute("width")).toBe("1200");
    expect(onSurface).toHaveBeenLastCalledWith(expect.objectContaining({ dpr: 2 }));
    unmount();
    expect(listeners.size).toBe(0);
    expect(onSurface).toHaveBeenLastCalledWith(null);
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: original });
    window.matchMedia = originalMatchMedia;
  });
});
