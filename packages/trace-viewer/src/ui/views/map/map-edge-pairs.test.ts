import { describe, expect, it } from "vitest";

import { layoutMap, mapHubIds } from "../../../layout/map-layout.js";
import { buildOverviewModel } from "../../../model/index.js";
import { componentId, overviewSnapshot, syntheticOverview } from "../../../test-support/overview-builder.js";
import { mapDrawnEdges } from "./map-edge-pairs.js";

const id = componentId;
const key = (from: string, to: string): string => `${id(from)}>${id(to)}`;

function layoutOf(edges: readonly { from: string; to: string; count: number }[]) {
  return layoutMap(
    buildOverviewModel(
      overviewSnapshot({
        components: [
          { rootPath: "apps/web", role: "ui" },
          { rootPath: "srv/api", role: "api" },
          { rootPath: "pkg/a", role: "domain" },
          { rootPath: "pkg/b", role: "domain" },
          { rootPath: "pkg/db", role: "storage" },
        ],
        edges,
      }),
      1,
    ),
    { level: "card" },
  );
}

describe("mapDrawnEdges (one line per component pair; direction is not drawn)", () => {
  it("draws a two-way import once, with the summed import count and both keys", () => {
    const layout = layoutOf([
      { from: "apps/web", to: "srv/api", count: 3 },
      { from: "srv/api", to: "apps/web", count: 2 },
      { from: "srv/api", to: "pkg/db", count: 1 },
    ]);
    const drawn = mapDrawnEdges(layout.edges, new Set());
    expect(drawn).toHaveLength(2);
    const pair = drawn.find((edge) => edge.keys.includes(key("apps/web", "srv/api")));
    expect(pair?.keys).toHaveLength(2);
    expect(pair?.keys).toContain(key("srv/api", "apps/web"));
    expect(pair?.twoWay).toBe(true);
    expect(pair?.count).toBe(5);
    // 3 and 2 are each in the thinnest bucket; together they reach the middle one.
    expect(pair?.width).toBe(2);
    const single = drawn.find((edge) => edge.keys.includes(key("srv/api", "pkg/db")));
    expect(single?.twoWay).toBe(false);
    expect(single?.count).toBe(1);
  });

  it("keeps a pair at rest when either direction would be: band-to-band and not into a hub", () => {
    const layout = layoutOf([
      { from: "apps/web", to: "pkg/db", count: 2 },
      { from: "pkg/db", to: "apps/web", count: 2 },
      { from: "srv/api", to: "pkg/db", count: 4 },
      { from: "pkg/a", to: "pkg/b", count: 1 },
    ]);
    const hubs = new Set([id("pkg/db")]);
    const atRest = (from: string, to: string): boolean | undefined =>
      mapDrawnEdges(layout.edges, hubs).find((edge) => edge.keys.includes(key(from, to)))?.atRest;
    // db imports web back, so the pair shows at rest although web → db enters the hub.
    expect(atRest("apps/web", "pkg/db")).toBe(true);
    expect(atRest("srv/api", "pkg/db")).toBe(false);
    expect(atRest("pkg/a", "pkg/b")).toBe(false);
  });

  it("never draws two paths with the same route, at any scale", () => {
    const layout = layoutMap(buildOverviewModel(syntheticOverview({ components: 200, edges: 1_000, seed: 3 }), 1), { level: "card" });
    const drawn = mapDrawnEdges(layout.edges, mapHubIds(layout.edges, layout.cards.length));
    expect(new Set(drawn.map((edge) => edge.d)).size).toBe(drawn.length);
    // Every directed edge is drawn exactly once, inside one pair.
    const keys = drawn.flatMap((edge) => edge.keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(layout.edges.length);
    expect(drawn.some((edge) => edge.twoWay)).toBe(true);
  });
});
