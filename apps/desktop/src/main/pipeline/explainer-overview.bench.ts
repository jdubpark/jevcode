import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assembleSnapshot } from "@jevcode/codebase-map";
import { scanRepo } from "@jevcode/codebase-map/node";
import { createImportExtractor } from "@jevcode/evidence-engine";
import { afterAll, bench, describe } from "vitest";

import { buildOverview, scanRepoModel } from "./explainer-overview.js";

// Spec §11 on the reference machine: a full scan of 20,000 files takes <= 20 s, and the
// rule-based map of a 5,000-file repo is ready <= 2 s after repo open. Each iteration starts a
// new worker pool, so worker start-up and grammar loading are inside the timing. Read the
// "mean" column (ms). Not part of `vitest run`.

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

const REPO_5K = makeSyntheticRepo(5_000);
const REPO_20K = makeSyntheticRepo(20_000);

afterAll(() => {
  rmSync(REPO_5K, { recursive: true, force: true });
  rmSync(REPO_20K, { recursive: true, force: true });
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
      externals: built.externals,
      text: new Map(),
      narrative: null,
      generatedAt: "2026-10-02T00:00:00.000Z",
    });
  } finally {
    await extractor.dispose();
  }
}

describe("codebase map (spec §11)", () => {
  bench("rule-based map, 5,000 files (budget 2,000 ms)", () => mapRepo(REPO_5K), {
    iterations: 5,
    warmupIterations: 1,
    time: 0,
    warmupTime: 0,
  });
  bench("full scan and map, 20,000 files (budget 20,000 ms)", () => mapRepo(REPO_20K), {
    iterations: 3,
    warmupIterations: 0,
    time: 0,
    warmupTime: 0,
  });
});
