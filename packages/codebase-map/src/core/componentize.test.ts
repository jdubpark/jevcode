import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  SPLIT_THRESHOLD,
  componentIdFor,
  componentOf,
  componentize,
  contentHash,
  type ComponentDraft,
} from "./componentize.js";
import { languageOf } from "./paths.js";
import type { ScannedFile, WorkspaceManifest } from "./types.js";

const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");
const file = (path: string, hash = sha1(path)): ScannedFile => ({ path, hash, size: 10, language: languageOf(path) });
const files = (...paths: string[]): ScannedFile[] => paths.map((path) => file(path));
const manifest = (partial: Partial<WorkspaceManifest> = {}): WorkspaceManifest => ({
  packageDirs: [],
  appDirs: [],
  packageNames: {},
  descriptions: {},
  entryPoints: {},
  ...partial,
});
const table = (drafts: readonly ComponentDraft[]): [string, string, number][] =>
  drafts.map((draft) => [draft.rootPath, draft.name, draft.files.length]);
const range = (count: number, make: (index: number) => string): string[] =>
  Array.from({ length: count }, (_, index) => make(index));
const pad = (index: number): string => String(index).padStart(3, "0");

describe("componentize cut rules (spec §5.2)", () => {
  it("rule 1: workspace packages and apps, then top-level leftovers and the repo-root config component", () => {
    const drafts = componentize(
      files(
        "packages/a/package.json",
        "packages/a/src/index.ts",
        "packages/a/src/index.test.ts",
        "packages/b/src/main.ts",
        "apps/web/package.json",
        "apps/web/src/App.tsx",
        "docs/guide.md",
        "scripts/release.mjs",
        "package.json",
        "README.md",
        "pnpm-workspace.yaml",
      ),
      manifest({
        packageDirs: ["packages/a", "packages/b"],
        appDirs: ["apps/web"],
        packageNames: { "packages/a": "@x/a", "apps/web": "@x/web" },
      }),
    );
    expect(table(drafts)).toEqual([
      [".", "config", 3],
      ["apps/web", "@x/web", 2],
      ["docs", "docs", 1],
      ["packages/a", "@x/a", 3],
      ["packages/b", "b", 1],
      ["scripts", "scripts", 1],
    ]);
  });

  it("rule 2: top-level directories under src/ and lib/; files directly in src/ and src/__tests__ stay in src", () => {
    const drafts = componentize(
      files(
        "src/ui/Button.tsx",
        "src/ui/Menu.tsx",
        "src/db/client.ts",
        "src/index.ts",
        "src/__tests__/db.test.ts",
        "lib/util/x.js",
        "README.md",
      ),
      manifest(),
    );
    expect(table(drafts)).toEqual([
      [".", "config", 1],
      ["lib/util", "util", 1],
      ["src", "src", 2],
      ["src/db", "db", 1],
      ["src/ui", "ui", 2],
    ]);
  });

  it("rule 2: a flat src/ is one component", () => {
    expect(table(componentize(files("src/a.ts", "src/b.ts", "package.json"), manifest()))).toEqual([
      [".", "config", 1],
      ["src", "src", 2],
    ]);
  });

  it("names a repo whose files all sit at the root after its root package, else root", () => {
    expect(table(componentize(files("main.py", "util.py"), manifest({ packageNames: { ".": "tool" } })))).toEqual([
      [".", "tool", 2],
    ]);
    expect(table(componentize(files("main.py", "util.py"), manifest()))).toEqual([[".", "root", 2]]);
  });

  it("rule 3: splits above 150 files by the next branching level and keeps the rest in <name>/root", () => {
    const big = files(
      ...range(100, (i) => `packages/big/src/alpha/f${pad(i)}.ts`),
      ...range(50, (i) => `packages/big/src/beta/f${pad(i)}.ts`),
      "packages/big/package.json",
    );
    const layout = manifest({ packageDirs: ["packages/big"], packageNames: { "packages/big": "@x/big" } });
    expect(big).toHaveLength(SPLIT_THRESHOLD + 1);
    expect(table(componentize(big, layout))).toEqual([
      ["packages/big", "@x/big/root", 1],
      ["packages/big/src/alpha", "@x/big/alpha", 100],
      ["packages/big/src/beta", "@x/big/beta", 50],
    ]);
    expect(table(componentize(big.slice(0, SPLIT_THRESHOLD), layout))).toEqual([["packages/big", "@x/big", 150]]);
  });

  it("rule 3: a part that still has more than 150 files splits again; names drop src/", () => {
    const drafts = componentize(
      files(
        ...range(90, (i) => `packages/big/src/ui/a/f${pad(i)}.ts`),
        ...range(70, (i) => `packages/big/src/ui/b/f${pad(i)}.ts`),
        ...range(20, (i) => `packages/big/src/model/f${pad(i)}.ts`),
        "packages/big/scripts/run.mjs",
        "packages/big/package.json",
      ),
      manifest({ packageDirs: ["packages/big"], packageNames: { "packages/big": "@x/big" } }),
    );
    expect(table(drafts)).toEqual([
      ["packages/big", "@x/big/root", 1],
      ["packages/big/scripts", "@x/big/scripts", 1],
      ["packages/big/src/model", "@x/big/model", 20],
      ["packages/big/src/ui/a", "@x/big/ui/a", 90],
      ["packages/big/src/ui/b", "@x/big/ui/b", 70],
    ]);
  });

  it("rule 3: test directories never become parts; they stay in the root part", () => {
    const drafts = componentize(
      files(
        ...range(100, (i) => `packages/big/src/alpha/f${pad(i)}.ts`),
        ...range(40, (i) => `packages/big/src/beta/f${pad(i)}.ts`),
        ...range(10, (i) => `packages/big/test/t${pad(i)}.test.ts`),
        "packages/big/package.json",
      ),
      manifest({ packageDirs: ["packages/big"], packageNames: { "packages/big": "@x/big" } }),
    );
    expect(table(drafts)).toEqual([
      ["packages/big", "@x/big/root", 11],
      ["packages/big/src/alpha", "@x/big/alpha", 100],
      ["packages/big/src/beta", "@x/big/beta", 40],
    ]);
  });

  it("rule 4: test files join the nearest component", () => {
    const drafts = componentize(
      files("packages/a/src/x.ts", "packages/a/src/x.test.ts", "packages/a/__tests__/y.ts"),
      manifest({ packageDirs: ["packages/a"] }),
    );
    expect(table(drafts)).toEqual([["packages/a", "a", 3]]);
  });

  it("gives split parts the entry points that sit inside them", () => {
    const drafts = componentize(
      files(
        ...range(100, (i) => `packages/big/src/alpha/f${pad(i)}.ts`),
        ...range(50, (i) => `packages/big/src/beta/f${pad(i)}.ts`),
        "packages/big/package.json",
      ),
      manifest({
        packageDirs: ["packages/big"],
        entryPoints: {
          "packages/big": ["packages/big/src/alpha/f000.ts", "packages/big/src/beta/f001.ts", "packages/big/index.ts"],
        },
      }),
    );
    expect(drafts.map((draft) => [draft.rootPath, draft.entryPoints])).toEqual([
      ["packages/big", ["packages/big/index.ts"]],
      ["packages/big/src/alpha", ["packages/big/src/alpha/f000.ts"]],
      ["packages/big/src/beta", ["packages/big/src/beta/f001.ts"]],
    ]);
  });
});

