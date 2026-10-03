import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ROLES, type OverviewSnapshot } from "@jevcode/contracts";

import { buildOverviewModel } from "../model/index.js";
import { expectEdgesOnPorts, expectNoCardCrossings, expectNoOverlaps, pathPoints as pathPointsOf } from "../test-support/map-checks.js";
import { arbOverviewSeed, arbOverviewSuccessor } from "../test-support/overview-arbitraries.js";
import { componentId, overviewSnapshot } from "../test-support/overview-builder.js";
import { MAP_BAND_ORDER, layoutMap, mapEdgeWidth, mapHubIds, mapLevelForZoom, type MapLevel } from "./map-layout.js";

// Spec §8.3 properties: no card overlap, edges never pass under a card other than their endpoints (curves included),
// sticky under append, deterministic for equal input (cards, paths and kinds), the zoom bands and the hub rule.

const LEVELS = fc.constantFrom<MapLevel>("chip", "card", "detail");
const LEVEL_RANK: Readonly<Record<MapLevel, number>> = { chip: 0, card: 1, detail: 2 };
const RUNS = { numRuns: 150 };

function shuffled<T>(items: readonly T[], salt: number): T[] {
  const out = [...items];
  let state = (salt >>> 0) || 1;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

const model = (snapshot: OverviewSnapshot) => buildOverviewModel(snapshot, 1);

describe("layoutMap properties", () => {
  it("is deterministic under shuffled components, edges and externals", () => {
    fc.assert(
      fc.property(arbOverviewSeed(), LEVELS, fc.nat(), (seed, level, salt) => {
        const snapshot = overviewSnapshot(seed);
        const reordered: OverviewSnapshot = {
          ...snapshot,
          components: shuffled(snapshot.components, salt),
          edges: shuffled(snapshot.edges, salt + 1),
          externals: shuffled(snapshot.externals, salt + 2),
        };
        expect(layoutMap(model(reordered), { level })).toEqual(layoutMap(model(snapshot), { level }));
      }),
      RUNS,
    );
  });

  it("places every component exactly once, with no card overlap, every edge on its ports and no edge under a card", () => {
    fc.assert(
      fc.property(arbOverviewSeed(), LEVELS, (seed, level) => {
        const snapshot = overviewSnapshot(seed);
        const layout = layoutMap(model(snapshot), { level });
        expect(layout.cards.map((card) => card.id).sort()).toEqual([...new Set(snapshot.components.map((component) => component.id))].sort());
        expect(layout.externals).toEqual([]);
        expectNoOverlaps(layout);
        expectEdgesOnPorts(layout);
        expectNoCardCrossings(layout);
        for (const edge of layout.edges) expect(edge.width).toBe(mapEdgeWidth(edge.count));
      }),
      RUNS,
    );
  });

  it("uses one geometry at every level: cards and bounds do not depend on the level", () => {
    fc.assert(
      fc.property(arbOverviewSeed(), (seed) => {
        const overview = model(overviewSnapshot(seed));
        const [chip, card, detail] = (["chip", "card", "detail"] as const).map((level) => layoutMap(overview, { level }));
        expect(card?.cards).toEqual(chip?.cards);
        expect(detail?.cards).toEqual(chip?.cards);
        expect(detail?.edges.map((edge) => edge.d)).toEqual(chip?.edges.map((edge) => edge.d));
        expect(detail?.bounds).toEqual(chip?.bounds);
      }),
      RUNS,
    );
  });

  it("classifies edges by band distance and keeps every curve inside the bounds", () => {
    fc.assert(
      fc.property(arbOverviewSeed(), LEVELS, (seed, level) => {
        const layout = layoutMap(model(overviewSnapshot(seed)), { level });
        const column = new Map(layout.cards.map((card) => [card.id, layout.bands.findIndex((band) => band.band === card.band)] as const));
        for (const edge of layout.edges) {
          const gap = Math.abs((column.get(edge.to) ?? 0) - (column.get(edge.from) ?? 0));
          expect(edge.kind).toBe(gap === 0 ? "same" : gap === 1 ? "adjacent" : "long");
          // One assertion per edge: a per-point expect dominates the run time on larger maps.
          const outside = pathPointsOf(edge.d).filter(
            (point) => point.x < 0 || point.x > layout.bounds.w || point.y < 0 || point.y > layout.bounds.h,
          );
          expect(outside, `${edge.from}>${edge.to} leaves the bounds: ${edge.d}`).toEqual([]);
        }
      }),
      RUNS,
    );
  });

  it("the zoom bands are monotone: a higher zoom never picks a less detailed level", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.05, max: 3, noNaN: true }), fc.double({ min: 0.05, max: 3, noNaN: true }), (a, b) => {
        const [low, high] = a <= b ? [a, b] : [b, a];
        expect(LEVEL_RANK[mapLevelForZoom(low)]).toBeLessThanOrEqual(LEVEL_RANK[mapLevelForZoom(high)]);
      }),
      RUNS,
    );
  });

  it("a hub is a component with at least max(6, ceil(n / 4)) distinct importers, whatever the edge order", () => {
    fc.assert(
      fc.property(arbOverviewSeed({ maxComponents: 30 }), fc.nat(), (seed, salt) => {
        const snapshot = overviewSnapshot(seed);
        const layout = layoutMap(model(snapshot), { level: "card" });
        const n = layout.cards.length;
        const importers = new Map<string, Set<string>>();
        for (const edge of layout.edges) importers.set(edge.to, (importers.get(edge.to) ?? new Set<string>()).add(edge.from));
        const expected = [...importers].filter(([, from]) => from.size >= Math.max(6, Math.ceil(n / 4))).map(([id]) => id).sort();
        expect([...mapHubIds(layout.edges, n)].sort()).toEqual(expected);
        expect([...mapHubIds(shuffled(layout.edges, salt), n)].sort()).toEqual(expected);
      }),
      RUNS,
    );
  });

  // Few random seeds above reach 6 importers, and fewer land exactly on the threshold, so this property plants a fan-in
  // one below, at or one above the threshold to exercise the rule's boundary.
  it("a planted fan-in is a hub exactly when its importers reach max(6, ceil(n / 4)), whatever the edge order", () => {
    const arbFanIn = fc.record({
      n: fc.integer({ min: 7, max: 40 }),
      delta: fc.integer({ min: -1, max: 1 }),
      roles: fc.array(fc.constantFrom(...ROLES), { minLength: 40, maxLength: 40 }),
      salt: fc.nat(),
    });
    fc.assert(
      fc.property(arbFanIn, ({ n, delta, roles, salt }) => {
        const threshold = Math.max(6, Math.ceil(n / 4));
        const roots = Array.from({ length: n }, (_, index) => `pkg/f${String(index).padStart(2, "0")}`);
        const [target = "", ...others] = roots;
        const k = Math.min(others.length, threshold + delta);
        const importers = shuffled(others, salt).slice(0, k);
        const layout = layoutMap(
          model(
            overviewSnapshot({
              components: roots.map((rootPath, index) => ({ rootPath, role: roles[index] ?? "domain" })),
              edges: importers.map((from) => ({ from, to: target, count: 1 })),
            }),
          ),
          { level: "card" },
        );
        const expected = k >= threshold ? [componentId(target)] : [];
        expect([...mapHubIds(layout.edges, n)]).toEqual(expected);
        expect([...mapHubIds(shuffled(layout.edges, salt + 1), n)]).toEqual(expected);
      }),
      RUNS,
    );
  });

  it("is sticky: placed components keep their relative order within a band", () => {
    fc.assert(
      fc.property(
        arbOverviewSeed().chain((seed) => fc.tuple(fc.constant(seed), arbOverviewSuccessor(seed))),
        LEVELS,
        ([before, after], level) => {
          const first = layoutMap(model(overviewSnapshot(before)), { level });
          const second = layoutMap(model(overviewSnapshot(after)), { level }, first.state);
          for (const band of MAP_BAND_ORDER) {
            const old = first.state.orderByBand.get(band) ?? [];
            const now = second.state.orderByBand.get(band) ?? [];
            const kept = now.filter((id) => old.includes(id));
            expect(kept).toEqual(old.filter((id) => kept.includes(id)));
          }
          expectNoOverlaps(second);
          expectNoCardCrossings(second);
          // Routing is a function of card positions, so an adjacent or long edge between two cards that kept their
          // positions keeps its path (same-band bulges depend on the loads and may switch sides).
          const at = (layout: typeof first, id: string) => layout.cards.find((card) => card.id === id);
          for (const edge of second.edges) {
            if (edge.kind === "same") continue;
            const old = first.edges.find((item) => item.from === edge.from && item.to === edge.to);
            if (old === undefined || old.kind === "same") continue;
            const keeps = [edge.from, edge.to].every((id) => {
              const a = at(first, id);
              const b = at(second, id);
              return a !== undefined && b !== undefined && a.x === b.x && a.y === b.y;
            });
            if (keeps) expect(edge.d).toBe(old.d);
          }
        },
      ),
      RUNS,
    );
  });

  it("an unchanged snapshot laid out with its own state reproduces its cards and edges", () => {
    fc.assert(
      fc.property(arbOverviewSeed(), LEVELS, (seed, level) => {
        const overview = model(overviewSnapshot(seed));
        const first = layoutMap(overview, { level });
        const again = layoutMap(overview, { level }, first.state);
        expect(again.cards).toEqual(first.cards);
        expect(again.edges).toEqual(first.edges);
      }),
      RUNS,
    );
  });
});
