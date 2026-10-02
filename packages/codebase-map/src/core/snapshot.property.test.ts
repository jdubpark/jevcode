import { OVERVIEW_SNAPSHOT_MAX_BYTES, OverviewSnapshotSchema } from "@jevcode/contracts";
import type { ComponentEdge, ExternalDep } from "@jevcode/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { componentIdFor, type ComponentDraft } from "./componentize.js";
import { sha1Hex, utf8ByteLength } from "./sha1.js";
import { assembleSnapshot, type AssembleSnapshotInput } from "./snapshot.js";

interface Shape {
  components: number;
  files: number;
  pad: number;
  edges: number;
  externals: number;
}

function synthetic(shape: Shape): AssembleSnapshotInput {
  const drafts: ComponentDraft[] = [];
  for (let i = 0; i < shape.components; i += 1) {
    const rootPath = `pkg-${i}/${"d".repeat(shape.pad)}`;
    const files = Array.from({ length: 1 + ((i * 7) % shape.files) }, (_, k) => `${rootPath}/f${k}.ts`);
    drafts.push({
      id: componentIdFor(rootPath),
      rootPath,
      name: `pkg-${i}`,
      files,
      language: "TypeScript",
      contentHash: sha1Hex(rootPath),
      entryPoints: [],
      importsAnalyzed: true,
    });
  }
  const at = (index: number): ComponentDraft => drafts[index % drafts.length] as ComponentDraft;
  const edges: ComponentEdge[] = Array.from({ length: shape.edges }, (_, k) => ({
    from: at(k).id,
    to: at(k * 13 + 1).id,
    count: 1 + (k % 5),
    examples: [`${at(k).files[0] ?? ""} → ${at(k * 13 + 1).files[0] ?? ""}`],
  }));
  const externals: ExternalDep[] = Array.from({ length: shape.externals }, (_, k) => ({
    name: `ext-${k}`,
    usedBy: [{ componentId: at(k).id, count: 1 + (k % 3) }],
  }));
  return {
    sessionId: "sess_p",
    repoRoot: "/repo",
    scanId: "scan_p",
    partial: false,
    drafts,
    edges,
    externals,
    text: new Map(),
    narrative: null,
    generatedAt: "2026-10-02T00:00:00.000Z",
  };
}

const shapeArb = fc.record({
  components: fc.integer({ min: 1, max: 450 }),
  files: fc.integer({ min: 1, max: 40 }),
  pad: fc.integer({ min: 0, max: 160 }),
  edges: fc.integer({ min: 0, max: 2_500 }),
  externals: fc.integer({ min: 0, max: 200 }),
});

describe("assembleSnapshot caps (spec §5.5, §12)", () => {
  it("always holds the component, edge, external and byte caps, and only references kept components", () => {
    fc.assert(
      fc.property(shapeArb, (shape) => {
        const snapshot = assembleSnapshot(synthetic(shape));
        expect(OverviewSnapshotSchema.safeParse(snapshot).success).toBe(true);
        expect(snapshot.components).toHaveLength(Math.min(shape.components, 200));
        expect(snapshot.edges.length).toBeLessThanOrEqual(1_000);
        expect(snapshot.externals.length).toBeLessThanOrEqual(120);
        expect(utf8ByteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(OVERVIEW_SNAPSHOT_MAX_BYTES);
        expect(snapshot.counts.components).toBe(shape.components);
        const ids = new Set(snapshot.components.map((c) => c.id));
        for (const edge of snapshot.edges) {
          expect(ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to).toBe(true);
        }
        for (const dep of snapshot.externals) {
          for (const use of dep.usedBy) expect(ids.has(use.componentId)).toBe(true);
        }
      }),
      { numRuns: 40 },
    );
  });

  it("is deterministic for equal input", () => {
    fc.assert(
      fc.property(shapeArb, (shape) => {
        expect(assembleSnapshot(synthetic(shape))).toEqual(assembleSnapshot(synthetic(shape)));
      }),
      { numRuns: 15 },
    );
  });

  it("leaves room for the status and the real sessionId the stage stamps after assembly", () => {
    const stamp = (snapshot: ReturnType<typeof assembleSnapshot>) => ({
      ...snapshot,
      sessionId: "s".repeat(256),
      status: {
        scan: { state: "failed" as const, scanned: 20_000, total: 20_000, error: "e".repeat(200) },
        narrator: "unavailable" as const,
      },
    });
    const heaviest = { components: 450, files: 40, pad: 160, edges: 2_500, externals: 200 };
    const check = (shape: typeof heaviest): void => {
      const stamped = stamp(assembleSnapshot(synthetic(shape)));
      expect(OverviewSnapshotSchema.safeParse(stamped).success).toBe(true);
      expect(utf8ByteLength(JSON.stringify(stamped))).toBeLessThanOrEqual(OVERVIEW_SNAPSHOT_MAX_BYTES);
    };
    check(heaviest);
    fc.assert(fc.property(shapeArb, check), { numRuns: 25 });
  });
});
