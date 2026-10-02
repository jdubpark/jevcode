import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assembleSnapshot, buildManifest, languageOf, type ScannedFile } from "@jevcode/codebase-map";
import { scanRepo, type ScanOptions, type scanPaths } from "@jevcode/codebase-map/node";
import { createImportExtractor, type ExtractedImports, type extractImports } from "@jevcode/evidence-engine";
import { openDb } from "@jevcode/storage";
import { afterAll, bench, describe } from "vitest";

import { buildOverview, scanRepoModel } from "./explainer-overview.js";
import { createExplainerStage, type ExplainerStage } from "./explainer-stage.js";

// Spec §11 on the reference machine: a full scan of 20,000 files takes <= 20 s, and the
// rule-based map of a 5,000-file repo is ready <= 2 s after repo open. Each iteration starts a
// new worker pool, so worker start-up and grammar loading are inside the timing. Read the
// "mean" column (ms). Not part of `vitest run`.
//
// Spec §6.1 (the stage never blocks ingestion): the "stage" rows drive a real explainer stage over
// an in-memory 20,000-file model (11 import specifiers per file; scan and scanPaths are fakes that
// yield like I/O) and measure the longest synchronous block of the main thread with a setImmediate
// heartbeat. The table printed after the run lists the max block per row; target <= 50 ms.

const pad = (value: number, width: number): string => String(value).padStart(width, "0");

