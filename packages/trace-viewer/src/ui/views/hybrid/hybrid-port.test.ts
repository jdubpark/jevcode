import { describe, expect, it } from "vitest";

import { buildSpineRows } from "../../../layout/spine-rows.js";
import { buildTimeScale, timeScaleInputOf } from "../../../layout/time-scale.js";
import { buildTraceIndex } from "../../../layout/trace-index.js";
import { LEVELS } from "../../../model/index.js";
import { foldFixture } from "../../../test-support/ui-harness.js";
import { HYBRID_PRESETS, hybridReadingOrder, isLevel, zoomReadout } from "./hybrid-port.js";

function rowsAt(level: "session" | "chapter") {
  const session = foldFixture("oauth");
  const index = buildTraceIndex(session);
  const rows = buildSpineRows(session, index, buildTimeScale(timeScaleInputOf(session)), {
    brush: { kind: "session" },
    level,
    playheadSeq: session.loadedThroughSeq,
    selection: null,
    expanded: new Set(),
    collapsed: new Set(),
    live: false,
  });
  return { session, rows };
}

describe("hybrid-port", () => {
  it("reads in spine order: step keys at Chapter level", () => {
    const { session, rows } = rowsAt("chapter");
    const steps = rows.filter((row) => row.t === "step").map((row) => row.key);
    expect(steps.length).toBeGreaterThan(0);
    expect(hybridReadingOrder(rows, session)).toEqual(steps);
  });

  it("reads chapter rows as their unit ids at Session level", () => {
    const { session, rows } = rowsAt("session");
    const order = hybridReadingOrder(rows, session);
    expect(order.length).toBeGreaterThan(0);
    expect(order.some((id) => id.startsWith("unit:"))).toBe(true);
  });

  it("reads the zoom as the level at its preset and as a percentage otherwise", () => {
    expect(zoomReadout({ mode: "xOnly", u0: 0, k: 0.02 }, 0.02, "chapter")).toBe("Chapter");
    expect(zoomReadout({ mode: "xOnly", u0: 0, k: 0.03 }, 0.02, "chapter")).toBe("150%");
    expect(zoomReadout(null, null, "session")).toBe("Session");
  });

  it("offers one preset per level", () => {
    expect(HYBRID_PRESETS.map((preset) => preset.id)).toEqual([...LEVELS]);
    expect(isLevel("step")).toBe(true);
    expect(isLevel("frame")).toBe(false);
  });
});
