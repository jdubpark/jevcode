import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { openDb } from "@jevcode/storage";
import type { JevcodeDb } from "@jevcode/storage";
import { parseReplayLine } from "@jevcode/semantic-core";
import type { PipelineRecord } from "@jevcode/semantic-core";
import { EvidenceFactSchema } from "@jevcode/contracts";

import {
  PlaybackClient,
  PlaybackLabels,
  loadPlaybackFixture,
} from "../pipeline/playback.js";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";

export interface ReplayResult {
  sessionId: string;
  records: number;
  unitCount: number;
  surfacedUnitCount: number;
  suppressedUnitCount: number;
  decisionCount: number;
  specCount: number;
  errors: string[];
}

export async function runReplay(
  fixtureDir: string,
  outDir: string,
  log: (message: string) => void = () => {},
): Promise<ReplayResult> {
  const errors: string[] = [];
  const fixture = loadPlaybackFixture(fixtureDir);
  const streamLines = readStream(fixtureDir);
  const records: PipelineRecord[] = [];
  for (const line of streamLines) {
    const record = parseReplayLine(line);
    if (record === null) {
      throw new Error(`unparseable replay line: ${line.slice(0, 80)}`);
    }
    records.push(record);
  }

  const firstFact = records.find((record) =>
    EvidenceFactSchema.safeParse(record).success,
  );
  const repoId = firstFact !== undefined && "repoId" in firstFact
    ? String(firstFact.repoId)
    : "repo-replay";
  const firstEvent = records.find(
    (record) =>
      typeof (record as { type?: unknown }).type === "string" &&
      (record as { type?: string }).type === "agent_started",
  );
  const sessionId =
    firstEvent !== undefined && "sessionId" in firstEvent
      ? String(firstEvent.sessionId)
      : (firstFact !== undefined && "sessionId" in firstFact
        ? String(firstFact.sessionId)
        : "sess-replay");

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const specsDir = path.join(outDir, "ui-specs");
  mkdirSync(specsDir, { recursive: true });

  const db: JevcodeDb = openDb({ dbPath: path.join(outDir, "replay.db") });
  try {
    db.upsertRepository({
      id: repoId,
      path: fixtureDir,
      gitRoot: fixtureDir,
      name: path.basename(fixtureDir),
      branch: "replay",
      baseCommit: "replay",
    });
    db.createSession({
      id: sessionId,
      repoId,
      prompt: firstEvent !== undefined && "prompt" in firstEvent
        ? String(firstEvent.prompt)
        : "",
    });

    const labels = new PlaybackLabels(fixture.labels, fixture.expectedUnits);
    const client = new PlaybackClient(labels);

    const surfaces = new Map<string, { surfaceId: string; spec: unknown }>();
    const runtime = new PipelineRuntime({
      db,
      emit: (channel: string, payload: unknown) => {
        if (channel === "ui:spec") {
          const specPayload = payload as {
            sessionId: string;
            surfaceId: string;
            spec: unknown;
          };
          surfaces.set(specPayload.surfaceId, {
            surfaceId: specPayload.surfaceId,
            spec: specPayload.spec,
          });
        }
      },
      agentMode: "replay",
      jevClient: client,
      evidence: false,
      log,
    });

    await runtime.startSession({
      sessionId,
      repoId,
      repoPath: fixtureDir,
      prompt: firstEvent !== undefined && "prompt" in firstEvent
        ? String(firstEvent.prompt)
        : "",
      agentMode: "replay",
      playbackLabels: labels,
    });

    for (const record of records) {
      runtime.ingestPipelineRecord(sessionId, record);
    }
    await runtime.syncAll();

    const unitCount = db.listChangeUnits(sessionId).length;
    const decisions = db.listDecisions(sessionId);

    for (const [surfaceId, entry] of surfaces) {
      const safeName = surfaceId.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
      writeFileSync(
        path.join(specsDir, `${safeName}.json`),
        `${JSON.stringify(entry.spec, null, 2)}\n`,
      );
    }

    const surfacedSlugs = new Set(
      runtime
        .snapshotSurfaces(sessionId)
        .filter((surface) => surface.changeUnitId !== undefined)
        .map((surface) => surface.replaySlug)
        .filter((slug): slug is string => slug !== undefined),
    );
    for (const slug of Object.keys(fixture.labels.projection)) {
      if (!surfacedSlugs.has(slug)) {
        errors.push(`surfaced unit "${slug}" produced no ui spec`);
      }
    }
    for (const slug of Object.keys(fixture.labels.attention)) {
      const attention = fixture.labels.attention[slug];
      if (attention !== undefined && attention.shouldSurface === false) {
        if (surfacedSlugs.has(slug)) {
          errors.push(`suppressed unit "${slug}" was surfaced`);
        }
      }
    }

    const state = {
      sessionId,
      unitCount,
      decisionCount: decisions.length,
      surfaces: [...surfaces.keys()],
      decisions: decisions.map((decision) => ({
        id: decision.id,
        status: decision.status,
        severity: decision.severity,
      })),
      matchedSlugs: [...labels.matchedSlugs],
    };
    writeFileSync(
      path.join(outDir, "semantic-state.json"),
      `${JSON.stringify(state, null, 2)}\n`,
    );

    await runtime.stopSession(sessionId);

    return {
      sessionId,
      records: records.length,
      unitCount,
      surfacedUnitCount: surfacedSlugs.size,
      suppressedUnitCount:
        Object.values(fixture.labels.attention).filter(
          (label) => label.shouldSurface === false,
        ).length,
      decisionCount: decisions.length,
      specCount: surfaces.size,
      errors,
    };
  } finally {
    db.close();
  }
}

function readStream(fixtureDir: string): string[] {
  const text = readFileSync(path.join(fixtureDir, "events.jsonl"), "utf8");
  return text.split("\n").filter((line) => line.trim().length > 0);
}

export async function replayMain(argv: string[]): Promise<number> {
  const fixtureDir = argv[2];
  const outDir = argv[3];
  if (fixtureDir === undefined || outDir === undefined) {
    console.error("usage: jevcode-replay <fixtureDir> <outDir>");
    return 1;
  }
  const started = Date.now();
  const result = await runReplay(fixtureDir, outDir, (message) => {
    console.error(`[replay] ${message}`);
  });
  console.log(
    JSON.stringify(
      {
        fixture: fixtureDir,
        outDir,
        elapsedMs: Date.now() - started,
        ...result,
      },
      null,
      2,
    ),
  );
  if (result.errors.length > 0) {
    console.error("replay errors:");
    for (const error of result.errors) {
      console.error(` - ${error}`);
    }
    return 1;
  }
  return 0;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("cli-entry.js")) {
  void replayMain(process.argv).then((code) => {
    process.exit(code);
  });
}
