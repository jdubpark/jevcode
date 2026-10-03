import { describe, expect, it } from "vitest";

import { buildOverviewModel } from "../model/index.js";
import { componentId, overviewSnapshot, type OverviewSeed } from "../test-support/overview-builder.js";
import {
  MAP_BAND_LABEL_H,
  MAP_LEVEL_SPECS,
  MAP_MARGIN,
  componentForPath,
  createMapLayoutCache,
  layoutMap,
  mapEdgeWidth,
  mapHubIds,
  mapImporterCounts,
  mapLevelForZoom,
  type MapCard,
  type MapEdgePath,
  type MapLayout,
  type MapLayoutState,
} from "./map-layout.js";

// Spec E12 and §8.3 and the approved H2 Map mockup: role bands left to right, barycenter order within a band, sticky
// order, one geometry for every level, smooth edges through gutters and gap rows. The literal paths below are worked by
// hand from the geometry: top = 16 + 44 = 60, row pitch 92, column x = 16, 178, 340, 502, 664 (140 wide, 22 gutters).

const model = (seed: OverviewSeed) => buildOverviewModel(overviewSnapshot(seed), 1);

function card(layout: MapLayout, rootPath: string): MapCard {
  const found = layout.cards.find((item) => item.id === componentId(rootPath));
  if (found === undefined) throw new Error(`no card for ${rootPath}`);
  return found;
}

function edge(layout: MapLayout, from: string, to: string): MapEdgePath {
  const found = layout.edges.find((item) => item.from === componentId(from) && item.to === componentId(to));
  if (found === undefined) throw new Error(`no edge ${from} > ${to}`);
  return found;
}

const order = (layout: MapLayout, band: string): readonly string[] => layout.state.orderByBand.get(band) ?? [];

describe("mapLevelForZoom and mapEdgeWidth", () => {
  it("switches level at 0.7 and 1.4 (spec §8.3)", () => {
    expect([0.2, 0.69, 0.7, 1.39, 1.4, 2].map(mapLevelForZoom)).toEqual(["chip", "chip", "card", "card", "detail", "detail"]);
  });

  it("buckets import counts into 1 to 3 px (spec §3.4)", () => {
    expect([1, 3, 4, 15, 16, 400].map(mapEdgeWidth)).toEqual([1, 1, 2, 2, 3, 3]);
  });
});

