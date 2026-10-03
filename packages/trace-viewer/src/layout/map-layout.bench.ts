import { bench, describe } from "vitest";

import { buildOverviewModel } from "../model/index.js";
import { syntheticOverview } from "../test-support/overview-builder.js";
import { layoutMap } from "./map-layout.js";

// Spec §11: layoutMap for 200 components and 1,000 edges, fresh ≤ 8 ms and sticky ≤ 2 ms (benchmark, not a CI gate).

const full = syntheticOverview({ components: 200, edges: 1_000, seed: 7 });
const lastId = full.components.at(-1)?.id;
const missingOne = {
  ...full,
  components: full.components.slice(0, -1),
  edges: full.edges.filter((edge) => edge.from !== lastId && edge.to !== lastId),
};
const overview = buildOverviewModel(full, 2);
const earlier = buildOverviewModel(missingOne, 1);
const settled = layoutMap(overview, { level: "card" });
const settledEarlier = layoutMap(earlier, { level: "card" });

describe("layoutMap, 200 components and 1,000 edges", () => {
  bench("fresh", () => {
    layoutMap(overview, { level: "card" });
  });

  bench("sticky, same components (a description pass)", () => {
    layoutMap(overview, { level: "card" }, settled.state);
  });

  bench("sticky, one new component", () => {
    layoutMap(overview, { level: "card" }, settledEarlier.state);
  });
});
