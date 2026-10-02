import { describe, expect, it } from "vitest";

import { buildManifest, globToRegExp, parseJsonc, parsePnpmWorkspace, tsconfigFromTexts, workspaceGlobs } from "./manifest.js";

describe("parsePnpmWorkspace", () => {
  it("reads block lists with quotes, comments and column-zero items, and flow lists", () => {
    expect(parsePnpmWorkspace("packages:\n  - 'packages/*'\n  - apps/* # apps\n  - \"!**/test/**\"\nonlyBuilt: []\n")).toEqual([
      "packages/*",
      "apps/*",
      "!**/test/**",
    ]);
    expect(parsePnpmWorkspace("packages:\n- packages/*\n- evals\n")).toEqual(["packages/*", "evals"]);
    expect(parsePnpmWorkspace("packages: [packages/*, 'tools/*']\n")).toEqual(["packages/*", "tools/*"]);
  });
});

describe("workspaceGlobs", () => {
  it("reads npm and yarn workspaces fields", () => {
    expect(workspaceGlobs({ workspaces: ["packages/*"] })).toEqual(["packages/*"]);
    expect(workspaceGlobs({ workspaces: { packages: ["libs/*"] } })).toEqual(["libs/*"]);
    expect(workspaceGlobs({ name: "x" })).toEqual([]);
  });
});

describe("globToRegExp", () => {
  it.each([
    ["packages/*", "packages/core", true],
    ["packages/*", "packages/core/sub", false],
    ["packages/**", "packages/core/sub", true],
    ["**/test/**", "packages/a/test/x", true],
    ["./apps/*/", "apps/web", true],
    ["evals", "evals", true],
    ["**/test/**", "packages/skip/test", true],
  ])("%s matches %s: %s", (glob, dir, expected) => {
    expect(globToRegExp(glob).test(dir)).toBe(expected);
  });
});

describe("parseJsonc", () => {
  it("strips comments outside strings and trailing commas", () => {
    expect(parseJsonc('{\n  // note\n  "a": "x//y", /* block */ "b": ["@app/*",],\n}')).toEqual({ a: "x//y", b: ["@app/*"] });
  });
});

describe("buildManifest", () => {
  it("finds packages and apps, names, descriptions and entry points", () => {
    const paths = [
      "package.json",
      "pnpm-workspace.yaml",
      "packages/core/package.json",
      "packages/core/src/index.ts",
      "packages/cli/package.json",
      "packages/cli/bin/run.js",
      "packages/skip/test/package.json",
      "apps/web/src/main.tsx",
      "apps/web/package.json",
      "docs/package.json",
    ];
    const texts = new Map([
      ["package.json", '{"name":"root-pkg","description":"The whole repo."}'],
      ["pnpm-workspace.yaml", "packages:\n  - packages/**\n  - '!**/test/**'\n  - apps/*\n"],
      ["packages/core/package.json", '{"name":"@x/core","description":"Core.","main":"dist/index.js","exports":{".":{"import":"./dist/index.js"}}}'],
      ["packages/cli/package.json", '{"name":"@x/cli","bin":{"run":"bin/run.js"}}'],
      ["packages/skip/test/package.json", '{"name":"fixture"}'],
      ["apps/web/package.json", '{"name":"@x/web"}'],
      ["docs/package.json", '{"name":"docs-site"}'],
    ]);
    expect(buildManifest(paths, texts)).toEqual({
      packageDirs: ["packages/cli", "packages/core"],
      appDirs: ["apps/web"],
      packageNames: { ".": "root-pkg", "packages/cli": "@x/cli", "packages/core": "@x/core", "apps/web": "@x/web" },
      descriptions: { ".": "The whole repo.", "packages/core": "Core." },
      entryPoints: {
        "packages/cli": ["packages/cli/bin/run.js"],
        "packages/core": ["packages/core/src/index.ts"],
        "apps/web": ["apps/web/src/main.tsx"],
      },
    });
  });

  it("returns no packages without workspace globs", () => {
    expect(buildManifest(["package.json", "src/a.ts"], new Map([["package.json", "{}"]])).packageDirs).toEqual([]);
  });
});

describe("tsconfigFromTexts", () => {
  it("reads paths and baseUrl through relative extends, nearest file first", () => {
    const texts = new Map([
      ["tsconfig.json", '{ "extends": "./tsconfig.base", // base\n "compilerOptions": { "paths": { "@app/*": ["src/*"] } } }'],
      ["tsconfig.base.json", '{ "compilerOptions": { "baseUrl": ".", "paths": { "@ignored/*": ["x/*"] } } }'],
    ]);
    expect(tsconfigFromTexts(texts)).toEqual({ paths: { "@app/*": ["src/*"] }, baseUrl: "." });
  });

  it("returns empty paths and a null baseUrl without a root tsconfig.json", () => {
    expect(tsconfigFromTexts(new Map([["tsconfig.base.json", "{}"]]))).toEqual({ paths: {}, baseUrl: null });
  });
});
