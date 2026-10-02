import { OVERVIEW_SNAPSHOT_MAX_BYTES, OverviewSnapshotSchema } from "@jevcode/contracts";
import { describe, expect, it } from "vitest";

import { componentIdFor, componentOf, componentize } from "./componentize.js";
import { aggregateEdges, aggregateExternals } from "./edges.js";
import { languageOf } from "./paths.js";
import { sha1Hex, utf8ByteLength } from "./sha1.js";
import { MAX_COMPONENT_FILES, OTHER_ROOT_PATH, assembleSnapshot, type AssembleSnapshotInput } from "./snapshot.js";
import { emptyManifest, type ScannedFile } from "./types.js";

const file = (path: string): ScannedFile => ({ path, hash: sha1Hex(path), size: 1, language: languageOf(path) });
const pad = (index: number): string => String(index).padStart(3, "0");

function input(overrides: Partial<AssembleSnapshotInput>): AssembleSnapshotInput {
  return {
    sessionId: "sess_1",
    repoRoot: "/repo",
    scanId: "scan_1",
    partial: false,
    drafts: [],
    edges: [],
    externals: [],
    text: new Map(),
    narrative: null,
    generatedAt: "2026-10-02T00:00:00.000Z",
    ...overrides,
  };
}

function smallRepo(): Pick<AssembleSnapshotInput, "drafts" | "edges" | "externals"> {
  const drafts = componentize(
    ["src/ui/App.tsx", "src/ui/Menu.tsx", "src/db/client.ts", "src/db/schema.ts", "README.md"].map(file),
    emptyManifest(),
  );
  const of = componentOf(drafts);
  return {
    drafts,
    edges: aggregateEdges([{ from: "src/ui/App.tsx", to: "src/db/client.ts" }], of),
    externals: aggregateExternals(
      [
        { from: "src/ui/App.tsx", packageName: "react" },
        { from: "src/db/client.ts", packageName: "better-sqlite3" },
      ],
      of,
    ),
  };
}

describe("assembleSnapshot (spec §5.5)", () => {
  it("builds a schema-valid snapshot with rule-based text, true counts and per-component dependencies", () => {
    const snapshot = assembleSnapshot(input(smallRepo()));
    expect(OverviewSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(
      snapshot.components.map((c) => [c.rootPath, c.name, c.roleGuess, c.role, c.provenance, c.purpose, c.fileCount, c.externalDeps]),
    ).toEqual([
      [".", "config", "config", "config", "rule", null, 1, []],
      ["src/db", "db", "storage", "storage", "rule", null, 2, [{ name: "better-sqlite3", count: 1 }]],
      ["src/ui", "ui", "ui", "ui", "rule", null, 2, [{ name: "react", count: 1 }]],
    ]);
    expect(snapshot.edges).toEqual([
      { from: componentIdFor("src/ui"), to: componentIdFor("src/db"), count: 1, examples: ["src/ui/App.tsx → src/db/client.ts"] },
    ]);
    expect(snapshot.counts).toEqual({ files: 5, components: 3, edges: 1, languages: ["TypeScript", "Markdown"], totalFiles: 5 });
    expect(snapshot.status).toBeUndefined();
    expect(snapshot).toMatchObject({ sessionId: "sess_1", repoRoot: "/repo", scanId: "scan_1", partial: false, narrative: null });
  });

  it("uses confirmed text from the text map, clipped to 140 characters", () => {
    const repo = smallRepo();
    const db = componentIdFor("src/db");
    const snapshot = assembleSnapshot(
      input({ ...repo, text: new Map([[db, { purpose: "p".repeat(200), role: "domain", provenance: "model" }]]) }),
    );
    const component = snapshot.components.find((c) => c.id === db);
    expect(component).toMatchObject({ roleGuess: "storage", role: "domain", provenance: "model" });
    expect(component?.purpose).toHaveLength(140);
    expect(component?.purpose?.endsWith("…")).toBe(true);
  });

  it("lists at most 400 files per component and keeps the true count", () => {
    const drafts = componentize(Array.from({ length: 450 }, (_, i) => file(`src/f${pad(i)}.ts`)), emptyManifest());
    const [component] = assembleSnapshot(input({ drafts })).components;
    expect(component?.files).toHaveLength(MAX_COMPONENT_FILES);
    expect(component?.fileCount).toBe(450);
  });

  it("groups the smallest components past 200 into other and re-points their edges and dependencies", () => {
    const paths = [
      ...Array.from({ length: 199 }, (_, i) => [0, 1, 2].map((k) => `src/m${pad(i)}/f${k}.ts`)).flat(),
      ...Array.from({ length: 31 }, (_, i) => `src/m${pad(199 + i)}/f0.ts`),
    ];
    const drafts = componentize(paths.map(file), emptyManifest());
    expect(drafts).toHaveLength(230);
    const id = (index: number): string => componentIdFor(`src/m${pad(index)}`);
    const snapshot = assembleSnapshot(
      input({
        drafts,
        edges: [
          { from: id(0), to: id(200), count: 2, examples: ["src/m000/f0.ts → src/m200/f0.ts"] },
          { from: id(201), to: id(202), count: 5, examples: [] },
          { from: id(203), to: id(0), count: 1, examples: [] },
          { from: id(204), to: id(1), count: 4, examples: [] },
        ],
        externals: [{ name: "react", usedBy: [{ componentId: id(200), count: 1 }, { componentId: id(201), count: 1 }] }],
      }),
    );
    expect(OverviewSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.components).toHaveLength(200);
    expect(snapshot.counts.components).toBe(230);
    const other = snapshot.components.find((c) => c.rootPath === OTHER_ROOT_PATH);
    expect(other).toMatchObject({ id: componentIdFor(OTHER_ROOT_PATH), name: "other", fileCount: 31, roleGuess: "domain" });
    expect(snapshot.edges.map((e) => [e.from, e.to, e.count])).toEqual([
      [other?.id, id(1), 4],
      [id(0), other?.id, 2],
      [other?.id, id(0), 1],
    ]);
    expect(snapshot.externals).toEqual([{ name: "react", usedBy: [{ componentId: other?.id, count: 2 }] }]);
  });

  it("trims file lists until the serialized row fits in 512 KB", () => {
    const deep = "d".repeat(180);
    const paths = Array.from({ length: 200 }, (_, i) =>
      Array.from({ length: 300 }, (_, k) => `src/m${pad(i)}/${deep}/f${pad(k)}.ts`),
    ).flat();
    const snapshot = assembleSnapshot(input({ drafts: componentize(paths.map(file), emptyManifest()) }));
    expect(OverviewSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(utf8ByteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(OVERVIEW_SNAPSHOT_MAX_BYTES);
    expect(snapshot.components.every((c) => c.fileCount === 300 && c.files.length < 300)).toBe(true);
  });

  it("records the repo's file total before the scan cap (ruling R3)", () => {
    expect(assembleSnapshot(input({ ...smallRepo(), partial: true, totalFiles: 25_200 })).counts).toMatchObject({
      files: 5,
      totalFiles: 25_200,
    });
  });

  it("passes the narrative through", () => {
    const narrative = {
      sentences: [{ text: "The UI reads the database.", citations: [{ kind: "component" as const, id: componentIdFor("src/ui") }] }],
      provenance: "model" as const,
    };
    expect(assembleSnapshot(input({ ...smallRepo(), narrative })).narrative).toEqual(narrative);
  });
});
