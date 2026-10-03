import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OverviewSnapshotSchema, type OverviewSnapshot } from "@jevcode/contracts";
import { assembleSnapshot, componentIdFor, languageOf } from "@jevcode/codebase-map";
import { scanRepo } from "@jevcode/codebase-map/node";
import { extractImports } from "@jevcode/evidence-engine";
import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_INCREMENTAL_WORK,
  OverviewIndex,
  WORK_PER_REGROUPED_FILE,
  WORK_PER_SPECIFIER,
  buildOverview,
  runSliced,
  scanRepoModel,
  workspacePackagesOf,
  type BuiltOverview,
  type FileChanges,
  type RepoModel,
} from "./explainer-overview.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../");

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function gitRepo(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "jevcode-overview-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

const WORKSPACE: Record<string, string> = {
  "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
  "package.json": '{"name":"fx-root","private":true}',
  "tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"@app/*":["apps/web/src/*"]}}}',
  "packages/core/package.json": '{"name":"@fx/core","main":"dist/index.js"}',
  "packages/core/src/index.ts": 'export * from "./user.js";\n',
  "packages/core/src/user.ts": "export interface User { id: string }\nexport function makeUser(id: string): User { return { id }; }\n",
  "packages/db/package.json": '{"name":"@fx/db","main":"dist/index.js"}',
  "packages/db/src/index.ts":
    'import Database from "better-sqlite3";\nimport type { User } from "@fx/core";\nexport function open(): Database.Database { return new Database(":memory:"); }\nexport type Row = User;\n',
  "apps/web/package.json": '{"name":"@fx/web","main":"src/main.tsx"}',
  "apps/web/src/main.tsx": 'import { createRoot } from "react-dom/client";\nimport { App } from "./App.js";\ncreateRoot(document.body).render(<App />);\n',
  "apps/web/src/App.tsx":
    'import { useState } from "react";\nimport { makeUser } from "@fx/core";\nimport { loadUsers } from "@app/api.js";\nexport function App() { const [u] = useState(makeUser("a")); void loadUsers; return <p>{u.id}</p>; }\n',
  "apps/web/src/api.ts": 'import { open } from "@fx/db";\nexport async function loadUsers() { return open(); }\n',
  "scripts/release.mjs": 'import { execSync } from "node:child_process";\nexecSync("echo release");\n',
};

function snapshotOf(repoRoot: string, built: ReturnType<typeof buildOverview>, partial: boolean): OverviewSnapshot {
  return assembleSnapshot({
    sessionId: "sess_overview",
    repoRoot,
    scanId: "scan_overview",
    partial,
    drafts: built.drafts,
    edges: built.edges,
    totalEdges: built.totalEdges,
    externals: built.externals,
    text: new Map(),
    narrative: null,
    generatedAt: "2026-10-02T00:00:00.000Z",
  });
}

describe("buildOverview on a pnpm workspace fixture (spec §5, §12)", () => {
  it("maps components, roles, import edges, externals and exported names", async () => {
    const root = gitRepo(WORKSPACE);
    const model = await scanRepoModel(root, { scan: scanRepo, extract: extractImports });
    expect(workspacePackagesOf(model.manifest)).toEqual({ "@fx/core": "packages/core", "@fx/db": "packages/db", "@fx/web": "apps/web" });
    const built = buildOverview(model);
    const snapshot = snapshotOf(root, built, model.partial);
    expect(OverviewSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect([built.totalEdges, snapshot.counts.edges]).toEqual([3, 3]);
    expect(snapshot.components.map((c) => [c.rootPath, c.name, c.roleGuess, c.importsAnalyzed])).toEqual([
      [".", "config", "config", false],
      ["apps/web", "@fx/web", "ui", true],
      ["packages/core", "@fx/core", "domain", true],
      ["packages/db", "@fx/db", "storage", true],
      ["scripts", "scripts", "tooling", true],
    ]);
    const rootOf = new Map(snapshot.components.map((c) => [c.id, c.rootPath]));
    expect(
      snapshot.edges.map((e) => [rootOf.get(e.from), rootOf.get(e.to), e.count, e.examples]).sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual([
      ["apps/web", "packages/core", 1, ["apps/web/src/App.tsx → packages/core/src/index.ts"]],
      ["apps/web", "packages/db", 1, ["apps/web/src/api.ts → packages/db/src/index.ts"]],
      ["packages/db", "packages/core", 1, ["packages/db/src/index.ts → packages/core/src/index.ts"]],
    ]);
    expect(snapshot.externals.map((d) => [d.name, d.usedBy.map((u) => [rootOf.get(u.componentId), u.count])])).toEqual([
      ["better-sqlite3", [["packages/db", 1]]],
      ["react", [["apps/web", 1]]],
      ["react-dom", [["apps/web", 1]]],
    ]);
    expect(built.exportsByComponent.get(componentIdFor("packages/core"))).toEqual(["User", "makeUser"]);
  });
});

/** Lane 04's merge: the commit whose tree the expected table below was written against. */
const TABLE_COMMIT = "e7f6a3d";

/** The tree of TABLE_COMMIT in a temp dir (a git repo of its own), or null when git or the commit is unavailable. */
function materializePinnedTree(): string | null {
  try {
    execFileSync("git", ["cat-file", "-e", `${TABLE_COMMIT}^{commit}`], { cwd: REPO_ROOT, stdio: "ignore" });
    const root = mkdtempSync(path.join(os.tmpdir(), "jevcode-pinned-"));
    roots.push(root);
    const tar = path.join(root, ".tree.tar");
    execFileSync("git", ["archive", "--format=tar", "-o", tar, TABLE_COMMIT], { cwd: REPO_ROOT });
    execFileSync("tar", ["-xf", tar, "-C", root]);
    rmSync(tar);
    execFileSync("git", ["init", "-q"], { cwd: root });
    return root;
  } catch {
    return null;
  }
}

// The scan runs on the pinned tree, not the working tree, so the table does not break whenever this repo grows
// (the cut rules split a directory past 150 files).
describe(`buildOverview on this repo's tree at ${TABLE_COMMIT} (index §9 lane 04 done)`, () => {
  it(
    "matches the expected component table rows and edges",
    async (context) => {
      const pinned = materializePinnedTree();
      if (pinned === null) {
        context.skip(`commit ${TABLE_COMMIT} or git is unavailable (shallow clone?): the pinned-tree table check was skipped`);
        return;
      }
      const model = await scanRepoModel(pinned, { scan: scanRepo, extract: extractImports });
      const snapshot = snapshotOf(pinned, buildOverview(model), model.partial);
      expect(OverviewSnapshotSchema.safeParse(snapshot).success).toBe(true);
      expect(snapshot.partial).toBe(false);
      const row = (rootPath: string) => {
        const component = snapshot.components.find((c) => c.rootPath === rootPath);
        return component === undefined ? undefined : [component.name, component.roleGuess];
      };
      expect(row(".")).toEqual(["config", "config"]);
      expect(row("packages/contracts")).toEqual(["@jevcode/contracts", "domain"]);
      expect(row("packages/storage")).toEqual(["@jevcode/storage", "storage"]);
      expect(row("packages/ui-catalog")).toEqual(["@jevcode/ui-catalog", "ui"]);
      expect(row("packages/agent-codex")).toEqual(["@jevcode/agent-codex", "agent"]);
      expect(row("packages/jev-router")).toEqual(["@jevcode/jev-router", "agent"]);
      expect(row("packages/trace-viewer/src/ui")).toEqual(["@jevcode/trace-viewer/ui", "ui"]);
      expect(row("scripts")).toEqual(["scripts", "tooling"]);
      const storageToContracts = snapshot.edges.find(
        (e) => e.from === componentIdFor("packages/storage") && e.to === componentIdFor("packages/contracts"),
      );
      expect(storageToContracts?.count).toBeGreaterThan(0);
    },
    60_000,
  );
});

/** mulberry32: a seeded PRNG, so every run checks the same sequences. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const DIRS = ["", "src", "src/a", "src/b", "src/b/test", "lib", "types", "scripts", "packages/core/src", "packages/ui/src", "apps/web/src"];
const STEMS = ["index", "a", "b", "util", "main", "x"];
const EXTS = [".ts", ".tsx", ".js", ".d.ts", ".json", ".md"];
const SPECIFIERS = [
  "./a", "./a.js", "../b", "./b/index.js", "../types/x", "../../types/x", "./util", "./x.json",
  "@fx/core", "@fx/core/util", "@fx/ui", "@fx/web/main", "@app/a", "@app/b/index", "src/a", "types/x", "lib/util",
  "react", "zod", "better-sqlite3", "@anthropic-ai/sdk", "node:fs", "path", "virtual:x",
  // Into the group near the split threshold, so a split moves the files other components import.
  "@fx/core/x/f1", "@fx/core/y/f2", "packages/core/src/x/f3", "packages/core/src/y/f4",
];
const EXPORTS = ["User", "makeUser", "open", "Row", "App", "run", "default"];

function randomModel(random: () => number): RepoModel {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const workspace = random() < 0.6;
  const model: RepoModel = {
    files: new Map(),
    imports: new Map(),
    manifest: workspace
      ? {
          packageDirs: ["packages/core", "packages/ui"],
          appDirs: ["apps/web"],
          packageNames: { "packages/core": "@fx/core", "packages/ui": "@fx/ui", "apps/web": "@fx/web" },
          descriptions: {},
          entryPoints: {},
        }
      : { packageDirs: [], appDirs: [], packageNames: {}, descriptions: {}, entryPoints: {} },
    tsconfig: { paths: random() < 0.5 ? { "@app/*": ["src/*"] } : {}, baseUrl: pick([".", null]) },
    partial: false,
    totalFiles: 0,
  };
  const count = Math.floor(random() * 40);
  for (let i = 0; i < count; i += 1) writeFile(model, randomPath(random), random);
  // A group near the 150-file split threshold, so changes move files between parts.
  if (random() < 0.4) {
    for (let i = 0; i < 148 + Math.floor(random() * 5); i += 1) writeFile(model, `packages/core/src/${pick(["x", "y"])}/f${i}.ts`, random);
  }
  return model;
}

function randomPath(random: () => number): string {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const dir = pick(DIRS);
  const name = `${pick(STEMS)}${pick(EXTS)}`;
  return dir === "" ? name : `${dir}/${name}`;
}

/** Writes a file with random content and imports, as the scan's visit would record it. */
function writeFile(model: RepoModel, filePath: string, random: () => number): void {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  model.files.set(filePath, { path: filePath, hash: random().toString(16).slice(2), size: 1, language: languageOf(filePath) });
  if (/\.(tsx?|js)$/.test(filePath)) {
    const specifiers = Array.from({ length: Math.floor(random() * 5) }, () => pick(SPECIFIERS));
    const exports = Array.from({ length: Math.floor(random() * 3) }, () => pick(EXPORTS));
    model.imports.set(filePath, { specifiers, exports });
  } else {
    model.imports.delete(filePath);
  }
}

function comparable(built: BuiltOverview): unknown {
  return {
    ...built,
    roleGuess: [...built.roleGuess.entries()].sort(),
    exportsByComponent: [...built.exportsByComponent.entries()].sort(),
  };
}

describe("OverviewIndex (spec §6.1: incremental rebuilds equal a fresh build)", () => {
  it("equals buildOverview of the same model after any sequence of adds, edits and removes", () => {
    const random = seeded(0x04f1);
    let incremental = 0;
    for (let run = 0; run < 60; run += 1) {
      const model = randomModel(random);
      let index = OverviewIndex.build(model);
      expect(comparable(index.overview())).toEqual(comparable(buildOverview(model)));
      for (let step = 0; step < 25; step += 1) {
        const changes: FileChanges = { added: [], removed: [], edited: [] };
        for (let op = 0; op < 1 + Math.floor(random() * 3); op += 1) {
          const roll = random();
          const members = [...model.files.keys()].filter((p) => !changes.removed.includes(p) && !changes.added.includes(p) && !changes.edited.includes(p));
          if (roll < 0.45 || members.length === 0) {
            const filePath = random() < 0.3 ? `packages/core/src/${random() < 0.5 ? "x" : "y"}/f${Math.floor(random() * 200)}.ts` : randomPath(random);
            if (model.files.has(filePath) || changes.removed.includes(filePath)) continue;
            writeFile(model, filePath, random);
            changes.added.push(filePath);
          } else if (roll < 0.75) {
            const filePath = members[Math.floor(random() * members.length)] as string;
            writeFile(model, filePath, random);
            changes.edited.push(filePath);
          } else {
            const filePath = members[Math.floor(random() * members.length)] as string;
            model.files.delete(filePath);
            model.imports.delete(filePath);
            changes.removed.push(filePath);
          }
        }
        if (index.update(changes)) incremental += 1;
        else index = OverviewIndex.build(model);
        expect(comparable(index.overview()), `run ${run} step ${step}`).toEqual(comparable(buildOverview(model)));
      }
    }
    expect(incremental).toBeGreaterThan(1_000);
  });
});

describe("OverviewIndex roles", () => {
  it("re-guesses the role of a component whose members changed while the externals did not", () => {
    const model: RepoModel = {
      files: new Map(),
      imports: new Map(),
      manifest: { packageDirs: [], appDirs: [], packageNames: {}, descriptions: {}, entryPoints: {} },
      tsconfig: { paths: {}, baseUrl: null },
      partial: false,
      totalFiles: 0,
    };
    const put = (filePath: string, specifiers: string[]): void => {
      model.files.set(filePath, { path: filePath, hash: filePath, size: 1, language: languageOf(filePath) });
      model.imports.set(filePath, { specifiers, exports: [] });
    };
    put("src/b/notes.ts", []);
    put("src/b/test/x.test.ts", []);
    put("src/ui/App.tsx", ["react"]);
    const index = OverviewIndex.build(model);
    const roleOfB = (built: BuiltOverview) => built.roleGuess.get(componentIdFor("src/b"));
    expect(roleOfB(index.overview())).toBe("domain");

    model.files.delete("src/b/notes.ts");
    model.imports.delete("src/b/notes.ts");
    expect(index.update({ added: [], removed: ["src/b/notes.ts"], edited: [] })).toBe(true);
    expect(roleOfB(index.overview())).toBe("tests");
    expect(comparable(index.overview())).toEqual(comparable(buildOverview(model)));
  });
});

describe("OverviewIndex work bound (spec §6.1)", () => {
  const emptyModel = (): RepoModel => ({
    files: new Map(),
    imports: new Map(),
    manifest: { packageDirs: [], appDirs: [], packageNames: {}, descriptions: {}, entryPoints: {} },
    tsconfig: { paths: {}, baseUrl: null },
    partial: false,
    totalFiles: 0,
  });
  const put = (model: RepoModel, filePath: string, specifiers: string[]): void => {
    model.files.set(filePath, { path: filePath, hash: `h${model.files.size}`, size: 1, language: languageOf(filePath) });
    model.imports.set(filePath, { specifiers, exports: [] });
  };

  it("declines an update whose work exceeds MAX_INCREMENTAL_WORK, so the stage rebuilds in slices", () => {
    const perFile = WORK_PER_REGROUPED_FILE + 10 * WORK_PER_SPECIFIER;
    const largest = Math.floor((MAX_INCREMENTAL_WORK - 1) / perFile);
    const withBatch = (count: number): boolean => {
      const model = emptyModel();
      put(model, "src/a/seed.ts", []);
      const index = OverviewIndex.build(model);
      const added = Array.from({ length: count }, (_, n) => `src/a/f${n}.ts`);
      for (const filePath of added) put(model, filePath, Array.from({ length: 10 }, (_, k) => `./f${(Number(filePath.slice(7, -3)) + k + 1) % count}`));
      const applied = index.update({ added, removed: [], edited: [] });
      if (applied) expect(comparable(index.overview())).toEqual(comparable(buildOverview(model)));
      return applied;
    };
    expect(withBatch(largest)).toBe(true);
    expect(withBatch(largest + 1)).toBe(false);
  });

  it("re-resolves a package's importers only when the package's first member file changes", () => {
    // @fx/core has no entry file, so 2,000 importers take its first member file (packages/core/src/b.ts).
    const model: RepoModel = {
      ...emptyModel(),
      manifest: {
        packageDirs: ["packages/core", "packages/web"],
        appDirs: [],
        packageNames: { "packages/core": "@fx/core", "packages/web": "@fx/web" },
        descriptions: {},
        entryPoints: {},
      },
    };
    put(model, "packages/core/src/b.ts", []);
    for (let n = 0; n < 2_000; n += 1) put(model, `packages/web/src/d${n % 20}/f${n}.ts`, ["@fx/core", "react", "zod", "./x", "../y"]);
    let index = OverviewIndex.build(model);
    // After the first member: no importer can change, so the update stays small and incremental.
    put(model, "packages/core/src/c.ts", []);
    expect(index.update({ added: ["packages/core/src/c.ts"], removed: [], edited: [] })).toBe(true);
    expect(comparable(index.overview())).toEqual(comparable(buildOverview(model)));
    // Before it: every importer now resolves to the new file, more work than one update may do.
    put(model, "packages/core/src/a.ts", []);
    expect(index.update({ added: ["packages/core/src/a.ts"], removed: [], edited: [] })).toBe(false);
    index = OverviewIndex.build(model);
    // Removing a member that is not the first changes nothing for the importers either.
    model.files.delete("packages/core/src/c.ts");
    model.imports.delete("packages/core/src/c.ts");
    expect(index.update({ added: [], removed: ["packages/core/src/c.ts"], edited: [] })).toBe(true);
    expect(comparable(index.overview())).toEqual(comparable(buildOverview(model)));
  });

  it("re-resolves the importers of a probed name only when the probe finds another file", () => {
    const model = emptyModel();
    put(model, "src/lib/util.ts", []);
    for (let n = 0; n < 2_000; n += 1) put(model, `src/lib/f${n}.ts`, ["./util", "./util.js", "react", "zod", "./other"]);
    const index = OverviewIndex.build(model);
    // "./util" still finds util.ts first (.ts probes before .json): no importer changes.
    put(model, "src/lib/util.json", []);
    model.imports.delete("src/lib/util.json");
    expect(index.update({ added: ["src/lib/util.json"], removed: [], edited: [] })).toBe(true);
    expect(comparable(index.overview())).toEqual(comparable(buildOverview(model)));
    // Removing util.ts makes "./util" find util.json: every importer changes.
    model.files.delete("src/lib/util.ts");
    model.imports.delete("src/lib/util.ts");
    expect(index.update({ added: [], removed: ["src/lib/util.ts"], edited: [] })).toBe(false);
  });
});

describe("runSliced", () => {
  it("yields to the event loop between slices and stops when cancelled", async () => {
    function* steps(): Generator<void, string> {
      for (let i = 0; i < 5; i += 1) yield;
      return "done";
    }
    let clock = 0;
    const now = (): number => (clock += 10);
    expect(await runSliced(steps(), { sliceMs: 1_000, now })).toEqual({ value: "done", yielded: false });
    expect(await runSliced(steps(), { sliceMs: 15, now })).toEqual({ value: "done", yielded: true });
    expect(await runSliced(steps(), { sliceMs: 15, now, cancelled: () => true })).toBeNull();
  });
});
