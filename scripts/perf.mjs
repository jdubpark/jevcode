import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openDb } from "../packages/storage/dist/index.js";
import { parseReplayLine } from "../packages/semantic-core/dist/index.js";
import { PipelineRuntime } from "../apps/desktop/dist/main/pipeline/pipeline-runtime.js";
import {
  PlaybackClient,
  PlaybackLabels,
  loadPlaybackFixture,
} from "../apps/desktop/dist/main/pipeline/playback.js";
import {
  compileCompletionSurface,
  compileChangeUnitSurface,
} from "../apps/desktop/dist/main/pipeline/ui-stage.js";
import { compileSkeleton } from "../packages/ui-compiler/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCENARIOS = ["oauth", "rate-limit", "schema-change", "api-break", "dep-change"];

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

function loadRecords(name) {
  const text = readFileSync(path.join(root, "fixtures", name, "events.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => parseReplayLine(line));
}

async function replayFixture(name, onEmit, onPersist) {
  const records = loadRecords(name);
  const dir = mkdtempSync(path.join(tmpdir(), "jevcode-perf-"));
  const db = openDb({ dbPath: path.join(dir, "perf.db") });
  db.upsertRepository({
    id: "repo-perf",
    path: path.join(root, "fixtures", name),
    gitRoot: path.join(root, "fixtures", name),
    branch: "perf",
    baseCommit: "perf",
  });
  const firstAgent = records.find(
    (record) => !("repoId" in record) && !("severity" in record) && !("kind" in record),
  );
  const sessionId = firstAgent?.sessionId ?? "sess-perf";
  db.createSession({ id: sessionId, repoId: "repo-perf", prompt: firstAgent?.prompt ?? "" });

  const fixture = loadPlaybackFixture(path.join(root, "fixtures", name));
  const labels = new PlaybackLabels(fixture.labels, fixture.expectedUnits);

  const originalAppend = db.appendEvidenceFact.bind(db);
  db.appendEvidenceFact = (sid, fact) => {
    const started = Date.now();
    const result = originalAppend(sid, fact);
    onPersist(Date.now() - started);
    return result;
  };

  const started = Date.now();
  let firstSpecAt = null;
  const trackingEmit = (channel, payload) => {
    if (channel === "ui:spec" && firstSpecAt === null) {
      firstSpecAt = Date.now();
    }
    onEmit(channel, payload);
  };
  const runtime = new PipelineRuntime({
    db,
    emit: trackingEmit,
    agentMode: "replay",
    jevClient: new PlaybackClient(labels),
    evidence: false,
    log: () => {},
  });
  await runtime.startSession({
    sessionId,
    repoId: "repo-perf",
    repoPath: path.join(root, "fixtures", name),
    prompt: firstAgent?.prompt ?? "",
    agentMode: "replay",
    playbackLabels: labels,
  });
  const ingestStarted = Date.now();
  for (const record of records) {
    runtime.ingestPipelineRecord(sessionId, record);
  }
  await runtime.syncAll();
  const done = Date.now();
  const surfaces = runtime.snapshotSurfaces(sessionId);
  const ctx = {
    sessionId,
    facts: [],
    validations: db.listValidations(sessionId),
    failures: db.listFailures(sessionId).map((f) => ({
      id: f.id ?? `${f.validationId}:${f.file}:${f.testName}`,
      sessionId: f.sessionId,
      validationId: f.validationId,
      file: f.file,
      testName: f.testName,
      message: f.message,
      ts: f.ts,
    })),
    decisions: db.listDecisions(sessionId),
    semanticEvents: db.listSemanticEvents(sessionId),
    graphNodes: db.listGraphNodes(sessionId).map((n) => ({
      id: n.id,
      sessionId: n.sessionId,
      type: n.nodeType,
      label: String(n.payload["label"] ?? n.id),
      data: n.payload,
    })),
    graphEdges: db.listGraphEdges(sessionId).map((e) => ({
      id: e.id,
      sessionId: e.sessionId,
      from: e.fromId,
      to: e.toId,
      type: e.edgeType,
    })),
    agentEvents: db.listAgentEvents(sessionId),
    units: db.listChangeUnits(sessionId),
  };
  await runtime.stopSession(sessionId);
  db.close();
  rmSync(dir, { recursive: true, force: true });
  return {
    records: records.length,
    ingestMs: done - ingestStarted,
    firstSpecMs: firstSpecAt !== null ? firstSpecAt - ingestStarted : null,
    surfaces: surfaces.length,
    ctx,
  };
}

async function main() {
  const persistLatencies = [];
  const results = {};
  for (const name of SCENARIOS) {
    const result = await replayFixture(
      name,
      () => {},
      (ms) => persistLatencies.push(ms),
    );
    results[name] = result;
    console.error(
      `${name}: ${result.records} records, ingest+sync ${result.ingestMs}ms, first spec ${result.firstSpecMs}ms, surfaces ${result.surfaces}`,
    );
  }

  const completionTimes = [];
  const rateLimit = results["rate-limit"];
  for (let i = 0; i < 500; i += 1) {
    const started = Date.now();
    compileCompletionSurface(rateLimit.ctx);
    completionTimes.push(Date.now() - started);
  }

  const skeletonTimes = [];
  for (let i = 0; i < 5000; i += 1) {
    const started = Date.now();
    compileSkeleton({ title: `s${i}`, category: "implementation" });
    skeletonTimes.push(Date.now() - started);
  }

  const changeUnitCompileTimes = [];
  const oauthCtx = results["oauth"].ctx;
  const unit = oauthCtx.units[0];
  if (unit !== undefined) {
    const intent = {
      attention: "surface",
      subject: "code",
      representation: "summary",
      density: "normal",
      confidence: 0.9,
      showEvidence: true,
      showCode: false,
      secondaryViews: [],
      renderMode: "autonomous",
    };
    for (let i = 0; i < 500; i += 1) {
      const started = Date.now();
      compileChangeUnitSurface(unit, intent, oauthCtx);
      changeUnitCompileTimes.push(Date.now() - started);
    }
  }

  console.log(
    JSON.stringify(
      {
        persistLatencyMs: {
          p50: percentile(persistLatencies, 50),
          p95: percentile(persistLatencies, 95),
          max: Math.max(...persistLatencies),
          samples: persistLatencies.length,
        },
        fixtures: Object.fromEntries(
          Object.entries(results).map(([name, r]) => [
            name,
            { records: r.records, ingestMs: r.ingestMs, firstSpecMs: r.firstSpecMs },
          ]),
        ),
        compile: {
          completionSurfaceMs: {
            p50: percentile(completionTimes, 50),
            p95: percentile(completionTimes, 95),
          },
          skeletonMs: {
            p50: percentile(skeletonTimes, 50),
            p95: percentile(skeletonTimes, 95),
          },
          changeUnitSummaryMs: {
            p50: percentile(changeUnitCompileTimes, 50),
            p95: percentile(changeUnitCompileTimes, 95),
          },
        },
      },
      null,
      2,
    ),
  );
}

await main();
