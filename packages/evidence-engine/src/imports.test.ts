import { describe, expect, it } from "vitest";

import {
  createImportExtractor,
  extractImports,
  packageNameOf,
  probeCandidatesFor,
  resolveSpecifier,
  type ResolveContext,
  type ResolvedSpecifier,
} from "./imports.js";

const TS_SOURCE = `import a from "./a.js";
import type { T } from "@scope/pkg/deep";
import "side-effect";
import x = require("old-style");
export * from "./re";
export { y as z } from "./y";
export const one = 1, two = 2;
export function f() {}
export class C {}
export interface I {}
export type U = string;
export enum E { A }
export default 42;
const w = require("cjs-dep");
async function g() { await import("./lazy"); const t = "x"; await import(t); }
const local = 1;
export { local, local as aliased };
`;

describe("extractImports (spec §5.1, E14)", () => {
  it("reads every static, re-export, require and dynamic import form in TypeScript", async () => {
    expect(await extractImports("src/a.ts", TS_SOURCE, "typescript")).toEqual({
      specifiers: ["./a.js", "./lazy", "./re", "./y", "@scope/pkg/deep", "cjs-dep", "old-style", "side-effect"],
      exports: ["C", "E", "I", "U", "aliased", "default", "f", "local", "one", "two", "z"],
    });
  });

  it("reads TSX and JavaScript", async () => {
    expect(
      await extractImports(
        "src/App.tsx",
        'import { useState } from "react";\nimport { App } from "./App.js";\nexport function Root() { return <App/>; }\nexport default function Page() { return null; }\n',
        "tsx",
      ),
    ).toEqual({ specifiers: ["./App.js", "react"], exports: ["Page", "Root"] });
    expect(
      await extractImports(
        "lib/x.js",
        'const fs = require("node:fs");\nimport lib from "lib";\nexport default class Foo {}\nexport { lib };\n',
        "javascript",
      ),
    ).toEqual({ specifiers: ["lib", "node:fs"], exports: ["Foo", "lib"] });
  });

  it("returns nothing for JSON without parsing it", async () => {
    expect(await extractImports("package.json", "{ not json", "json")).toEqual({ specifiers: [], exports: [] });
  });
});

const CTX: ResolveContext = {
  files: new Set([
    "src/a.ts",
    "src/b/index.ts",
    "src/c.tsx",
    "src/util.ts",
    "src/data.json",
    "lib/x.js",
    "packages/core/src/index.ts",
    "packages/core/src/node.ts",
    "packages/ui/lib/main.js",
    "types/global.d.ts",
  ]),
  tsPaths: { "@app/*": ["src/*"], "~config": ["src/util.ts"] },
  baseUrl: ".",
  workspacePackages: { "@fx/core": "packages/core", "@fx/ui": "packages/ui" },
};

const file = (path: string): ResolvedSpecifier => ({ kind: "file", path });
const external = (packageName: string): ResolvedSpecifier => ({ kind: "external", packageName });
const UNRESOLVED: ResolvedSpecifier = { kind: "unresolved" };

describe("resolveSpecifier (spec §5.1)", () => {
  it.each([
    ["./util.js", file("src/util.ts")],
    ["./b", file("src/b/index.ts")],
    ["./c.js", file("src/c.tsx")],
    ["./data.json", file("src/data.json")],
    ["./util.ts?raw", file("src/util.ts")],
    ["../types/global", file("types/global.d.ts")],
    ["../../outside", UNRESOLVED],
    ["./missing", UNRESOLVED],
    ["@app/util", file("src/util.ts")],
    ["~config", file("src/util.ts")],
    ["@fx/core", file("packages/core/src/index.ts")],
    ["@fx/core/node", file("packages/core/src/node.ts")],
    ["@fx/ui", file("packages/ui/lib/main.js")],
    ["lib/x", file("lib/x.js")],
    ["node:fs", UNRESOLVED],
    ["path", UNRESOLVED],
    ["fs/promises", UNRESOLVED],
    ["react", external("react")],
    ["react-dom/client", external("react-dom")],
    ["@scope/pkg/deep/x", external("@scope/pkg")],
    ["lodash/fp", external("lodash")],
    ["virtual:pwa", UNRESOLVED],
    ["$app/stores", UNRESOLVED],
    ["/abs/path", UNRESOLVED],
  ])("src/a.ts imports %s", (specifier, expected) => {
    expect(resolveSpecifier("src/a.ts", specifier, CTX)).toEqual(expected);
  });

  it("resolves relative paths from the importing file's directory", () => {
    expect(resolveSpecifier("src/b/index.ts", "../util", CTX)).toEqual(file("src/util.ts"));
  });

  it("treats replacement patterns in a wildcard specifier literally", () => {
    const ctx: ResolveContext = { ...CTX, files: new Set([...CTX.files, "src/$&.ts"]) };
    expect(resolveSpecifier("src/a.ts", "@app/$&", ctx)).toEqual(file("src/$&.ts"));
    expect(resolveSpecifier("src/a.ts", "@app/$'x", ctx)).toEqual(UNRESOLVED);
  });

  it("keeps config-driven escapes inside the repo", () => {
    const escaping: ResolveContext = {
      ...CTX,
      tsPaths: { ...CTX.tsPaths, "@esc/*": ["src/*"] },
      workspacePackages: { ...CTX.workspacePackages },
    };
    expect(resolveSpecifier("src/a.ts", "@app/../../x", escaping)).toEqual(UNRESOLVED);
    // A workspace subpath may fall back to a member file of the package, never to a path outside the repo.
    const viaWorkspace = resolveSpecifier("src/a.ts", "@fx/core/../../../x", escaping);
    expect(viaWorkspace.kind === "unresolved" || (viaWorkspace.kind === "file" && escaping.files.has(viaWorkspace.path))).toBe(true);
    const up: ResolveContext = { ...CTX, baseUrl: "..", files: new Set(["x.ts", ...CTX.files]) };
    // "../x" leaves the repo: no file hit, so "x" reads as a package.
    expect(resolveSpecifier("src/a.ts", "x", up)).toEqual(external("x"));
  });

  it("reads bare specifiers as packages when there is no baseUrl", () => {
    expect(resolveSpecifier("src/a.ts", "lib/x", { ...CTX, baseUrl: null })).toEqual(external("lib"));
  });
});

