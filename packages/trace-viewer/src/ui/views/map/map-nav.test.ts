import { describe, expect, it } from "vitest";

import { layoutMap } from "../../../layout/map-layout.js";
import { buildOverviewModel } from "../../../model/index.js";
import { componentId, overviewSnapshot } from "../../../test-support/overview-builder.js";
import { isMapNavKey, mapNeighbor } from "./map-nav.js";

// Bands: ui [a, b], domain [x, y, z]; no edges, so each band is in name order.
const layout = layoutMap(
  buildOverviewModel(
    overviewSnapshot({
      components: [
        { rootPath: "ui/a", role: "ui" },
        { rootPath: "ui/b", role: "ui" },
        { rootPath: "d/x", role: "domain" },
        { rootPath: "d/y", role: "domain" },
        { rootPath: "d/z", role: "domain" },
      ],
    }),
    1,
  ),
  { level: "card" },
);
const id = componentId;

describe("mapNeighbor", () => {
  it("knows its keys", () => {
    expect(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].every(isMapNavKey)).toBe(true);
    expect(isMapNavKey("Enter")).toBe(false);
  });

  it("moves down and up within a band and stops at its ends", () => {
    expect(mapNeighbor(layout, id("ui/a"), "ArrowDown")).toBe(id("ui/b"));
    expect(mapNeighbor(layout, id("ui/b"), "ArrowDown")).toBeNull();
    expect(mapNeighbor(layout, id("d/y"), "ArrowUp")).toBe(id("d/x"));
    expect(mapNeighbor(layout, id("ui/a"), "ArrowUp")).toBeNull();
  });

  it("moves across bands to the card nearest in height, the upper one on a tie", () => {
    expect(mapNeighbor(layout, id("ui/b"), "ArrowRight")).toBe(id("d/y"));
    expect(mapNeighbor(layout, id("d/z"), "ArrowLeft")).toBe(id("ui/b"));
    expect(mapNeighbor(layout, id("d/x"), "ArrowRight")).toBeNull();
    expect(mapNeighbor(layout, id("ui/a"), "ArrowLeft")).toBeNull();
  });

  it("jumps with Home and End, and starts at the first card without a focus", () => {
    expect(mapNeighbor(layout, id("d/y"), "Home")).toBe(id("ui/a"));
    expect(mapNeighbor(layout, id("ui/a"), "End")).toBe(id("d/z"));
    expect(mapNeighbor(layout, null, "ArrowDown")).toBe(id("ui/a"));
    expect(mapNeighbor(layout, "cmp_000000000000", "ArrowRight")).toBe(id("ui/a"));
  });
});
