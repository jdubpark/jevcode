import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  AttentionDecision,
  EvidenceFact,
  JevResult,
  UIIntent,
} from "@jevcode/contracts";
import { DegradeClient } from "@jevcode/jev-router";
import type { AttentionInput, JevClient, ProjectionInput } from "@jevcode/jev-router";
import { PipelineCoordinator } from "@jevcode/semantic-core";
import { openDb } from "@jevcode/storage";
import type { JevcodeDb } from "@jevcode/storage";
import { afterEach, describe, expect, it } from "vitest";

import { runJevStage } from "./jev-stage.js";

const SESSION = "sess_jev_stage";
const REPO = "repo_jev_stage";

// Heuristic answers relabeled as a typesafe client with a fixed confidence,
// so the logs show what the real client reported.
class TypesafeLikeClient implements JevClient {
  private readonly inner = new DegradeClient();

  async attention(batch: AttentionInput[]): Promise<JevResult<AttentionDecision>[]> {
    const results = await this.inner.attention(batch);
    return results.map((result) => ({
      ...result,
      value: { ...result.value, shouldSurface: true },
      confidence: 0.93,
      clientKind: "typesafe" as const,
    }));
  }

  async project(input: ProjectionInput): Promise<JevResult<UIIntent>> {
    const result = await this.inner.project(input);
    return { ...result, confidence: 0.91, clientKind: "typesafe" as const };
  }

  health(): ReturnType<JevClient["health"]> {
    return this.inner.health();
  }
}

function hunk(file: string, ts: string, isLockfile: boolean): EvidenceFact {
  return {
    type: "git_hunk",
    repoId: REPO,
    sessionId: SESSION,
    file,
    added: 12,
    removed: 2,
    isFormattingOnly: false,
    isConfigOnly: false,
    isLockfile,
    ts,
  };
}

const dirs: string[] = [];

function createDb(): JevcodeDb {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jevcode-jev-stage-"));
  dirs.push(dir);
  const db = openDb({ dbPath: path.join(dir, "jev.db") });
  db.upsertRepository({ id: REPO, path: "/work/jev", gitRoot: "/work/jev" });
  db.createSession({ id: SESSION, repoId: REPO });
  return db;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("runJevStage decision logs", () => {
  it("records the pass and the real client on attention, projection and suppression logs", async () => {
    const db = createDb();
    // Five minutes apart: two buckets, so the lockfile is its own unit.
    const facts = [
      hunk("src/app.ts", "2026-09-28T10:00:00.000Z", false),
      hunk("pnpm-lock.yaml", "2026-09-28T10:05:00.000Z", true),
    ];
    const coordinator = new PipelineCoordinator();
    for (const fact of facts) coordinator.ingest(fact);
    coordinator.flush();
    const units = coordinator.snapshot().units;
    const appUnit = units.find((unit) => unit.files.includes("src/app.ts"));
    const lockUnit = units.find((unit) => unit.files.includes("pnpm-lock.yaml"));
    expect(appUnit).toBeDefined();
    expect(lockUnit).toBeDefined();
    expect(lockUnit?.id).not.toBe(appUnit?.id);

    const { logs } = await runJevStage({
      db,
      coordinator,
      client: new TypesafeLikeClient(),
      sessionId: SESSION,
      taskPrompt: "demo",
      facts,
      decisions: [],
      semanticEvents: [],
      nowIso: () => "2026-09-28T10:10:00.000Z",
    });

    const suppression = logs.find((log) => log.changeUnitId === lockUnit?.id);
    expect(suppression).toMatchObject({
      pass: "A",
      clientKind: "typesafe",
      confidence: 0.93,
      output: { shouldSurface: false, guardrailSuppression: true },
    });
    expect(
      logs.filter((log) => log.changeUnitId === appUnit?.id).map((log) => log.pass),
    ).toEqual(["A", "B"]);
    // pass survives the storage round trip (no zod strip).
    expect(
      db
        .listJevDecisions(SESSION)
        .map((log) => log.pass)
        .sort(),
    ).toEqual(["A", "A", "B"]);
    db.close();
  });

  it("writes no projection row when the session stops while project() is in flight (final review B M-1)", async () => {
    const db = createDb();
    const facts = [hunk("src/app.ts", "2026-09-28T10:00:00.000Z", false)];
    const coordinator = new PipelineCoordinator();
    for (const fact of facts) coordinator.ingest(fact);
    coordinator.flush();
    let stopped = false;
    // The runtime's pace(): it throws once the session is stopped (pipeline-runtime.ts PassStopped).
    class StopsDuringProjection extends TypesafeLikeClient {
      override async project(input: ProjectionInput): Promise<JevResult<UIIntent>> {
        const result = await super.project(input);
        stopped = true;
        return result;
      }
    }

    await expect(
      runJevStage({
        db,
        coordinator,
        client: new StopsDuringProjection(),
        sessionId: SESSION,
        taskPrompt: "demo",
        facts,
        decisions: [],
        semanticEvents: [],
        nowIso: () => "2026-09-28T10:10:00.000Z",
        pace: async () => {
          if (stopped) throw new Error("session stopped during the sync pass");
        },
      }),
    ).rejects.toThrow("session stopped");
    expect(db.listJevDecisions(SESSION).map((log) => log.pass)).toEqual(["A"]);
    db.close();
  });
});
