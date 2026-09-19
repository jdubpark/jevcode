import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openDb } from "../packages/storage/dist/index.js";
import {
  EvidenceFactSchema,
  NormalizedAgentEventSchema,
  DecisionSchema,
} from "../packages/contracts/dist/index.js";
import { DegradeClient } from "../packages/jev-router/dist/index.js";
import { parseReplayLine } from "../packages/semantic-core/dist/index.js";
import { SurfaceManager } from "../packages/ui-catalog/dist/surface/SurfaceManager.js";
import { compileSkeleton } from "../packages/ui-compiler/dist/index.js";
import { PipelineRuntime } from "../apps/desktop/dist/main/pipeline/pipeline-runtime.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = path.join(root, "fixtures", "oauth");

const TARGET_EVENTS = Number(process.env["JEVCODE_SOAK_EVENTS"] ?? 10_000);
const SESSION_ID = "sess-soak-0001";
const REPO_ID = "repo-soak";

function nowIso(offsetMs) {
  return new Date(Date.UTC(2026, 8, 19, 9, 0, 0) + offsetMs).toISOString();
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
      push({
        type: "command_started",
        sessionId: SESSION_ID,
        command: `pnpm test ${burst}`,
        ts: nowIso((t += 100)),
      });
      push({
        type: "test_result",
        repoId: REPO_ID,
        sessionId: SESSION_ID,
        runner: "vitest",
        command: `pnpm test ${burst}`,
        passed: 42,
        failed: 0,
        skipped: 0,
        failures: [],
        ts: nowIso((t += 100)),
      });
      push({
        type: "command_completed",
        sessionId: SESSION_ID,
        command: `pnpm test ${burst}`,
        exitCode: 0,
        stdout: "",
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
      push({
        type: "agent_message",
        sessionId: SESSION_ID,
        role: "assistant",
        text: `Progress note ${burst}.`,
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
  });

  await runtime.startSession({
    sessionId: SESSION_ID,
    repoId: REPO_ID,
    repoPath: fixtureDir,
    prompt: "Soak task: touch everything.",
    agentMode: "replay",
  });

  const records = buildStream();
  console.log(`soak: ${records.length} generated records`);

  const ingestStarted = Date.now();
  let burstIndex = 0;
  for (const record of records) {
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
      },
      null,
      2,
    ),
  );

  await runtime.stopSession(SESSION_ID);
  db.close();
  rmSync(outDir, { recursive: true, force: true });
}

await main();
