import { builtinModules } from "node:module";
import { availableParallelism } from "node:os";

import { AnalysisPool } from "./worker/parse-service.js";
import { createTreeSitterBackend, type ParserLanguage, type TreeSitterBackend } from "./worker/parser.js";
import type { ImportScan } from "./worker/tree-sitter.js";

/** Import specifiers and top-level exported names of one file. */
export type ExtractedImports = ImportScan;

/** Resolution inputs for one repo. `tsPaths` targets are relative to `baseUrl ?? "."`. */
export interface ResolveContext {
  files: ReadonlySet<string>;
  tsPaths: Record<string, string[]>;
  baseUrl: string | null;
  /** Workspace package name → package directory, e.g. "@jevcode/contracts" → "packages/contracts". */
  workspacePackages: Record<string, string>;
}

export type ResolvedSpecifier =
  | { kind: "file"; path: string }
  | { kind: "external"; packageName: string }
  | { kind: "unresolved" };

export interface ImportExtractor {
  extract: typeof extractImports;
  dispose(): Promise<void>;
}

export interface ImportExtractorOptions {
  size?: number;
  workerUrl?: URL;
  idleMs?: number;
}

/** A pool with no work for this long stops its workers; the next call starts a new pool. */
export const IMPORT_POOL_IDLE_MS = 30_000;
const IMPORT_POOL_QUEUE = 256;
const MAX_PACKAGE_NAME_LENGTH = 214;
const PACKAGE_NAME = /^(?:@[a-z0-9~][\w.~-]*\/)?[a-z0-9~][\w.~-]*$/i;
const BUILTINS: ReadonlySet<string> = new Set(
  builtinModules.map((name) => name.replace(/^node:/, "").split("/")[0] ?? name),
);
const PROBE_SUFFIXES = [
  "", ".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json",
  "/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.mjs", "/index.cjs",
];
// NodeNext sources import "./x.js" for "./x.ts".
const JS_TO_TS: readonly [string, readonly string[]][] = [
  [".js", [".ts", ".tsx"]],
  [".jsx", [".tsx"]],
  [".mjs", [".mts"]],
  [".cjs", [".cts"]],
];

const emptyScan = (): ExtractedImports => ({ specifiers: [], exports: [] });

let inlineBackend: Promise<TreeSitterBackend> | null = null;

/**
 * Parses one file on the calling thread (tests and small inputs). The desktop scan uses
 * `createImportExtractor().extract`, which runs the same parse in worker threads.
 */
export async function extractImports(
  _path: string,
  source: string,
  language: ParserLanguage,
): Promise<ExtractedImports> {
  if (language === "json") return emptyScan();
  inlineBackend ??= createTreeSitterBackend().catch((error: unknown) => {
    inlineBackend = null;
    throw error;
  });
  return (await inlineBackend).imports(source, language);
}

/** A lazily started worker pool for scans (spec §6.1: scans run off the main thread). */
export function createImportExtractor(options: ImportExtractorOptions = {}): ImportExtractor {
  const size = options.size ?? Math.max(1, Math.min(6, availableParallelism() - 2));
  const idleMs = options.idleMs ?? IMPORT_POOL_IDLE_MS;
  let pool: AnalysisPool | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let inflight = 0;
  let disposed = false;

  const stopIdlePool = (): void => {
    idleTimer = null;
    if (inflight > 0 || pool === null) return;
    const idlePool = pool;
    pool = null;
    void idlePool.dispose();
  };

  return {
    async extract(path, source, language) {
      if (disposed) throw new Error("import extractor disposed");
      if (language === "json") return emptyScan();
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      pool ??= new AnalysisPool({ size, workerUrl: options.workerUrl, maxQueueSize: IMPORT_POOL_QUEUE });
      inflight += 1;
      try {
        return await pool.extractImports(path, source);
      } finally {
        inflight -= 1;
        if (inflight === 0 && !disposed) {
          idleTimer = setTimeout(stopIdlePool, idleMs);
          idleTimer.unref();
        }
      }
    },
    async dispose() {
      disposed = true;
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = null;
      const current = pool;
      pool = null;
      if (current !== null) await current.dispose();
    },
  };
}

/** "react-dom/client" → "react-dom"; "@scope/pkg/deep" → "@scope/pkg". */
export function packageNameOf(specifier: string): string | null {
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? (parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null) : (parts[0] ?? null);
  if (name === null || name.length > MAX_PACKAGE_NAME_LENGTH || !PACKAGE_NAME.test(name)) return null;
  return name;
}

