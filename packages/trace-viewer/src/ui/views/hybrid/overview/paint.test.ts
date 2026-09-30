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
import { laneCenter, LANES_BOTTOM, paintOverview, STRIP_TOP, type PaintInput } from "./paint.js";

const originalDpr = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
const originalMatchMedia = window.matchMedia;

afterEach(() => {
  cleanup();
  if (originalDpr === undefined) Reflect.deleteProperty(window, "devicePixelRatio");
  else Object.defineProperty(window, "devicePixelRatio", originalDpr);
  window.matchMedia = originalMatchMedia;
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

describe("paintOverview bands and strip", () => {
  const band = (key: string, x0: number, x1: number, tier: 0 | 1 | null) =>
    ({ key, id: null, x0, x1, labelX: Math.max(0, x0), title: key, tier, iconOnly: false }) as const;

  it("rounds bands to 6 px and starts each below its label tier", () => {
    const layout: OverviewLayout = {
      ...emptyLayout([]),
      bands: [band("a", 10, 100, 0), band("b", 40, 60, 1), band("c", 200, 300, null)],
    };
    const ctx = new RecordingContext();
    paintOverview(ctx, input(layout));
    const rounded = ctx.ops.filter((op) => op.op === "roundRect").map((op) => op.args);
    expect(rounded).toEqual([
      [10, 18, 90, LANES_BOTTOM - 18, 6],
      [40, 36, 20, LANES_BOTTOM - 36, 6],
      [200, 18, 100, LANES_BOTTOM - 18, 6],
    ]);
    expect(ctx.fillRects(LIGHT_TOKENS.fill)).toHaveLength(0);
  });

  it("fills overlapping bands once per tone, so neither fill nor fill-2 stacks", () => {
    const layout: OverviewLayout = {
      ...emptyLayout([]),
      bands: [band("a", 10, 100, 0), band("b", 50, 150, null), band("c", 80, 120, 1), band("sel", 90, 200, null)],
    };
    const ctx = new RecordingContext();
    paintOverview(ctx, input(layout, { emphasizedBands: new Set(["sel"]) }));
    const fills = ctx.ops.filter((op) => op.op === "fill");
    expect(fills.filter((op) => op.fillStyle === LIGHT_TOKENS.fill)).toHaveLength(1);
    expect(fills.filter((op) => op.fillStyle === LIGHT_TOKENS.fill2)).toHaveLength(1);
    // The plain fill is clipped away from the emphasized band: fill-2 is the only layer there.
    const clip = ctx.ops.findIndex((op) => op.op === "clip:evenodd");
    const plain = ctx.ops.findIndex((op) => op.op === "fill" && op.fillStyle === LIGHT_TOKENS.fill);
    expect(clip).toBeGreaterThanOrEqual(0);
    expect(clip).toBeLessThan(plain);
    expect(ctx.ops.slice(0, clip).some((op) => op.op === "roundRect" && op.args[0] === 90)).toBe(true);
  });

  it("keeps the session strip subtle: no track fill, no outline when the viewport shows everything", () => {
    const whole = new RecordingContext();
    paintOverview(whole, input(emptyLayout([]), { strip: { brush: null, playheadX: null, viewport: { x0: 0, x1: 600 } } }));
    expect(whole.ops.some((op) => op.op === "fillRect" && op.args[1] === STRIP_TOP && op.args[2] === 600)).toBe(false);
    expect(whole.ops.some((op) => op.op === "strokeRect" && op.args[1] === STRIP_TOP + 0.5)).toBe(false);
    const part = new RecordingContext();
    paintOverview(part, input(emptyLayout([]), { strip: { brush: null, playheadX: null, viewport: { x0: 100, x1: 300 } } }));
    expect(part.ops.some((op) => op.op === "strokeRect" && op.args[1] === STRIP_TOP + 0.5)).toBe(true);
  });
});

describe("OverviewCanvas", () => {
  it("sizes the backing store at width × DPR, hides itself from assistive tech and hands out the context", () => {
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
  });

  it("never publishes a surface at the default DPR before reading the real one", () => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    const onSurface = vi.fn();
    render(
      createElement(OverviewCanvas, {
        widthPx: 600,
        heightPx: 288,
        onSurface,
        createContext: () => new RecordingContext(),
      }),
    );
    const published = onSurface.mock.calls.map(([surface]) => surface?.dpr).filter((dpr) => dpr !== undefined);
    expect(published).toEqual([2]);
  });

  it("re-creates the surface when the DPR changes and detaches its listener on unmount", () => {
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
  });
});