describe("layoutMap bands and geometry", () => {
  const all = model({
    components: [
      { rootPath: "apps/web", role: "ui" },
      { rootPath: "srv/api", role: "api" },
      { rootPath: "pkg/agent", role: "agent" },
      { rootPath: "pkg/core", role: "domain" },
      { rootPath: "pkg/db", role: "storage" },
      { rootPath: "tests", role: "tests" },
      { rootPath: "scripts", role: "tooling" },
      { rootPath: ".", name: "config", role: "config" },
    ],
  });

  it("puts the role bands left to right and tests, tooling and config in the side band", () => {
    const layout = layoutMap(all, { level: "card" });
    expect(layout.bands.map((band) => band.band)).toEqual(["ui", "api", "agent", "domain", "storage", "side"]);
    expect(layout.bands.map((band) => band.count)).toEqual([1, 1, 1, 1, 1, 3]);
    const xs = layout.bands.map((band) => band.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    const spec = MAP_LEVEL_SPECS.card;
    const [storage, side] = layout.bands.slice(-2);
    // The side band follows the normal gutter and is narrower; its cards fill it.
    expect((side?.x ?? 0) - ((storage?.x ?? 0) + spec.w)).toBe(spec.gutter);
    expect(side?.w).toBe(spec.sideW);
    expect(card(layout, "tests")).toMatchObject({ band: "side", w: spec.sideW });
    expect(card(layout, "scripts").band).toBe("side");
  });

  it("skips empty bands", () => {
    const layout = layoutMap(model({ components: [{ rootPath: "apps/web", role: "ui" }, { rootPath: "pkg/db", role: "storage" }] }), { level: "card" });
    expect(layout.bands.map((band) => band.band)).toEqual(["ui", "storage"]);
    expect(card(layout, "pkg/db").x - (card(layout, "apps/web").x + MAP_LEVEL_SPECS.card.w)).toBe(MAP_LEVEL_SPECS.card.gutter);
  });

  it("uses one geometry for every level, so a zoom change never moves a card", () => {
    expect(MAP_LEVEL_SPECS.chip).toEqual({ w: 140, h: 76, sideW: 104, rowGap: 16, gutter: 22, chips: 0 });
    expect(MAP_LEVEL_SPECS.card).toEqual(MAP_LEVEL_SPECS.chip);
    expect(MAP_LEVEL_SPECS.detail).toEqual(MAP_LEVEL_SPECS.chip);
    const layouts = (["chip", "card", "detail"] as const).map((level) => layoutMap(all, { level }));
    for (const layout of layouts) {
      expect(layout.cards).toEqual(layouts[0]?.cards);
      expect(layout.bounds).toEqual(layouts[0]?.bounds);
    }
  });

  it("sizes and stacks cards with one row pitch for every band, and bounds that end at the last card", () => {
    for (const level of ["chip", "card", "detail"] as const) {
      const spec = MAP_LEVEL_SPECS[level];
      const layout = layoutMap(model({ components: [{ rootPath: "pkg/a", role: "domain" }, { rootPath: "pkg/b", role: "domain" }] }), { level });
      expect(layout.level).toBe(level);
      const [a, b] = layout.cards;
      expect(a).toMatchObject({ w: spec.w, h: spec.h, x: MAP_MARGIN, y: MAP_MARGIN + MAP_BAND_LABEL_H });
      expect((b?.y ?? 0) - (a?.y ?? 0)).toBe(spec.h + spec.rowGap);
      expect(layout.bounds).toEqual({
        w: MAP_MARGIN + spec.w + MAP_MARGIN,
        h: MAP_MARGIN + MAP_BAND_LABEL_H + 2 * (spec.h + spec.rowGap) - spec.rowGap + MAP_MARGIN,
      });
    }
  });

  it("lays out an empty snapshot as an empty map", () => {
    const layout = layoutMap(model({ components: [] }), { level: "card" });
    expect(layout.cards).toEqual([]);
    expect(layout.bands).toEqual([]);
    expect(layout.bounds).toEqual({ w: 2 * MAP_MARGIN, h: MAP_MARGIN + MAP_BAND_LABEL_H + MAP_MARGIN });
  });
});

describe("layoutMap order within a band", () => {
  it("breaks ties by name, then id", () => {
    const layout = layoutMap(
      model({ components: [{ rootPath: "pkg/c", role: "domain" }, { rootPath: "pkg/a", role: "domain" }, { rootPath: "pkg/b", role: "domain" }] }),
      { level: "card" },
    );
    expect(order(layout, "domain")).toEqual(["pkg/a", "pkg/b", "pkg/c"].map(componentId));
  });

  it("orders by barycenter so crossing edges uncross and run flat", () => {
    // By name: ui [a, b], domain [x, y]; edges a→y and b→x cross. The sweeps give ui [b, a] and domain [x, y].
    const layout = layoutMap(
      model({
        components: [{ rootPath: "apps/a", role: "ui" }, { rootPath: "apps/b", role: "ui" }, { rootPath: "pkg/x", role: "domain" }, { rootPath: "pkg/y", role: "domain" }],
        edges: [{ from: "apps/a", to: "pkg/y", count: 5 }, { from: "apps/b", to: "pkg/x", count: 5 }],
      }),
      { level: "card" },
    );
    expect(order(layout, "ui")).toEqual(["apps/b", "apps/a"].map(componentId));
    expect(order(layout, "domain")).toEqual(["pkg/x", "pkg/y"].map(componentId));
    expect(card(layout, "apps/a").y).toBe(card(layout, "pkg/y").y);
    // Equal port heights give a flat S-curve: M x y C mx y mx y x2 y.
    const flat = /^M[\d.]+ ([\d.]+)C[\d.]+ \1 [\d.]+ \1 [\d.]+ \1$/;
    expect(edge(layout, "apps/a", "pkg/y").d).toMatch(flat);
    expect(edge(layout, "apps/b", "pkg/x").d).toMatch(flat);
  });
});

describe("layoutMap edge routes", () => {
  const spec = MAP_LEVEL_SPECS.card;
  const FIVE = [
    { rootPath: "apps/web", role: "ui" },
    { rootPath: "srv/api", role: "api" },
    { rootPath: "pkg/agent", role: "agent" },
    { rootPath: "pkg/core", role: "domain" },
    { rootPath: "pkg/db", role: "storage" },
  ] as const;

  it("routes an adjacent-band edge as one smooth S-curve in the gutter", () => {
    const layout = layoutMap(
      model({
        components: [{ rootPath: "apps/web", role: "ui" }, { rootPath: "srv/a", role: "api" }, { rootPath: "srv/b", role: "api" }],
        edges: [{ from: "apps/web", to: "srv/b", count: 2 }],
      }),
      { level: "card" },
    );
    const route = edge(layout, "apps/web", "srv/b");
    // web: x 16..156, y 60..136 (port y 98); srv/b: x 178, row 1, y 152..228 (port y 190); mx = (156 + 178) / 2.
    expect(route.d).toBe("M156 98C167 98 167 190 178 190");
    expect(route.kind).toBe("adjacent");
    expect(route.width).toBe(1);
  });

  it("routes an edge between bands two or more apart through the gap row below its source", () => {
    const layout = layoutMap(model({ components: [...FIVE], edges: [{ from: "apps/web", to: "pkg/db", count: 20 }] }), { level: "card" });
    const web = card(layout, "apps/web");
    const route = edge(layout, "apps/web", "pkg/db");
    expect(route.kind).toBe("long");
    expect(route.width).toBe(3);
    // The gap row below row 0 is y 136..152; its center 144 = 60 + 92 − 16 / 2. gx1 = 156 + 22, gx2 = 664 − 22.
    expect(route.d).toBe("M156 98C167 98 167 144 178 144H642C653 144 653 98 664 98");
    expect(144).toBeGreaterThan(web.y + web.h);
    expect(144).toBeLessThan(web.y + web.h + spec.rowGap);
  });

  it("uses the gap row above the source when the target is higher", () => {
    const layout = layoutMap(
      model({
        components: [
          { rootPath: "apps/u1", role: "ui" },
          { rootPath: "apps/u2", role: "ui" },
          { rootPath: "srv/x", role: "api" },
          { rootPath: "pkg/s", role: "storage" },
          { rootPath: "pkg/t", role: "storage" },
        ],
        edges: [{ from: "apps/u2", to: "pkg/s", count: 5 }, { from: "apps/u2", to: "pkg/t", count: 5 }],
      }),
      { level: "card" },
    );
    // u2 is row 1 (port y 190). Toward s (row 0, port y 98) the channel is the gap above row 1: 60 + 92 − 8 = 144.
    // Toward t (row 1, port y 190) it is the gap below row 1: 60 + 2 × 92 − 8 = 236.
    expect(edge(layout, "apps/u2", "pkg/s").d).toBe("M156 190C167 190 167 144 178 144H318C329 144 329 98 340 98");
    expect(edge(layout, "apps/u2", "pkg/t").d).toBe("M156 190C167 190 167 236 178 236H318C329 236 329 190 340 190");
  });

  it("bundles the edges that leave one card toward the same side onto one channel", () => {
    const layout = layoutMap(
      model({
        components: [{ rootPath: "apps/u", role: "ui" }, { rootPath: "srv/x", role: "api" }, { rootPath: "pkg/s", role: "storage" }, { rootPath: "pkg/t", role: "storage" }],
        edges: [{ from: "apps/u", to: "pkg/s", count: 1 }, { from: "apps/u", to: "pkg/t", count: 1 }],
      }),
      { level: "card" },
    );
    // Both targets are at or below u's port, so both use the gap below row 0 (y 144) and overlap from gx1 to gx2.
    expect(edge(layout, "apps/u", "pkg/s").d).toBe("M156 98C167 98 167 144 178 144H318C329 144 329 98 340 98");
    expect(edge(layout, "apps/u", "pkg/t").d).toBe("M156 98C167 98 167 144 178 144H318C329 144 329 190 340 190");
  });

  it("routes a same-band edge as a shallow bulge on the less loaded side", () => {
    const layout = layoutMap(
      model({ components: [{ rootPath: "pkg/a", role: "domain" }, { rootPath: "pkg/b", role: "domain" }], edges: [{ from: "pkg/a", to: "pkg/b", count: 1 }] }),
      { level: "card" },
    );
    // No cross-band edges: the loads tie and the right side wins. bulge = min(11 − 2, 4 + 3 × 1) = 7.
    expect(edge(layout, "pkg/a", "pkg/b")).toMatchObject({ kind: "same", d: "M156 98C163 98 163 190 156 190" });
    const loaded = layoutMap(
      model({
        components: [{ rootPath: "pkg/a", role: "domain" }, { rootPath: "pkg/b", role: "domain" }, { rootPath: "pkg/db", role: "storage" }],
        edges: [{ from: "pkg/a", to: "pkg/b", count: 1 }, { from: "pkg/a", to: "pkg/db", count: 1 }],
      }),
      { level: "card" },
    );
    // The edge to storage already leaves a's right side, so the same-band edge takes the left (the margin).
    expect(edge(loaded, "pkg/a", "pkg/b").d).toBe("M16 98C9 98 9 190 16 190");
  });

  it("draws the same path whichever way the import points", () => {
    const forward = layoutMap(model({ components: [...FIVE], edges: [{ from: "apps/web", to: "pkg/db", count: 2 }] }), { level: "card" });
    const backward = layoutMap(model({ components: [...FIVE], edges: [{ from: "pkg/db", to: "apps/web", count: 2 }] }), { level: "card" });
    expect(edge(forward, "apps/web", "pkg/db").d).toBe(edge(backward, "pkg/db", "apps/web").d);
  });

  it("drops self edges, edges to unknown components and duplicate pairs", () => {
    const snapshot = overviewSnapshot({
      components: [{ rootPath: "apps/web", role: "ui" }, { rootPath: "pkg/db", role: "storage" }],
      edges: [{ from: "apps/web", to: "pkg/db", count: 4 }],
    });
    const noisy = {
      ...snapshot,
      edges: [
        ...snapshot.edges,
        { from: componentId("apps/web"), to: componentId("apps/web"), count: 9, examples: [] },
        { from: componentId("apps/web"), to: "cmp_000000000000", count: 9, examples: [] },
        { from: componentId("apps/web"), to: componentId("pkg/db"), count: 2, examples: [] },
      ],
    };
    const layout = layoutMap(buildOverviewModel(noisy, 1), { level: "card" });
    expect(layout.edges.map((item) => [item.from, item.to, item.count])).toEqual([[componentId("apps/web"), componentId("pkg/db"), 4]]);
  });
});

describe("mapHubIds (a hub is imported by at least max(6, ceil(n / 4)) components)", () => {
  const importers = (to: string, count: number): MapEdgePath[] =>
    Array.from({ length: count }, (_, i) => ({ from: `cmp_${String(i).padStart(12, "0")}`, to, count: 1, width: 1 as const, d: "", kind: "adjacent" as const }));

  it("uses the floor of 6 for a small map", () => {
    expect([...mapHubIds([...importers("hub", 6), ...importers("near", 5)], 21)]).toEqual(["hub"]);
  });

  it("grows with the component count", () => {
    // n = 40 needs 10 importers; n = 200 needs 50.
    expect(mapHubIds(importers("hub", 9), 40).size).toBe(0);
    expect(mapHubIds(importers("hub", 10), 40).size).toBe(1);
    expect(mapHubIds(importers("hub", 49), 200).size).toBe(0);
    expect(mapHubIds(importers("hub", 50), 200).size).toBe(1);
  });

  it("counts distinct importers, not edges", () => {
    expect(mapHubIds([...importers("hub", 5), ...importers("hub", 5)], 21).size).toBe(0);
    expect(mapImporterCounts([...importers("hub", 5), ...importers("hub", 5), ...importers("other", 2)])).toEqual(new Map([["hub", 5], ["other", 2]]));
  });
});

describe("layoutMap externals", () => {
  it("places no chips at any level; packages show inside detail cards and in the Inspector", () => {
    const seed: OverviewSeed = {
      components: [{ rootPath: "apps/web", role: "ui" }, { rootPath: "pkg/db", role: "storage" }],
      externals: [{ name: "react", usedBy: [{ rootPath: "apps/web", count: 12 }] }],
    };
    for (const level of ["chip", "card", "detail"] as const) expect(layoutMap(model(seed), { level }).externals).toEqual([]);
  });
});

describe("layoutMap stickiness (spec §8.3)", () => {
  const domain = (names: string[]) => names.map((name) => ({ rootPath: `pkg/${name}`, role: "domain" as const }));
  const prevOf = (repoRoot: string, bands: Record<string, string[]>): MapLayoutState => ({
    repoRoot,
    orderByBand: new Map(Object.entries(bands).map(([band, roots]) => [band, roots.map(componentId)])),
  });

  it("keeps the previous order and appends a new component with no placed neighbor", () => {
    const prev = prevOf("/repo", { domain: ["pkg/d3", "pkg/d1", "pkg/d2"] });
    const layout = layoutMap(model({ components: domain(["d0", "d1", "d2", "d3"]) }), { level: "card" }, prev);
    expect(order(layout, "domain")).toEqual(["pkg/d3", "pkg/d1", "pkg/d2", "pkg/d0"].map(componentId));
  });

  it("inserts a new component at its barycenter over placed neighbors", () => {
    const prev = prevOf("/repo", { ui: ["apps/u"], domain: ["pkg/d3", "pkg/d1", "pkg/d2"] });
    const layout = layoutMap(
      model({ components: [{ rootPath: "apps/u", role: "ui" }, ...domain(["d1", "d2", "d3", "d4"])], edges: [{ from: "apps/u", to: "pkg/d4", count: 2 }] }),
      { level: "card" },
      prev,
    );
    expect(order(layout, "domain")).toEqual(["pkg/d4", "pkg/d3", "pkg/d1", "pkg/d2"].map(componentId));
  });

  it("moves a re-roled component to its new band and keeps the others' order", () => {
    const prev = prevOf("/repo", { domain: ["pkg/d3", "pkg/d1", "pkg/d2"] });
    const layout = layoutMap(
      model({ components: [{ rootPath: "pkg/d1", role: "domain" }, { rootPath: "pkg/d2", role: "storage" }, { rootPath: "pkg/d3", role: "domain" }] }),
      { level: "card" },
      prev,
    );
    expect(order(layout, "domain")).toEqual(["pkg/d3", "pkg/d1"].map(componentId));
    expect(order(layout, "storage")).toEqual([componentId("pkg/d2")]);
  });

  it("lays out fresh for another repo", () => {
    const prev = prevOf("/other", { domain: ["pkg/d3", "pkg/d1", "pkg/d2"] });
    const layout = layoutMap(model({ components: domain(["d1", "d2", "d3"]) }), { level: "card" }, prev);
    expect(order(layout, "domain")).toEqual(["pkg/d1", "pkg/d2", "pkg/d3"].map(componentId));
    expect(layout.state.repoRoot).toBe("/repo");
  });

  // Two crossing links. The fresh order uncrosses them by moving a2 above a1 (ui [a2, a1], domain [x, y]); inserting the
  // cards one by one in name order into an empty order places a1 and a2 first and uncrosses them the other way.
  const crossing: OverviewSeed = {
    components: [{ rootPath: "apps/a1", role: "ui" }, { rootPath: "apps/a2", role: "ui" }, ...domain(["x", "y"])],
    edges: [{ from: "apps/a1", to: "pkg/y", count: 2 }, { from: "apps/a2", to: "pkg/x", count: 2 }],
  };
  const progress: OverviewSeed = { components: [], status: { scan: { state: "running", scanned: 10, total: 900 }, narrator: "pending" } };

  it("treats a previous layout with no cards as none: an empty progress row, then the real snapshot, lays out as the real one alone (lane 06 fix I-2)", () => {
    const real = model(crossing);
    const fresh = layoutMap(real, { level: "card" });
    // A previous layout whose cards are all gone inserts every card, which here differs from the fresh order.
    const inserted = layoutMap(real, { level: "card" }, prevOf("/repo", { domain: ["pkg/gone"] }));
    expect(inserted.state.orderByBand).not.toEqual(fresh.state.orderByBand);
    const afterProgress = layoutMap(real, { level: "card" }, layoutMap(model(progress), { level: "card" }).state);
    expect(afterProgress).toEqual(fresh);
  });

  describe("createMapLayoutCache (lane 06 fix I-2: one sticky layout per viewer)", () => {
    it("makes one layout per overview object and chains a repo's layouts", () => {
      const cache = createMapLayoutCache();
      const first = model(crossing);
      const firstLayout = cache.layoutFor(first);
      expect(firstLayout).toEqual(layoutMap(first, { level: "card" }));
      expect(cache.layoutFor(first)).toBe(firstLayout);
      const grown = model({ ...crossing, components: [...crossing.components, ...domain(["a"])] });
      const grownLayout = cache.layoutFor(grown);
      expect(grownLayout).toEqual(layoutMap(grown, { level: "card" }, firstLayout.state));
      // The fresh order of the grown snapshot differs, so the chain is what keeps the arrangement.
      expect(grownLayout.state.orderByBand).not.toEqual(layoutMap(grown, { level: "card" }).state.orderByBand);
      // Another repo starts fresh, and the first repo's chain is untouched by it.
      const other = buildOverviewModel(overviewSnapshot({ ...crossing, repoRoot: "/other" }), 1);
      expect(cache.layoutFor(other)).toEqual(layoutMap(other, { level: "card" }));
      const again = model({ ...crossing, components: [...crossing.components, ...domain(["a"])] });
      expect(cache.layoutFor(again).state.orderByBand).toEqual(grownLayout.state.orderByBand);
    });

    it("an empty progress overview, then the real snapshot, lays out as the real snapshot alone", () => {
      const cache = createMapLayoutCache();
      cache.layoutFor(model(progress));
      const real = model(crossing);
      expect(cache.layoutFor(real)).toEqual(layoutMap(real, { level: "card" }));
    });
  });
});

describe("componentForPath", () => {
  const overview = model({
    repoRoot: "/work/repo",
    components: [{ rootPath: "packages/viewer" }, { rootPath: "packages/viewer/src/ui" }, { rootPath: "." , name: "config" }],
  });

  it("picks the longest root, strips the repo root and './', and falls back to '.' for a root-level path", () => {
    expect(componentForPath(overview, "packages/viewer/src/ui/Map.tsx")).toBe(componentId("packages/viewer/src/ui"));
    expect(componentForPath(overview, "/work/repo/packages/viewer/src/model/fold.ts")).toBe(componentId("packages/viewer"));
    expect(componentForPath(overview, "./packages/viewer/package.json")).toBe(componentId("packages/viewer"));
    expect(componentForPath(overview, "tsconfig.json")).toBe(componentId("."));
    expect(componentForPath(overview, "/work/repo/tsconfig.json")).toBe(componentId("."));
    // "." holds root-level files only (lane 06 fix I-3): an unclaimed nested path is not its.
    expect(componentForPath(overview, "docs/a.md")).toBeUndefined();
    expect(componentForPath(model({ components: [{ rootPath: "packages/viewer" }] }), "docs/a.md")).toBeUndefined();
  });
});
