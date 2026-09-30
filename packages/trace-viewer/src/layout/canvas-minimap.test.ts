import { describe, expect, it } from "vitest";

import { canvasScale, oauthCanvasSession } from "../test-support/canvas-arbitraries.js";
import type { CanvasFrame } from "./canvas-layout.js";
import { layoutCanvas } from "./canvas-layout.js";
import { MINIMAP_H, MINIMAP_W, buildMinimap, minimapToWorld, type MinimapSource } from "./canvas-minimap.js";
import { buildTraceIndex } from "./trace-index.js";

// Expected values: spec §7.5 "Minimap": s = max(min(140/B.w, 84/B.h), 0.03); a window when s·B.w > 140.

function frame(key: string, x: number, y: number): CanvasFrame {
  return {
    key,
    selId: `unit:${key}`,
    kind: "chapter",
    item: "chapter",
    col: 0,
    row: 1,
    slot: { x, y, w: 224, h: 134 },
    card: { x, y: y + 22, w: 224, h: 112 },
    label: { x, y, w: 224, h: 16 },
    members: [key],
    memberSelIds: [`unit:${key}`],
    late: false,
  };
}

describe("buildMinimap", () => {
  it("scales the oauth layout to fit 140 × 84 with no window", () => {
    const session = oauthCanvasSession();
    const layout = layoutCanvas(session, buildTraceIndex(session), canvasScale(session), "chapter");
    const selected = layout.frames[1]?.key ?? null;
    const model = buildMinimap(layout, {
      viewportWorld: { x: 0, y: 0, w: 800, h: 600 },
      selectedKey: selected,
      criticalKeys: new Set(),
    });
    expect(model.scale).toBeCloseTo(84 / 658, 10);
    expect(model.window).toBeNull();
    expect(model.strip).toBeNull();
    expect(model.frames).toHaveLength(layout.frames.length);
    expect(model.frames.find((mark) => mark.key === selected)?.mark).toBe("selected");
    expect(model.frames.filter((mark) => mark.mark === "noise")).toHaveLength(1);
    expect(model.edges).toHaveLength(1);
    expect(model.viewport).toEqual({ x: 0, y: 0, w: 800 * model.scale, h: 600 * model.scale });
  });

  it("shows a window and a session strip with red ticks for a long session", () => {
    const layout: MinimapSource = {
      bounds: { x: 0, y: 0, w: 8_000, h: 750 },
      frames: [frame("early", 100, 150), frame("late", 7_700, 150)],
      edges: [],
      separators: [],
    };
    const model = buildMinimap(layout, {
      viewportWorld: { x: 3_000, y: 0, w: 1_000, h: 700 },
      selectedKey: null,
      criticalKeys: new Set(["late"]),
    });
    expect(model.scale).toBe(0.03);
    const span = MINIMAP_W / 0.03;
    expect(model.window?.x0).toBeCloseTo(3_500 - span / 2, 6);
    expect(model.window?.x1).toBeCloseTo(3_500 + span / 2, 6);
    expect(model.frames).toEqual([]);
    expect(model.strip?.bracket[0]).toBeCloseTo(((3_500 - span / 2) / 8_000) * MINIMAP_W, 6);
    expect(model.strip?.critical).toEqual([((7_700 + 112) / 8_000) * MINIMAP_W]);
  });

  it("clamps the window to the session bounds", () => {
    const layout: MinimapSource = { bounds: { x: 0, y: 0, w: 8_000, h: 750 }, frames: [], edges: [], separators: [] };
    const model = buildMinimap(layout, {
      viewportWorld: { x: 7_900, y: 0, w: 1_000, h: 700 },
      selectedKey: null,
      criticalKeys: new Set(),
    });
    expect(model.window?.x1).toBeCloseTo(8_000, 6);
  });

  it("minimapToWorld inverts the scale", () => {
    const session = oauthCanvasSession();
    const layout = layoutCanvas(session, buildTraceIndex(session), canvasScale(session), "chapter");
    const model = buildMinimap(layout, {
      viewportWorld: { x: 0, y: 0, w: 800, h: 600 },
      selectedKey: null,
      criticalKeys: new Set(),
    });
    for (const mark of model.frames) {
      const card = layout.frameByKey.get(mark.key)?.card;
      const world = minimapToWorld(model, { x: mark.rect.x, y: mark.rect.y });
      expect(world.x).toBeCloseTo(card?.x ?? NaN, 6);
      expect(world.y).toBeCloseTo(card?.y ?? NaN, 6);
    }
    expect(minimapToWorld(model, { x: MINIMAP_W, y: MINIMAP_H }).y).toBeCloseTo(MINIMAP_H / model.scale, 6);
  });
});