/** `files / 1000` workspace packages of 10 modules x 100 files, each file ~1 KB of real imports. */
function makeSyntheticRepo(fileCount: number): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "jevcode-map-bench-"));
  const packages = Math.max(1, Math.round(fileCount / 1_000));
  const write = (rel: string, text: string): void => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  write("package.json", '{"name":"bench-root","private":true}');
  for (let pkg = 0; pkg < packages; pkg += 1) {
    const dir = `packages/pkg-${pad(pkg, 2)}`;
    write(`${dir}/package.json`, `{"name":"@bench/pkg-${pad(pkg, 2)}","main":"src/index.ts"}`);
    write(`${dir}/src/index.ts`, 'export const entry = { name: "entry" };\n');
    for (let mod = 0; mod < 10; mod += 1) {
      for (let index = 0; index < 100; index += 1) {
        const next = (index + 1) % 100;
        const lines = [
          'import { z } from "zod";',
          `import { helper${next} } from "./file-${pad(next, 3)}.js";`,
          `import { entry } from "@bench/pkg-${pad((pkg + 1) % packages, 2)}";`,
          "",
          `export const helper${index} = { name: "p${pkg}m${mod}f${index}" };`,
        ];
        for (let k = 0; k < 8; k += 1) {
          lines.push(
            `export function run${index}_${k}(input: string): string {`,
            `  const schema = z.string().min(${k});`,
            `  return schema.parse(input) + helper${next}.name + entry.name;`,
            "}",
          );
        }
        write(`${dir}/src/mod-${pad(mod, 2)}/file-${pad(index, 3)}.ts`, `${lines.join("\n")}\n`);
      }
    }
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

const repos = new Map<number, string>();
/** Written on first use, so filtering to the stage rows skips 25,000 file writes. */
function syntheticRepo(fileCount: number): string {
  let root = repos.get(fileCount);
  if (root === undefined) {
    root = makeSyntheticRepo(fileCount);
    repos.set(fileCount, root);
  }
  return root;
}

afterAll(() => {
  for (const root of repos.values()) rmSync(root, { recursive: true, force: true });
});

async function mapRepo(repoRoot: string): Promise<void> {
  const extractor = createImportExtractor();
  try {
    const model = await scanRepoModel(repoRoot, { scan: scanRepo, extract: extractor.extract });
    const built = buildOverview(model);
    assembleSnapshot({
      sessionId: "bench",
      repoRoot,
      scanId: "bench",
      partial: model.partial,
      drafts: built.drafts,
      edges: built.edges,
      totalEdges: built.totalEdges,
      externals: built.externals,
      text: new Map(),
      narrative: null,
      generatedAt: "2026-10-02T00:00:00.000Z",
    });
  } finally {
    await extractor.dispose();
  }
}

/** The longest gap between setImmediate heartbeats: the longest synchronous block meanwhile. */
function startBlockMeter(): () => number {
  let last = performance.now();
  let max = 0;
  let running = true;
  const beat = (): void => {
    const now = performance.now();
    max = Math.max(max, now - last);
    last = now;
    if (running) setImmediate(beat);
  };
  setImmediate(beat);
  return () => {
    running = false;
    return max;
  };
}

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const maxBlocks = new Map<string, number[]>();
function recordBlock(row: string, ms: number): void {
  maxBlocks.set(row, [...(maxBlocks.get(row) ?? []), ms]);
}

/**
 * The reviewer's rebuild probe as a stage: `files / 1000` workspace packages of 10 modules x 100
 * files; each file imports zod, a sibling, the next package, five deep externals, node:fs, react
 * and its package entry. scan and scanPaths are in-memory fakes that yield every 500 files.
 */
function stageBench(fileCount: number): {
  stage: ExplainerStage;
  current: Map<string, ScannedFile>;
  specs: Map<string, ExtractedImports>;
  settle(): Promise<void>;
  close(): void;
} {
  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  const texts = new Map<string, string>([
    ["pnpm-workspace.yaml", "packages:\n  - packages/*\n"],
    ["package.json", '{"name":"bench-root"}'],
  ]);
  const current = new Map<string, ScannedFile>();
  const specs = new Map<string, ExtractedImports>();
  const add = (rel: string): void => {
    current.set(rel, { path: rel, hash: createHash("sha1").update(rel).digest("hex"), size: 1_000, language: languageOf(rel) });
  };
  add("pnpm-workspace.yaml");
  add("package.json");
  const packages = Math.max(1, Math.round(fileCount / 1_000));
  for (let pkg = 0; pkg < packages; pkg += 1) {
    const dir = `packages/pkg-${pad(pkg, 2)}`;
    texts.set(`${dir}/package.json`, `{"name":"@bench/pkg-${pad(pkg, 2)}","main":"src/index.ts"}`);
    add(`${dir}/package.json`);
    add(`${dir}/src/index.ts`);
    for (let mod = 0; mod < 10; mod += 1) {
      for (let index = 0; index < 100; index += 1) {
        const rel = `${dir}/src/mod-${pad(mod, 2)}/file-${pad(index, 3)}.ts`;
        add(rel);
        const specifiers = ["zod", `./file-${pad((index + 1) % 100, 3)}.js`, `@bench/pkg-${pad((pkg + 1) % packages, 2)}`];
        for (let k = 0; k < 5; k += 1) specifiers.push(`ext-${(index * 7 + k) % 300}/deep/x`);
        specifiers.push("node:fs", "react", "../../index.js");
        specs.set(rel, { specifiers, exports: Array.from({ length: 9 }, (_, k) => `run${index}_${k}`) });
      }
    }
  }
  const manifest = buildManifest([...current.keys()], texts);
  const dbDir = mkdtempSync(path.join(os.tmpdir(), "jevcode-stage-bench-"));
  const db = openDb({ dbPath: path.join(dbDir, "bench.db") });
  db.upsertRepository({ id: "repo_bench", path: "/bench", gitRoot: "/bench" });
  db.createSession({ id: "sess_bench", repoId: "repo_bench" });
  const timers = new Set<() => void>();
  const scan = async (_root: string, options: ScanOptions = {}) => {
    let count = 0;
    for (const file of current.values()) {
      await options.visit?.(file, "");
      if ((count += 1) % 500 === 0) await turn();
    }
    const files = [...current.values()];
    return { files, manifest, partial: false, tsconfig: { paths: {}, baseUrl: null }, totalFiles: files.length };
  };
  const scanPathsFake: typeof scanPaths = async (_root, paths, options = {}) => {
    await turn();
    const files: ScannedFile[] = [];
    const gone: string[] = [];
    for (const rel of paths) {
      const file = current.get(rel);
      if (file === undefined) gone.push(rel);
      else {
        files.push(file);
        await options.visit?.(file, "");
      }
    }
    return { files, gone };
  };
  const extract: typeof extractImports = async (rel) => specs.get(rel) ?? { specifiers: [], exports: [] };
  const stage = createExplainerStage({
    db,
    repoRoot: "/bench",
    sessionId: () => "sess_bench",
    scan,
    scanPaths: scanPathsFake,
    extract,
    emitRowsAvailable: () => {},
    now: () => Date.now(),
    // Settle and row-write timers fire when the bench says, each in a turn of its own.
    schedule: {
      setTimeout: (fn) => {
        timers.add(fn);
        return fn;
      },
      clearTimeout: (handle) => void timers.delete(handle as () => void),
    },
    log: () => {},
    explainWithModel: () => false,
  });
  return {
    stage,
    current,
    specs,
    async settle() {
      for (let round = 0; round < 4 && timers.size > 0; round += 1) {
        for (const fn of [...timers]) {
          timers.delete(fn);
          await turn();
          fn();
        }
        await stage.whenIdle();
      }
    },
    close() {
      stage.dispose();
      db.close();
      rmSync(dbDir, { recursive: true, force: true });
    },
  };
}

const STAGE = stageBench(20_000);
STAGE.stage.onRepoOpened();
await STAGE.stage.whenIdle();
await STAGE.settle();
afterAll(() => {
  STAGE.close();
  console.log("\nmax synchronous block per iteration (ms), target <= 50:");
  for (const [row, samples] of maxBlocks) {
    const sorted = [...samples].sort((a, b) => a - b);
    console.log(`  ${row}: max ${sorted.at(-1)?.toFixed(1)}, median ${sorted[Math.floor(sorted.length / 2)]?.toFixed(1)}, n=${sorted.length}`);
  }
});

let edits = 0;
let added = 0;
/** One watcher change through the stage: settle, rebuild, snapshot row; returns the max block. */
async function stageChange(row: string, change: () => string): Promise<void> {
  const rel = change();
  const stop = startBlockMeter();
  STAGE.stage.onFilesChanged([rel]);
  await STAGE.settle();
  recordBlock(row, stop());
}

describe("explainer stage on 20,000 files (spec §6.1, max synchronous block)", () => {
  const options = { iterations: 15, warmupIterations: 2, time: 0, warmupTime: 0 };
  bench(
    "stage: single-file edit, 20,000 files",
    () =>
      stageChange("single-file edit", () => {
        const rel = `packages/pkg-03/src/mod-04/file-${String(edits % 100).padStart(3, "0")}.ts`;
        const file = STAGE.current.get(rel) as ScannedFile;
        STAGE.current.set(rel, { ...file, hash: createHash("sha1").update(`${rel}:${(edits += 1)}`).digest("hex") });
        return rel;
      }),
    options,
  );
  bench(
    "stage: add a file, 20,000 files",
    () =>
      stageChange("add a file", () => {
        const rel = `packages/pkg-05/src/mod-02/new-${(added += 1)}.ts`;
        STAGE.current.set(rel, { path: rel, hash: createHash("sha1").update(rel).digest("hex"), size: 1_000, language: "TypeScript" });
        STAGE.specs.set(rel, { specifiers: ["zod", "./file-000.js", "@bench/pkg-06", "react"], exports: ["added"] });
        return rel;
      }),
    options,
  );
  bench(
    "stage: remove a file, 20,000 files",
    () =>
      stageChange("remove a file", () => {
        const rel = [...STAGE.current.keys()].find((key) => key.startsWith("packages/pkg-07/src/mod-06/file-")) as string;
        STAGE.current.delete(rel);
        return rel;
      }),
    options,
  );
  bench(
    "stage: full rebuild (rescan of an unchanged repo), 20,000 files",
    async () => {
      const stop = startBlockMeter();
      STAGE.stage.rescan();
      await STAGE.stage.whenIdle();
      await STAGE.settle();
      recordBlock("full rebuild (rescan)", stop());
    },
    { iterations: 5, warmupIterations: 1, time: 0, warmupTime: 0 },
  );
});

describe("codebase map (spec §11)", () => {
  bench("rule-based map, 5,000 files (budget 2,000 ms)", () => mapRepo(syntheticRepo(5_000)), {
    iterations: 5,
    warmupIterations: 1,
    time: 0,
    warmupTime: 0,
  });
  bench("full scan and map, 20,000 files (budget 20,000 ms)", () => mapRepo(syntheticRepo(20_000)), {
    iterations: 3,
    warmupIterations: 0,
    time: 0,
    warmupTime: 0,
  });
});