/** mulberry32: a seeded PRNG, so the property run is the same on every machine. */
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

describe("resolveSpecifier trace (incremental resolution)", () => {
  const DIRS = ["", "src", "src/b", "lib", "types", "packages/core", "packages/core/src", "packages/ui", "packages/ui/lib"];
  const STEMS = ["a", "b", "index", "util", "main", "node", "x", "global"];
  const EXTS = ["", ".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json"];
  const SPECIFIERS = [
    "./a", "./a.js", "./b", "../b", "./b/index.js", "./util.js", "../types/global", "./x.mjs", "./main.cjs",
    "@app/a", "@app/b/index", "~cfg", "@fx/core", "@fx/core/node", "@fx/ui", "@fx/ui/main", "lib/x", "a", "util",
    "types/global", "react", "./data.json",
  ];

  it("hears a lookup of every path whose addition or removal changes the result", () => {
    const random = seeded(0x1d3a);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const somePath = (): string => {
      const dir = pick(DIRS);
      const name = `${pick(STEMS)}${pick(EXTS)}`;
      return dir === "" ? name : `${dir}/${name}`;
    };
    let changed = 0;
    for (let run = 0; run < 4_000; run += 1) {
      const base = new Set(Array.from({ length: Math.floor(random() * 14) }, somePath));
      const target = somePath();
      const from = somePath();
      const specifier = pick(SPECIFIERS);
      const config = {
        tsPaths: random() < 0.5 ? { "@app/*": ["src/*"], "~cfg": ["src/util.ts", "lib/x.js"] } : {},
        baseUrl: pick([".", null, "src"]),
        workspacePackages: { "@fx/core": "packages/core", "@fx/ui": "packages/ui" },
      };
      const without = new Set([...base].filter((path) => path !== target));
      const withTarget = new Set([...without, target]);
      for (const [before, after] of [
        [without, withTarget],
        [withTarget, without],
      ] as const) {
        const probes = new Set<string>();
        const under = new Set<string>();
        const trace = { probe: (candidate: string) => void probes.add(candidate), under: (dir: string) => void under.add(dir) };
        const was = resolveSpecifier(from, specifier, { ...config, files: before }, trace);
        const now = resolveSpecifier(from, specifier, { ...config, files: after });
        if (JSON.stringify(was) === JSON.stringify(now)) continue;
        changed += 1;
        const heard =
          probeCandidatesFor(target).some((candidate) => probes.has(candidate)) ||
          [...under].some((dir) => target.startsWith(`${dir}/`));
        expect(heard, `${from} imports ${specifier}; ${target} toggled`).toBe(true);
      }
    }
    expect(changed).toBeGreaterThan(200);
  });

  it("lists the candidates whose probes read a path", () => {
    expect(probeCandidatesFor("src/b/index.ts").sort()).toEqual(["src/b", "src/b/index", "src/b/index.js", "src/b/index.ts"]);
    expect(probeCandidatesFor("src/c.tsx").sort()).toEqual(["src/c", "src/c.js", "src/c.jsx", "src/c.tsx"]);
  });
});

describe("packageNameOf", () => {
  it.each([
    ["react", "react"],
    ["@scope/pkg/deep", "@scope/pkg"],
    ["@scope", null],
    ["virtual:x", null],
  ])("%s → %s", (specifier, expected) => {
    expect(packageNameOf(specifier)).toBe(expected);
  });
});

const OP_WORKER = `
import { parentPort, threadId } from "node:worker_threads";
parentPort.on("message", (msg) => {
  if (msg.op === "imports") {
    parentPort.postMessage({ id: msg.id, filePath: msg.filePath, imports: { specifiers: [msg.source], exports: [String(threadId)] } });
  } else {
    parentPort.postMessage({ id: msg.id, filePath: msg.filePath, symbols: [] });
  }
});
`;
const opWorkerUrl = (): URL => new URL(`data:text/javascript;base64,${Buffer.from(OP_WORKER, "utf8").toString("base64")}`);

describe("createImportExtractor", () => {
  it("extracts in a worker pool, restarts the pool after it idles out, and refuses work after dispose", async () => {
    const extractor = createImportExtractor({ size: 1, workerUrl: opWorkerUrl(), idleMs: 20 });
    try {
      const first = await extractor.extract("a.ts", "./one", "typescript");
      expect(first.specifiers).toEqual(["./one"]);
      const sameBurst = await extractor.extract("a2.ts", "./one-b", "typescript");
      expect(sameBurst.exports).toEqual(first.exports);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const second = await extractor.extract("b.ts", "./two", "typescript");
      expect(second.specifiers).toEqual(["./two"]);
      // A new pool means a new worker thread; a pool that never idled out would reuse the first.
      expect(second.exports).not.toEqual(first.exports);
      expect(await extractor.extract("c.json", "{}", "json")).toEqual({ specifiers: [], exports: [] });
    } finally {
      await extractor.dispose();
    }
    await expect(extractor.extract("d.ts", "x", "typescript")).rejects.toThrow(/disposed/);
  });
});
