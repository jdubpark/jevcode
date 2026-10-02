import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OverviewSnapshotSchema, type OverviewSnapshot } from "@jevcode/contracts";
import { assembleSnapshot, componentIdFor } from "@jevcode/codebase-map";
import { scanRepo } from "@jevcode/codebase-map/node";
import { extractImports } from "@jevcode/evidence-engine";
import { afterEach, describe, expect, it } from "vitest";

import { buildOverview, scanRepoModel, workspacePackagesOf } from "./explainer-overview.js";

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
      [".", "config", "config", true],
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

describe("buildOverview on this repo (index §9 lane 04 done)", () => {
  it(
    "matches the expected component table rows and edges",
    async () => {
      const model = await scanRepoModel(REPO_ROOT, { scan: scanRepo, extract: extractImports });
      const snapshot = snapshotOf(REPO_ROOT, buildOverview(model), model.partial);
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