describe("ids, content hashes and languages", () => {
  it("derives the id from the root path: cmp_ + the first 12 hex of sha1(rootPath)", () => {
    expect(componentIdFor("packages/storage")).toBe(`cmp_${sha1("packages/storage").slice(0, 12)}`);
    for (const draft of componentize(files("src/a/x.ts", "src/b/y.ts"), manifest())) {
      expect(draft.id).toBe(componentIdFor(draft.rootPath));
      expect(draft.id).toMatch(/^cmp_[0-9a-f]{12}$/);
    }
  });

  it("hashes the sorted path:hash lines of the members", () => {
    expect(contentHash([{ path: "b.ts", hash: "2" }, { path: "a.ts", hash: "1" }])).toBe(sha1("a.ts:1\nb.ts:2"));
    const [draft] = componentize([file("src/b.ts", "2"), file("src/a.ts", "1")], manifest());
    expect(draft?.contentHash).toBe(sha1("src/a.ts:1\nsrc/b.ts:2"));
  });

  it("records the main language and whether the parser reads any member", () => {
    const drafts = componentize(
      files("docs/a.md", "docs/b.md", "docs/c.ts", "svc/app.py", "svc/b.py", "cfg/a.json"),
      manifest(),
    );
    expect(drafts.map((draft) => [draft.rootPath, draft.language, draft.importsAnalyzed])).toEqual([
      ["cfg", "JSON", true],
      ["docs", "TypeScript", true],
      ["svc", "Python", false],
    ]);
  });

  it("componentOf maps every member to its component id and nothing else", () => {
    const drafts = componentize(files("src/a/x.ts", "src/b/y.ts"), manifest());
    const of = componentOf(drafts);
    expect(of("src/a/x.ts")).toBe(componentIdFor("src/a"));
    expect(of("src/b/y.ts")).toBe(componentIdFor("src/b"));
    expect(of("src/c/z.ts")).toBeUndefined();
  });
});
