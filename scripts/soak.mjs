import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openDb, openTraceReader } from "../packages/storage/dist/index.js";
import {
  EvidenceFactSchema,
  NormalizedAgentEventSchema,
  DecisionSchema,
  TRACE_ROWS_PAGE_DEFAULT,
} from "../packages/contracts/dist/index.js";
import { DegradeClient } from "../packages/jev-router/dist/index.js";
import { parseReplayLine } from "../packages/semantic-core/dist/index.js";
import { SurfaceManager } from "../packages/ui-catalog/dist/surface/SurfaceManager.js";
import { compileSkeleton } from "../packages/ui-compiler/dist/index.js";
import { PipelineRuntime } from "../apps/desktop/dist/main/pipeline/pipeline-runtime.js";
import { buildTraceBundle, writeTraceBundle } from "../apps/desktop/dist/main/trace-bundle.js";
import { createTraceService, readAllRows } from "../apps/desktop/dist/main/trace-service.js";
import { createExplainerStage } from "../apps/desktop/dist/main/pipeline/explainer-stage.js";
import { scanPaths, scanRepo } from "../packages/codebase-map/dist/node/index.js";
import { createImportExtractor } from "../packages/evidence-engine/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = path.join(root, "fixtures", "oauth");

const TARGET_EVENTS = Number(process.env["JEVCODE_SOAK_EVENTS"] ?? 10_000);
// JEVCODE_SOAK_PROFILE=trace is the trace viewer's reference input (spec §5.6,
// §10): agent rows with realistic payload sizes, callId pairs, agent
// file_changed claims and steers. "default" keeps the 2026-09-19 stream.
const PROFILE = process.env["JEVCODE_SOAK_PROFILE"] || "default";
if (PROFILE !== "default" && PROFILE !== "trace") {
  console.error(`SOAK_FAIL: unknown JEVCODE_SOAK_PROFILE ${PROFILE} (expected default or trace)`);
  process.exit(1);
}
const TRACE_STDOUT_KIB = [0.2, 2, 8, 32, 64];
const TRACE_TEXT_MIN = Math.round(0.2 * 1024);
const TRACE_TEXT_MAX = 4 * 1024;
const TRACE_STEER_EVERY = 500;
// Trace viewer budgets (spec §10, R26). A single-run budget reports the median
// of 5 runs after 1 discarded warm-up; a p95 budget uses at least 300 samples.
const TRACE_READ_BUDGET_MS = 1_500;
const TRACE_PAGE_BUDGET_MS = 50;
const TRACE_READ_RUNS = 5;
const TRACE_PAGE_SAMPLES = 300;
const SESSION_ID = "sess-soak-0001";
const REPO_ID = "repo-soak";
// Console-explainer M-8 (spec §11 ingest guard). JEVCODE_SOAK_EXPLAINER=1 runs the explainer
// stage beside the pipeline on a generated repo (narrator off) and forwards file_changed facts
// to it. JEVCODE_SOAK_YIELD_EVERY=N yields to the event loop every N records, so a background
// scan competes with ingestion; unset, the ingest loop is unchanged.
const EXPLAINER = process.env["JEVCODE_SOAK_EXPLAINER"] === "1";
const EXPLAINER_FILES = Number(process.env["JEVCODE_SOAK_EXPLAINER_FILES"] ?? 5_000);
const YIELD_EVERY = Number(process.env["JEVCODE_SOAK_YIELD_EVERY"] ?? 0);

