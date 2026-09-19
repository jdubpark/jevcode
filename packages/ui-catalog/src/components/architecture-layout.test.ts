import { describe, expect, it } from "vitest";

import type { ArchitectureEdge, ArchitectureNode } from "@jevcode/contracts";

import { layoutArchitectureNodes, nodeKindClass } from "./architecture-layout.js";

function node(id: string, label: string, kind: ArchitectureNode["kind"]): ArchitectureNode {
  return { id, label, kind };
}

describe("layoutArchitectureNodes", () => {
  it("places isolated nodes in a single column ordered by input", () => {
    const positioned = layoutArchitectureNodes(
      [node("a", "A", "module"), node("b", "B", "module")],
      [],
    );
    expect(positioned.map((n) => n.id)).toEqual(["a", "b"]);
    expect(positioned.map((n) => n.x)).toEqual([0, 0]);
    expect(positioned[1]!.y).toBeGreaterThan(positioned[0]!.y);
  });

  it("layers a chain left to right", () => {
    const positioned = layoutArchitectureNodes(
      [
        node("a", "A", "external"),
        node("b", "B", "middleware"),
        node("c", "C", "module"),
      ],
      [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    );
    const byId = new Map(positioned.map((n) => [n.id, n]));
    expect(byId.get("b")!.x).toBeGreaterThan(byId.get("a")!.x);
    expect(byId.get("c")!.x).toBeGreaterThan(byId.get("b")!.x);
    expect(byId.get("a")!.x).toBe(0);
  });

  it("never places a node left of any of its predecessors", () => {
    const nodes: ArchitectureNode[] = [
      node("n-client", "Client", "external"),
      node("n-app", "API", "module"),
      node("n-limiter", "RateLimiter", "middleware"),
      node("n-redis", "Redis", "service"),
      node("n-config", "Options", "config"),
      node("n-users", "users", "table"),
    ];
    const edges: ArchitectureEdge[] = [
      { from: "n-client", to: "n-limiter" },
      { from: "n-limiter", to: "n-app" },
      { from: "n-limiter", to: "n-redis" },
      { from: "n-config", to: "n-limiter" },
      { from: "n-limiter", to: "n-users" },
    ];
    const positioned = layoutArchitectureNodes(nodes, edges);
    const byId = new Map(positioned.map((n) => [n.id, n]));
    for (const edge of edges) {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      expect(from).toBeDefined();
      expect(to).toBeDefined();
      expect(to!.x).toBeGreaterThan(from!.x);
    }
    const ids = positioned.map((n) => n.id);
    expect(ids).toHaveLength(6);
  });

  it("is deterministic across repeated calls", () => {
    const nodes: ArchitectureNode[] = [
      node("a", "A", "module"),
      node("b", "B", "service"),
      node("c", "C", "route"),
    ];
    const edges: ArchitectureEdge[] = [
      { from: "a", to: "b" },
      { from: "a", to: "c" },
    ];
    const first = layoutArchitectureNodes(nodes, edges);
    const second = layoutArchitectureNodes(nodes, edges);
    expect(second).toEqual(first);
  });

  it("terminates and keeps deterministic positions on cycles", () => {
    const nodes: ArchitectureNode[] = [
      node("a", "A", "module"),
      node("b", "B", "module"),
    ];
    const edges: ArchitectureEdge[] = [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
    ];
    const positioned = layoutArchitectureNodes(nodes, edges);
    expect(positioned).toHaveLength(2);
    expect(layoutArchitectureNodes(nodes, edges)).toEqual(positioned);
  });

  it("ignores edges referencing unknown nodes and self loops", () => {
    const positioned = layoutArchitectureNodes(
      [node("a", "A", "module"), node("b", "B", "module")],
      [
        { from: "a", to: "missing" },
        { from: "a", to: "a" },
        { from: "a", to: "b" },
      ],
    );
    expect(positioned).toHaveLength(2);
    expect(positioned[0]!.x).toBe(0);
    expect(positioned[1]!.x).toBeGreaterThan(0);
  });

  it("assigns positions that do not collide", () => {
    const positioned = layoutArchitectureNodes(
      [
        node("a", "A", "module"),
        node("b", "B", "service"),
        node("c", "C", "route"),
        node("d", "D", "table"),
      ],
      [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
        { from: "b", to: "d" },
        { from: "c", to: "d" },
      ],
    );
    const keys = new Set(positioned.map((n) => `${n.x}:${n.y}`));
    expect(keys.size).toBe(positioned.length);
  });
});

describe("nodeKindClass", () => {
  it("assigns a distinct class per style group", () => {
    const classes = new Set(
      (
        [
          "module",
          "service",
          "route",
          "middleware",
          "config",
          "table",
          "type",
          "class",
          "function",
          "external",
        ] as const
      ).map((kind) => nodeKindClass(kind)),
    );
    expect(classes).toEqual(
      new Set([
        "jevcode-arch-module",
        "jevcode-arch-service",
        "jevcode-arch-route",
        "jevcode-arch-middleware",
        "jevcode-arch-config",
        "jevcode-arch-schema-entity",
        "jevcode-arch-dependency",
      ]),
    );
  });
});
