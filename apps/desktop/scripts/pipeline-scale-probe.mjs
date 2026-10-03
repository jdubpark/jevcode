// Pipeline write-volume probe (docs/perf.md, "Pipeline write volume").
//
// Feeds a synthetic agent session through the real PipelineCoordinator with the
// desktop's storage-backed stores on a temporary SQLite file, then counts the
// session's event rows. Every step is a git_hunk on the next of N files (round
// robin); every k-th step adds a command_executed and a test_result 300 and 450 ms
// later. All facts are 0.9 or 2 s apart, so the whole session is one idle bucket.
// No network. Needs the built packages and desktop main:
//
//   pnpm --filter @jevcode/semantic-core --filter @jevcode/storage build
//   pnpm --filter jevcode-desktop exec tsc -p tsconfig.build.json
//   node apps/desktop/scripts/pipeline-scale-probe.mjs [scale|smoke] [--commands per-file|single] [--fail-every N]
//
// --commands per-file (default) runs `pnpm test -- module-<n>` for the file just
// edited; single runs `pnpm test` every time. --fail-every N makes every N-th run
// fail on the edited file's test (0, the default, never fails).
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { PipelineCoordinator } from "@jevcode/semantic-core";
import { openDb } from "@jevcode/storage";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const storesEntry = path.join(dirname, "../dist/main/pipeline/storage-stores.js");

const SHAPES = {
  smoke: { files: 80, hunks: 80, testEvery: 1, stepMs: 900 },
  scale: { files: 200, hunks: 1000, testEvery: 5, stepMs: 2000 },
};

function parseArgs(argv) {
  const options = { shape: "scale", commands: "per-file", failEvery: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--commands") options.commands = argv[++index];
    else if (arg === "--fail-every") options.failEvery = Number(argv[++index]);
    else options.shape = arg;
  }
  if (!(options.shape in SHAPES)) throw new Error(`unknown shape ${options.shape} (smoke | scale)`);
  if (options.commands !== "per-file" && options.commands !== "single") {
    throw new Error(`unknown --commands ${options.commands} (per-file | single)`);
  }
  if (!Number.isInteger(options.failEvery) || options.failEvery < 0) {
    throw new Error("--fail-every takes a whole number");
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const shape = SHAPES[options.shape];
  let createStorageStores;
  try {
    ({ createStorageStores } = await import(storesEntry));
  } catch (error) {
    console.error(`storage stores not found at ${storesEntry}. Build desktop main first (see the header).`);
    console.error(String(error));
    process.exit(1);
  }

  const dir = mkdtempSync(path.join(os.tmpdir(), "jevcode-scale-probe-"));
  const wallStart = performance.now();
  try {
    const db = openDb({ dbPath: path.join(dir, "probe.db") });
    const repoId = "repo_probe";
    const sessionId = "sess_probe";
    db.upsertRepository({ id: repoId, path: "/work/probe", gitRoot: "/work/probe" });
    db.createSession({ id: sessionId, repoId });
    const stores = createStorageStores(db, sessionId);
    let now = Date.parse("2026-10-03T00:00:00.000Z");
    const coordinator = new PipelineCoordinator({ stores, clock: () => now });
    const iso = (ms) => new Date(ms).toISOString();
    const ingestMs = [];
    const ingest = (record) => {
      now = Date.parse(record.ts);
      const started = performance.now();
      coordinator.ingest(record);
      ingestMs.push(performance.now() - started);
    };

    const base = now;
    let runs = 0;
    for (let step = 0; step < shape.hunks; step += 1) {
      const t = base + step * shape.stepMs;
      const module = (step % shape.files) + 1;
      ingest({
        type: "git_hunk", repoId, sessionId, ts: iso(t), file: `src/module-${module}.ts`,
        added: 4 + step, removed: 1, isFormattingOnly: false, isConfigOnly: false, isLockfile: false,
      });
      if ((step + 1) % shape.testEvery !== 0) continue;
      runs += 1;
      const command = options.commands === "single" ? "pnpm test" : `pnpm test -- module-${module}`;
      const failed = options.failEvery > 0 && runs % options.failEvery === 0;
      ingest({
        type: "command_executed", repoId, sessionId, ts: iso(t + 300), command,
        exitCode: failed ? 1 : 0, isDestructive: false, durationMs: 100,
      });
      ingest({
        type: "test_result", repoId, sessionId, ts: iso(t + 450), runner: "vitest", command,
        passed: 3, failed: failed ? 1 : 0, skipped: 0, sourceCallId: `call_${step}`,
        failures: failed
          ? [{ file: `src/module-${module}.test.ts`, testName: `module ${module} works`, message: "boom" }]
          : [],
      });
    }
    now += 10_000;
    coordinator.flush();

    const byType = new Map();
    for (let fromSeq = 0; ; ) {
      const page = db.listEvents(sessionId, { fromSeq, limit: 5000 });
      if (page.length === 0) break;
      for (const event of page) {
        const entry = byType.get(event.type) ?? { rows: 0, bytes: 0 };
        entry.rows += 1;
        entry.bytes += event.payloadJson.length;
        byType.set(event.type, entry);
      }
      fromSeq = page[page.length - 1].seq;
    }
    const traced = ["change_unit", "validation", "failure", "decision"];
    let tracedRows = 0;
    let tracedBytes = 0;
    for (const type of traced) {
      tracedRows += byType.get(type)?.rows ?? 0;
      tracedBytes += byType.get(type)?.bytes ?? 0;
    }
    const units = db.listChangeUnits(sessionId);
    const links = units.map((unit) => unit.validationResults.length);
    const late = ingestMs.slice(Math.floor(ingestMs.length * 0.9)).sort((a, b) => a - b);
    const result = {
      shape: options.shape,
      commands: options.commands,
      failEvery: options.failEvery,
      runs,
      units: units.length,
      tracedRows,
      tracedMB: Number((tracedBytes / 1e6).toFixed(1)),
      rowsByType: Object.fromEntries([...byType].map(([type, entry]) => [type, entry.rows])),
      validationLinks: links.reduce((sum, count) => sum + count, 0),
      maxLinksPerUnit: Math.max(0, ...links),
      lateIngestMs: {
        p50: Number(late[Math.floor(late.length * 0.5)].toFixed(1)),
        max: Number(late[late.length - 1].toFixed(1)),
      },
      wallS: Number(((performance.now() - wallStart) / 1000).toFixed(1)),
    };
    db.close();
    console.log(JSON.stringify(result));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