/** `fileCount` small TS files in modules of 100 under src/, in a fresh `git init` directory. */
function makeExplainerRepo(fileCount) {
  const root = mkdtempSync(path.join(tmpdir(), "jevcode-soak-map-"));
  for (let index = 0; index < fileCount; index += 1) {
    const dir = path.join(root, "src", `mod-${String(Math.floor(index / 100)).padStart(3, "0")}`);
    mkdirSync(dir, { recursive: true });
    const next = String((index + 1) % 100).padStart(3, "0");
    writeFileSync(
      path.join(dir, `file-${String(index % 100).padStart(3, "0")}.ts`),
      `import { z } from "zod";\nimport { value } from "./file-${next}.js";\nexport const v${index} = z.string().parse(value);\n`,
    );
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function nowIso(offsetMs) {
  return new Date(Date.UTC(2026, 8, 19, 9, 0, 0) + offsetMs).toISOString();
}

/** mulberry32: a seeded PRNG, so every trace-profile run generates the same records. */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** ASCII text of exactly `length` characters, built from numbered copies of `line`. */
function fillerText(length, line) {
  const parts = [];
  let size = 0;
  for (let i = 1; size < length; i += 1) {
    const next = `${line} ${i}\n`;
    parts.push(next);
    size += next.length;
  }
  return parts.join("").slice(0, length);
}

function assert(condition, message) {
  if (!condition) {
    console.error(`SOAK_FAIL: ${message}`);
    process.exit(1);
  }
}

function buildStream() {
  const records = [];
  let t = 0;
  const push = (record) => {
    if (EvidenceFactSchema.safeParse(record).success) {
      records.push(record);
      return;
    }
    if (NormalizedAgentEventSchema.safeParse(record).success) {
      records.push(record);
      return;
    }
    if (DecisionSchema.safeParse(record).success) {
      records.push(record);
      return;
    }
    throw new Error("generated record matches no schema");
  };

  push({
    type: "agent_started",
    sessionId: SESSION_ID,
    prompt: "Soak task: touch everything.",
    ts: nowIso((t += 500)),
  });
  push({
    type: "agent_message",
    sessionId: SESSION_ID,
    role: "assistant",
    text: "Starting the soak task.",
    ts: nowIso((t += 500)),
  });

  let feature = 0;
  let noise = 0;
  let burst = 0;
  // Trace-profile state. Soak agent events carry no turnId, like a pre-M1a
  // recording, so the fold reads each relaunch below as a steer (spec §6.6
  // "Turns"); callIds keep the `${turnId}:${item.id}` shape.
  const traceProfile = PROFILE === "trace";
  const random = seededRandom(0x50a4);
  let turn = 1;
  let item = 0;
  let nextSteerAt = TRACE_STEER_EVERY;
  const nextCallId = () => `soak-turn-${turn}:item_${(item += 1)}`;
  while (records.length < TARGET_EVENTS - 40) {
    for (let i = 0; i < 20; i += 1) {
      noise += 1;
      const noiseFile = `src/noise/format-${noise}.ts`;
      push({
        type: "git_hunk",
        repoId: REPO_ID,
        sessionId: SESSION_ID,
        file: noiseFile,
        added: 1,
        removed: 1,
        isFormattingOnly: true,
        isConfigOnly: false,
        isLockfile: false,
        ts: nowIso(t + i * 10),
      });
      push({
        type: "file_changed",
        repoId: REPO_ID,
        sessionId: SESSION_ID,
        path: noiseFile,
        kind: "modified",
        ts: nowIso(t + i * 10 + 5),
      });
    }
    t += 6000;
    burst += 1;

    if (burst % 4 === 0) {
      feature += 1;
      const file = `src/feature-${feature}.ts`;
      if (traceProfile) {
        // The agent's claim; the git_hunk, symbol_delta and file_changed
        // facts below are the repo's observation of the same edit.
        push({
          type: "file_changed",
          sessionId: SESSION_ID,
          callId: nextCallId(),
          path: file,
          ts: nowIso((t += 100)),
        });
      }
      push({
        type: "git_hunk",
        repoId: REPO_ID,
        sessionId: SESSION_ID,
        file,
        added: 24,
        removed: 3,
        isFormattingOnly: false,
        isConfigOnly: false,
        isLockfile: false,
        ts: nowIso((t += 100)),
      });
      push({
        type: "symbol_delta",
        repoId: REPO_ID,
        sessionId: SESSION_ID,
        path: file,
        added: [
          {
            name: `runFeature${feature}`,
            kind: "function",
            signature: `export function runFeature${feature}()`,
            startLine: 1,
            endLine: 5,
          },
        ],
        removed: [],
        modified: [],
        ts: nowIso((t += 100)),
      });
      push({
        type: "file_changed",
        repoId: REPO_ID,
        sessionId: SESSION_ID,
        path: file,
        kind: "modified",
        ts: nowIso((t += 100)),
      });
    }

    if (burst % 8 === 0) {
      // Trace profile: one callId pairs the start and the completion, the
      // test_result cites it as sourceCallId (R2), and stdout is 0.2-64 KiB.
      const callId = traceProfile ? nextCallId() : undefined;
      const call = callId === undefined ? {} : { callId };
      push({
        type: "command_started",
        sessionId: SESSION_ID,
        ...call,
        command: `pnpm test ${burst}`,
        ts: nowIso((t += 100)),
      });
      push({
        type: "test_result",
        repoId: REPO_ID,
        sessionId: SESSION_ID,
        ...(callId === undefined ? {} : { sourceCallId: callId }),
        runner: "vitest",
        command: `pnpm test ${burst}`,
        passed: 42,
        failed: 0,
        skipped: 0,
        failures: [],
        ts: nowIso((t += 100)),
      });
      const stdoutKib = traceProfile
        ? TRACE_STDOUT_KIB[Math.floor(random() * TRACE_STDOUT_KIB.length)]
        : 0;
      push({
        type: "command_completed",
        sessionId: SESSION_ID,
        ...call,
        command: `pnpm test ${burst}`,
        exitCode: 0,
        stdout: fillerText(Math.round(stdoutKib * 1024), `PASS src/feature-${feature}.test.ts > case`),
        stderr: "",
        ts: nowIso((t += 100)),
      });
    }

    if (burst % 20 === 0) {
      push({
        id: `dec-soak-${burst}`,
        sessionId: SESSION_ID,
        title: `Soak decision ${burst}`,
        context: "Which policy should the generated code use?",
        severity: "recommended",
        options: [
          { id: "a", label: "Option A", description: "First option." },
          { id: "b", label: "Option B", description: "Second option." },
        ],
        affectedChangeUnits: [],
        evidence: [],
        status: "open",
      });
    }

    if (burst % 10 === 0) {
      const note = `Progress note ${burst}.`;
      push({
        type: "agent_message",
        sessionId: SESSION_ID,
        role: "assistant",
        text: traceProfile
          ? fillerText(TRACE_TEXT_MIN + Math.floor(random() * (TRACE_TEXT_MAX - TRACE_TEXT_MIN + 1)), note)
          : note,
        ts: nowIso((t += 100)),
      });
    }

    if (traceProfile && records.length >= nextSteerAt) {
      // A steer relaunches the agent: the relaunch's agent_started carries the
      // steer as its prompt, then the supervisor's message repeats it (spec
      // §6.6 "Instruction dedupe").
      nextSteerAt += TRACE_STEER_EVERY;
      const steer = `Steer ${turn}: keep feature files small and rerun the tests.`;
      turn += 1;
      push({ type: "agent_started", sessionId: SESSION_ID, prompt: steer, ts: nowIso((t += 100)) });
      push({
        type: "agent_message",
        sessionId: SESSION_ID,
        role: "user",
        text: steer,
        ts: nowIso((t += 100)),
      });
    }
  }

  push({
    type: "git_hunk",
    repoId: REPO_ID,
    sessionId: SESSION_ID,
    file: "tests/soak.test.ts",
    added: 8,
    removed: 0,
    isFormattingOnly: false,
    isConfigOnly: false,
    isLockfile: false,
    ts: nowIso((t += 2000)),
  });
  push({
    type: "file_changed",
    repoId: REPO_ID,
    sessionId: SESSION_ID,
    path: "tests/soak.test.ts",
    kind: "modified",
    ts: nowIso((t += 2000)),
  });
  push({
    type: "test_result",
    repoId: REPO_ID,
    sessionId: SESSION_ID,
    runner: "vitest",
    command: "pnpm test soak",
    passed: 41,
    failed: 1,
    skipped: 0,
    failures: [
      {
        file: "tests/soak.test.ts",
        testName: "soak regression guard",
        message: "expected false to be true",
      },
    ],
    ts: nowIso((t += 2000)),
  });
  push({
    type: "agent_message",
    sessionId: SESSION_ID,
    role: "assistant",
    text: "Soak task complete; all checks pass.",
    ts: nowIso((t += 2000)),
  });
  push({
    type: "agent_completed",
    sessionId: SESSION_ID,
    ts: nowIso((t += 2000)),
  });

  return records;
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

async function main() {
  const outDir = mkdtempSync(path.join(tmpdir(), "jevcode-soak-"));
  const db = openDb({ dbPath: path.join(outDir, "soak.db") });
  db.upsertRepository({
    id: REPO_ID,
    path: fixtureDir,
    gitRoot: fixtureDir,
    name: "soak",
    branch: "soak",
    baseCommit: "soak",
  });
  db.createSession({
    id: SESSION_ID,
    repoId: REPO_ID,
    prompt: "Soak task: touch everything.",
  });

  const persistLatencies = [];
  const originalAppend = db.appendEvidenceFact.bind(db);
  db.appendEvidenceFact = (sessionId, fact) => {
    const started = Date.now();
    const result = originalAppend(sessionId, fact);
    persistLatencies.push(Date.now() - started);
    return result;
  };

  const specs = [];
  const patches = [];
  const clockStart = Date.now();
  let clockMs = clockStart;
  const manager = new SurfaceManager({
    minLifetimeMs: 8000,
    interactionLockMs: 2000,
    lowImportanceThreshold: 0.5,
    now: () => clockMs,
  });

  let pointerInside = false;
  let lockViolations = 0;
  let pinnedProtected = true;

  const setLock = (inside) => {
    pointerInside = inside;
    if (inside) {
      manager.notifyInteraction();
    }
    manager.setPointerInside(inside);
  };

  const proposeSpec = (surfaceId, spec) => {
    const before = new Set(manager.getGenerative().map((s) => s.id));
    const presentBefore = before.has(surfaceId);
    const result = manager.propose({
      id: surfaceId,
      spec,
      importance: 0.6,
    });
    if (pointerInside && !presentBefore) {
      if (result.status === "applied") {
        const after = new Set(manager.getGenerative().map((s) => s.id));
        const evicted = [...before].filter((id) => !after.has(id));
        if (evicted.length > 0) {
          lockViolations += 1;
        }
      }
      if (result.status === "deferred" && result.pendingAt === null) {
        const primary = manager.getPrimary();
        if (primary !== null && primary.pinned) {
          pinnedProtected = true;
        }
      }
    }
    return result;
  };

  let explainer = null;
  let extractor = null;
  let explainerRepo = null;
  let explainerRows = 0;
  if (EXPLAINER) {
    explainerRepo = makeExplainerRepo(EXPLAINER_FILES);
    extractor = createImportExtractor();
  }

  const runtime = new PipelineRuntime({
    db,
    emit: (channel, payload) => {
      if (channel === "ui:spec") {
        const entry = payload;
        specs.push(entry.spec);
        if (specs.length % 2 === 1) {
          setLock(true);
        } else {
          setLock(false);
        }
        clockMs += 9000;
        proposeSpec(entry.surfaceId, entry.spec);
      }
      if (channel === "ui:specPatch") {
        patches.push(payload);
        manager.applyPatch(payload.surfaceId, payload.patch);
      }
    },
    agentMode: "replay",
    jevClient: new DegradeClient(),
    evidence: false,
    log: () => {},
    onRepoFilesChanged: EXPLAINER ? (_repoPath, paths) => explainer?.onFilesChanged(paths) : undefined,
  });

  await runtime.startSession({
    sessionId: SESSION_ID,
    repoId: REPO_ID,
    repoPath: fixtureDir,
    prompt: "Soak task: touch everything.",
    agentMode: "replay",
  });

  if (EXPLAINER) {
    explainer = createExplainerStage({
      db,
      repoRoot: explainerRepo,
      sessionId: () => SESSION_ID,
      scan: scanRepo,
      scanPaths,
      extract: extractor.extract,
      emitRowsAvailable: () => {
        explainerRows += 1;
      },
      now: () => Date.now(),
      schedule: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (handle) => clearTimeout(handle) },
      log: () => {},
      explainWithModel: () => false,
    });
    explainer.onRepoOpened();
    explainer.onSessionStarted(SESSION_ID);
  }

  const records = buildStream();
  console.log(`soak: ${records.length} generated records`);

  const ingestStarted = Date.now();
  let burstIndex = 0;
  for (const record of records) {
    if (YIELD_EVERY > 0 && burstIndex > 0 && burstIndex % YIELD_EVERY === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (burstIndex % 400 === 0) {
      setLock(true);
    }
    if (burstIndex % 400 === 200) {
      setLock(false);
    }
    burstIndex += 1;
    clockMs += 20;
    runtime.ingestPipelineRecord(SESSION_ID, record);
  }
  setLock(false);
  const ingestMs = Date.now() - ingestStarted;

  const syncStarted = Date.now();
  await runtime.syncAll();
  const syncMs = Date.now() - syncStarted;
  if (explainer !== null) {
    await explainer.whenIdle();
    explainer.dispose();
    await extractor.dispose();
    rmSync(explainerRepo, { recursive: true, force: true });
  }

  const generativeCount = manager.getGenerative().length;
  assert(generativeCount <= 1, `generative surfaces ${generativeCount} > 1`);

  const primary = manager.getPrimary();
  if (primary !== null) {
    manager.pin(primary.id);
    manager.propose({
      id: "soak-pinned-probe",
      spec: { root: "root", elements: { root: { type: "Terminal", props: { title: "probe" } } } },
      importance: 0.9,
    });
    const stillPresent = manager
      .getGenerative()
      .some((surface) => surface.id === primary.id);
    if (!stillPresent) {
      pinnedProtected = false;
    }
  }

  assert(lockViolations === 0, `surface swaps under interaction lock: ${lockViolations}`);
  assert(pinnedProtected, "pinned surface was replaced");

  const totalMs = Date.now() - clockStart;

  const eventCount = db.getEventCount(SESSION_ID);
  assert(
    eventCount >= records.length,
    `event store size ${eventCount} < ingested ${records.length}`,
  );
  assert(
    eventCount <= 1_000_000,
    "event store exceeded the 1M growth cap",
  );
  const amplification = eventCount / records.length;

  const surfaces = runtime.snapshotSurfaces(SESSION_ID);
  const completion = surfaces.find(
    (surface) => surface.surfaceId === "completion",
  );
  assert(completion !== undefined, "no completion surface after agent_completed");

  const skeletonStarted = Date.now();
  for (let i = 0; i < 1000; i += 1) {
    compileSkeleton({ title: `sample-${i}`, category: "implementation" });
  }
  const skeletonAvgMs = (Date.now() - skeletonStarted) / 1000;

  // Trace viewer budgets through the viewer's own read path: a second,
  // query_only connection, factId + clipping. Full reads page by
  // TRACE_ROWS_PAGE_MAX (readAllRows' default) or 2 MiB of stored payload,
  // whichever ends a page first; the first read is a discarded warm-up and
  // traceReadMs is the median of the next five. Then single
  // trace:rows calls are timed at TRACE_ROWS_PAGE_DEFAULT, the page size the
  // viewer requests, over repeated full reads until 300 calls are timed.
  const traceReader = openTraceReader(db.dbPath);
  const traceService = createTraceService(traceReader);
  let trace = readAllRows(traceService, SESSION_ID);
  const traceReadRunsMs = [];
  for (let run = 0; run < TRACE_READ_RUNS; run += 1) {
    const started = performance.now();
    trace = readAllRows(traceService, SESSION_ID);
    traceReadRunsMs.push(Math.round(performance.now() - started));
  }
  const traceReadMs = percentile(traceReadRunsMs, 50);
  const tracePageMs = [];
  const timedTraceService = {
    ...traceService,
    rows(request) {
      const started = performance.now();
      const page = traceService.rows(request);
      tracePageMs.push(performance.now() - started);
      return page;
    },
  };
  while (tracePageMs.length < TRACE_PAGE_SAMPLES) {
    readAllRows(timedTraceService, SESSION_ID, TRACE_ROWS_PAGE_DEFAULT);
  }
  const tracePageP95Ms = Number(percentile(tracePageMs, 95).toFixed(1));
  if (traceReadMs > TRACE_READ_BUDGET_MS) {
    console.warn(
      `soak: WARN trace read ${traceReadMs} ms exceeds the ${TRACE_READ_BUDGET_MS} ms budget`,
    );
  }
  if (tracePageP95Ms > TRACE_PAGE_BUDGET_MS) {
    console.warn(
      `soak: WARN trace:rows p95 ${tracePageP95Ms} ms exceeds the ${TRACE_PAGE_BUDGET_MS} ms budget`,
    );
  }

  console.log(
    JSON.stringify(
      {
        records: records.length,
        totalMs,
        ingestMs,
        syncMs,
        throughputEventsPerSec: Math.round((eventCount / totalMs) * 1000),
        persistLatencyMs: {
          p50: percentile(persistLatencies, 50),
          p95: percentile(persistLatencies, 95),
          max: Math.max(...persistLatencies),
        },
        specCount: specs.length,
        patchCount: patches.length,
        surfaceManager: {
          generative: manager.getGenerative().length,
          pending: manager.getPending() !== null,
        },
        skeletonCompileAvgMs: skeletonAvgMs,
        completionSurface: completion !== undefined,
        eventStoreCount: eventCount,
        eventStoreAmplification: Number(amplification.toFixed(2)),
        decisions: db.listDecisions(SESSION_ID).length,
        validations: db.listValidations(SESSION_ID).length,
        failures: db.listFailures(SESSION_ID).length,
        units: db.listChangeUnits(SESSION_ID).length,
        jevDecisions: db.listJevDecisions(SESSION_ID).length,
        profile: PROFILE,
        explainer: EXPLAINER ? { files: EXPLAINER_FILES, rows: explainerRows, yieldEvery: YIELD_EVERY } : null,
        traceReadMs,
        traceReadRunsMs,
        traceRows: trace.rows.length,
        storedRows: trace.lastSeq,
        consumedRows: trace.rows.length,
        tracePageMs: {
          p50: Number(percentile(tracePageMs, 50).toFixed(1)),
          p95: tracePageP95Ms,
          max: Number(Math.max(...tracePageMs).toFixed(1)),
          samples: tracePageMs.length,
          pageSize: TRACE_ROWS_PAGE_DEFAULT,
        },
      },
      null,
      2,
    ),
  );

  await runtime.stopSession(SESSION_ID);
  // Export after stopSession so the bundle carries the terminal session state.
  const exportPath = process.env["JEVCODE_SOAK_EXPORT"];
  if (exportPath !== undefined && exportPath.length > 0) {
    const bundle = buildTraceBundle(traceService, SESSION_ID);
    writeTraceBundle(path.resolve(exportPath), bundle);
    console.log(`soak: wrote ${bundle.rows.length} trace rows to ${path.resolve(exportPath)}`);
  }
  traceReader.close();
  const dbPath = db.dbPath;
  db.close();
  // JEVCODE_SOAK_KEEP_DB (spec §5.6): copy the database before the rmSync.
  // Closing the last connection checkpoints the WAL into soak.db, so that one
  // file holds every row; stale -wal/-shm files beside the target would be
  // replayed over the copy, so they are removed first.
  const keepPath = process.env["JEVCODE_SOAK_KEEP_DB"];
  if (keepPath !== undefined && keepPath.length > 0) {
    assert(!existsSync(`${dbPath}-wal`), `${dbPath}-wal outlived the close; a copy would miss rows`);
    const target = path.resolve(keepPath);
    mkdirSync(path.dirname(target), { recursive: true });
    rmSync(`${target}-wal`, { force: true });
    rmSync(`${target}-shm`, { force: true });
    copyFileSync(dbPath, target);
    chmodSync(target, 0o600);
    console.log(`soak: kept the database at ${target}`);
  }
  rmSync(outDir, { recursive: true, force: true });
}

await main();
