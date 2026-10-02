import { describe, expect, it } from "vitest";

import { MAX_COMPONENT_EDGES, MAX_EXTERNALS, MAX_USED_BY, aggregateEdges, aggregateExternals } from "./edges.js";

const OWNER: Readonly<Record<string, string>> = {
  "a/x.ts": "cmp_a",
  "a/y.ts": "cmp_a",
  "b/z.ts": "cmp_b",
  "b/w.ts": "cmp_b",
  "c/v.ts": "cmp_c",
};
const ownerOf = (path: string): string | undefined => OWNER[path];

describe("aggregateEdges (spec §5.3)", () => {
  it("collapses file imports into component pairs counted by distinct file pairs", () => {
    const edges = aggregateEdges(
      [
        { from: "a/y.ts", to: "b/z.ts" },
        { from: "a/x.ts", to: "b/z.ts" },
        { from: "a/x.ts", to: "b/z.ts" },
        { from: "a/x.ts", to: "b/w.ts" },
        { from: "b/z.ts", to: "c/v.ts" },
      ],
      ownerOf,
    );
    expect(edges).toEqual([
      { from: "cmp_a", to: "cmp_b", count: 3, examples: ["a/x.ts → b/w.ts", "a/x.ts → b/z.ts", "a/y.ts → b/z.ts"] },
      { from: "cmp_b", to: "cmp_c", count: 1, examples: ["b/z.ts → c/v.ts"] },
    ]);
  });

  it("drops self-edges and files outside every component", () => {
    expect(
      aggregateEdges(
        [
          { from: "a/x.ts", to: "a/y.ts" },
          { from: "a/x.ts", to: "gone/q.ts" },
          { from: "gone/q.ts", to: "b/z.ts" },
        ],
        ownerOf,
      ),
    ).toEqual([]);
  });

  it("keeps at most three examples and clips each to 300 characters", () => {
    const long = `a/${"d/".repeat(200)}x.ts`;
    const edges = aggregateEdges(
      [long, "a/1.ts", "a/2.ts", "a/3.ts"].map((from) => ({ from, to: "b/z.ts" })),
      (path) => (path.startsWith("a/") ? "cmp_a" : "cmp_b"),
    );
    expect(edges[0]?.count).toBe(4);
    expect(edges[0]?.examples).toHaveLength(3);
    for (const example of edges[0]?.examples ?? []) expect(example.length).toBeLessThanOrEqual(300);
  });

  it("caps the list at 1,000 edges, heaviest first", () => {
    const imports = [];
    for (let i = 0; i < 1_100; i += 1) {
      for (let k = 0; k <= i % 3; k += 1) imports.push({ from: `m${i}/f${k}.ts`, to: `t${i}/g.ts` });
    }
    const edges = aggregateEdges(imports, (path) => `cmp_${path.split("/")[0] ?? ""}`);
    expect(edges).toHaveLength(MAX_COMPONENT_EDGES);
    expect(edges[0]?.count).toBe(3);
    expect(edges[edges.length - 1]?.count).toBe(1);
    for (let i = 1; i < edges.length; i += 1) {
      expect((edges[i - 1]?.count ?? 0) >= (edges[i]?.count ?? 0)).toBe(true);
    }
  });
});

describe("aggregateExternals (spec §5.3)", () => {
  it("counts importing files per component and package, heaviest first", () => {
    expect(
      aggregateExternals(
        [
          { from: "a/x.ts", packageName: "react" },
          { from: "a/x.ts", packageName: "react" },
          { from: "a/y.ts", packageName: "react" },
          { from: "b/z.ts", packageName: "react" },
          { from: "b/z.ts", packageName: "zod" },
          { from: "gone/q.ts", packageName: "zod" },
          { from: "a/x.ts", packageName: "" },
          { from: "a/x.ts", packageName: "x".repeat(215) },
        ],
        ownerOf,
      ),
    ).toEqual([
      { name: "react", usedBy: [{ componentId: "cmp_a", count: 2 }, { componentId: "cmp_b", count: 1 }] },
      { name: "zod", usedBy: [{ componentId: "cmp_b", count: 1 }] },
    ]);
  });

  it("caps users at 40 per package and packages at 120", () => {
    const imports = [];
    for (let p = 0; p < 130; p += 1) {
      for (let c = 0; c < 45; c += 1) imports.push({ from: `c${c}/f.ts`, packageName: `pkg-${String(p).padStart(3, "0")}` });
    }
    const externals = aggregateExternals(imports, (path) => `cmp_${path.split("/")[0] ?? ""}`);
    expect(externals).toHaveLength(MAX_EXTERNALS);
    expect(externals[0]?.name).toBe("pkg-000");
    for (const dep of externals) expect(dep.usedBy).toHaveLength(MAX_USED_BY);
  });
});
