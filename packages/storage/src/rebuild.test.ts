import { describe, expect, it } from "vitest";

import { openDb } from "./index.js";
import { openSessionDb, tempDbPath } from "./test-utils.js";
import {
  makeAgentEvent,
  makeChangeUnit,
  makeDecision,
  makeFact,
  makeJevLog,
  REPO,
  SESSION,
} from "./fixtures.js";

describe("rebuildSession", () => {
  it("replaying events does not duplicate projections", () => {
    const db = openSessionDb();
    db.appendAgentEvent(SESSION, makeAgentEvent());
    db.appendAgentEvent(
      SESSION,
      makeAgentEvent({
        type: "command_completed",
        command: "npm test",
        exitCode: 1,
        stdout: "2 failed",
        stderr: "",
      }),
    );
    db.appendEvidenceFact(SESSION, makeFact({ type: "file_changed" }));
    db.appendEvidenceFact(
      SESSION,
      makeFact({
        type: "test_result",
        runner: "vitest",
        command: "vitest run",
        passed: 0,
        failed: 1,
        skipped: 0,
        failures: [{ file: "a.test.ts", testName: "t", message: "m" }],
      }),
    );
    db.upsertChangeUnit(makeChangeUnit());
    db.upsertDecision(makeDecision());
    db.upsertJevDecision(makeJevLog());

    const counts = () => ({
      agent: db.listAgentEvents(SESSION).length,
      commands: db.listCommands(SESSION).length,
      validations: db.listValidations(SESSION).length,
      failures: db.listFailures(SESSION).length,
      units: db.listChangeUnits(SESSION).length,
      decisions: db.listDecisions(SESSION).length,
      jev: db.listJevDecisions(SESSION).length,
      events: db.getEventCount(SESSION),
    });

    const before = counts();
    expect(before).toEqual({
      agent: 2,
      commands: 1,
      validations: 1,
      failures: 1,
      units: 1,
      decisions: 1,
      jev: 1,
      events: 7,
    });

    const stats = db.rebuildSession(SESSION);
    expect(stats.replayed).toBe(7);
    expect(counts()).toEqual(before);

    db.rebuildSession(SESSION);
    expect(counts()).toEqual(before);
    db.close();
  });

  it("reconstructs identical projections after a close and reopen", () => {
    const dbPath = tempDbPath();
    const db = openDb({ dbPath });
    db.upsertRepository({ id: REPO, path: "/work/fixture", gitRoot: "/work/fixture" });
    db.createSession({ id: SESSION, repoId: REPO });
    db.upsertChangeUnit(makeChangeUnit());
    db.upsertDecision(makeDecision());
    const beforeUnit = db.getChangeUnit("cu_1");
    const beforeDecision = db.getDecision("dec_1");
    db.close();

    const reopened = openDb({ dbPath });
    const stats = reopened.rebuildSession(SESSION);
    expect(stats.replayed).toBe(2);
    expect(reopened.getChangeUnit("cu_1")).toEqual(beforeUnit);
    expect(reopened.getDecision("dec_1")).toEqual(beforeDecision);
    expect(reopened.getDecision("dec_1")?.options).toHaveLength(2);
    reopened.close();
  });

  it("replays only the requested session", () => {
    const db = openSessionDb();
    const other = "sess_other";
    db.createSession({ id: other, repoId: REPO });
    db.appendAgentEvent(SESSION, makeAgentEvent());
    db.appendAgentEvent(other, makeAgentEvent({ sessionId: other }));
    const stats = db.rebuildSession(SESSION);
    expect(stats.replayed).toBe(1);
    db.close();
  });

  it("persists semantic events and restores them on rebuild", () => {
    const dbPath = tempDbPath();
    const db = openDb({ dbPath });
    db.upsertRepository({ id: REPO, path: "/work/fixture", gitRoot: "/work/fixture" });
    db.createSession({ id: SESSION, repoId: REPO });
    const semanticEvent = {
      id: "sem_1",
      sessionId: SESSION,
      kind: "decision_candidate" as const,
      summary: "Redis unavailability policy is unspecified",
      evidence: [{ id: "ev_1", type: "git_hunk" as const, sourceId: "src/x.ts" }],
      files: ["src/x.ts"],
      symbols: ["rateLimiter"],
      createdAt: "2026-09-18T09:00:18.000Z",
    };
    db.appendSemanticEvent(SESSION, semanticEvent);
    expect(db.listSemanticEvents(SESSION)).toHaveLength(1);

    db.close();
    const reopened = openDb({ dbPath });
    reopened.rebuildSession(SESSION);
    const restored = reopened.listSemanticEvents(SESSION);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      id: "sem_1",
      kind: "decision_candidate",
      summary: "Redis unavailability policy is unspecified",
    });
    reopened.close();
  });

  it("rebuildOnBoot replays every session with events and leaves projections idempotent", () => {
    const db = openSessionDb();
    const other = "sess_other";
    db.createSession({ id: other, repoId: REPO });
    db.appendAgentEvent(SESSION, makeAgentEvent());
    db.appendAgentEvent(other, makeAgentEvent({ sessionId: other }));
    db.appendTelemetry("surface_shown", { specHash: "h" });

    const stats = db.rebuildOnBoot();
    expect(stats.map((s) => s.sessionId).sort()).toEqual(["", SESSION, other]);
    expect(stats.map((s) => s.replayed).sort()).toEqual([1, 1, 1]);
    expect(db.listAgentEvents(SESSION)).toHaveLength(1);
    expect(db.listAgentEvents(other)).toHaveLength(1);
    expect(db.listTelemetry()).toHaveLength(1);

    const again = db.rebuildOnBoot();
    expect(again.map((s) => s.replayed).sort()).toEqual([1, 1, 1]);
    expect(db.listAgentEvents(SESSION)).toHaveLength(1);
    expect(db.listAgentEvents(other)).toHaveLength(1);
    expect(db.listTelemetry()).toHaveLength(1);
    db.close();
  });
});