function normalize(path: string): string | null {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

function joinBase(base: string | null, rest: string): string | null {
  return normalize(base === null || base === "" || base === "." ? rest : `${base}/${rest}`);
}

function probeFile(candidate: string | null, files: ReadonlySet<string>): string | null {
  if (candidate === null || candidate === "") return null;
  for (const suffix of PROBE_SUFFIXES) {
    if (files.has(`${candidate}${suffix}`)) return `${candidate}${suffix}`;
  }
  for (const [extension, alternatives] of JS_TO_TS) {
    if (!candidate.endsWith(extension)) continue;
    const stem = candidate.slice(0, -extension.length);
    for (const alternative of alternatives) {
      if (files.has(`${stem}${alternative}`)) return `${stem}${alternative}`;
    }
  }
  return null;
}

function resolveTsPath(specifier: string, ctx: ResolveContext): string | null {
  let best: { score: number; targets: readonly string[]; wildcard: string } | null = null;
  for (const [pattern, targets] of Object.entries(ctx.tsPaths)) {
    const star = pattern.indexOf("*");
    if (star === -1) {
      if (pattern === specifier) best = { score: Number.MAX_SAFE_INTEGER, targets, wildcard: "" };
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix) &&
      (best === null || prefix.length > best.score)
    ) {
      best = { score: prefix.length, targets, wildcard: specifier.slice(prefix.length, specifier.length - suffix.length) };
    }
  }
  if (best === null) return null;
  for (const target of best.targets) {
    const hit = probeFile(joinBase(ctx.baseUrl, target.replace("*", best.wildcard)), ctx.files);
    if (hit !== null) return hit;
  }
  return null;
}

const firstFileCache = new WeakMap<ResolveContext, Map<string, string | null>>();

function firstFileUnder(dir: string, ctx: ResolveContext): string | null {
  let cache = firstFileCache.get(ctx);
  if (cache === undefined) {
    cache = new Map();
    firstFileCache.set(ctx, cache);
  }
  if (!cache.has(dir)) {
    let first: string | null = null;
    for (const file of ctx.files) {
      if (file.startsWith(`${dir}/`) && (first === null || file < first)) first = file;
    }
    cache.set(dir, first);
  }
  return cache.get(dir) ?? null;
}

function resolveWorkspace(specifier: string, ctx: ResolveContext): string | null {
  const names = Object.keys(ctx.workspacePackages).sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
    const dir = ctx.workspacePackages[name] as string;
    const sub = specifier === name ? "" : specifier.slice(name.length + 1);
    const candidates = sub === "" ? [`${dir}/src/index`, `${dir}/index`, `${dir}/src/main`, `${dir}/main`] : [`${dir}/${sub}`, `${dir}/src/${sub}`];
    for (const candidate of candidates) {
      const hit = probeFile(normalize(candidate), ctx.files);
      if (hit !== null) return hit;
    }
    // The package lives in the repo even when its entry is built output: any member file
    // places the edge on the right component.
    return firstFileUnder(dir, ctx);
  }
  return null;
}

/**
 * Spec §5.1: relative paths, then tsconfig `paths`, then workspace package names, then
 * `baseUrl`. Node built-ins and non-package specifiers ("virtual:x", "$app/x") are
 * unresolved; other bare specifiers are external under their package name.
 */
export function resolveSpecifier(fromPath: string, specifier: string, ctx: ResolveContext): ResolvedSpecifier {
  const spec = specifier.replace(/[?#].*$/, "");
  if (spec === "" || spec.startsWith("/")) return { kind: "unresolved" };
  if (spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../")) {
    const slash = fromPath.lastIndexOf("/");
    const dir = slash === -1 ? "" : fromPath.slice(0, slash);
    const hit = probeFile(normalize(dir === "" ? spec : `${dir}/${spec}`), ctx.files);
    return hit === null ? { kind: "unresolved" } : { kind: "file", path: hit };
  }
  const viaPaths = resolveTsPath(spec, ctx);
  if (viaPaths !== null) return { kind: "file", path: viaPaths };
  const viaWorkspace = resolveWorkspace(spec, ctx);
  if (viaWorkspace !== null) return { kind: "file", path: viaWorkspace };
  if (ctx.baseUrl !== null) {
    const hit = probeFile(joinBase(ctx.baseUrl, spec), ctx.files);
    if (hit !== null) return { kind: "file", path: hit };
  }
  if (spec.startsWith("node:") || BUILTINS.has(spec.split("/")[0] ?? "")) return { kind: "unresolved" };
  const packageName = packageNameOf(spec);
  return packageName === null ? { kind: "unresolved" } : { kind: "external", packageName };
}
