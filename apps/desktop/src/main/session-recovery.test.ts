import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb } from "@jevcode/storage";
import type { JevcodeDb } from "@jevcode/storage";
import { afterEach, describe, expect, it } from "vitest";

import {
  STALE_CLAIM_MS,
  sweepStaleSessions,
} from "./session-recovery.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function createDb(): JevcodeDb {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jevcode-recovery-"));
  tempDirs.push(dir);
  const db = openDb({ dbPath: path.join(dir, "recovery.db") });
  db.upsertRepository({ id: "repo_r", path: "/work/r", gitRoot: "/work/r" });
  return db;
}

function addSession(
  db: JevcodeDb,
  id: string,
  state: "running" | "paused" | "waiting_decision" | "completed" | "failed",
  claim: string | null,
): void {
  db.createSession({ id, repoId: "repo_r", state });
  db.setExecutionClaim(id, claim);
}

const NOW = Date.parse("2026-09-19T12:00:00.000Z");

function freshClaim(): string {
  return new Date(NOW - STALE_CLAIM_MS + 60_000).toISOString();
}

function staleClaim(): string {
  return new Date(NOW - STALE_CLAIM_MS - 60_000).toISOString();
}

describe("sweepStaleSessions", () => {
  it("fails running sessions even with a fresh claim", () => {
    const db = createDb();
    addSession(db, "s1", "running", freshClaim());
    const swept = sweepStaleSessions(db, new Date(NOW));
    expect(swept).toEqual([
      { sessionId: "s1", fromState: "running", reason: "running_at_boot" },
    ]);
    expect(db.getSession("s1")?.state).toBe("failed");
    expect(db.getSession("s1")?.executionClaimTs).toBeNull();
    db.close();
  });

  it("fails running sessions with no claim", () => {
    const db = createDb();
    addSession(db, "s1", "running", null);
    const swept = sweepStaleSessions(db, new Date(NOW));
    expect(swept.map((entry) => entry.sessionId)).toEqual(["s1"]);
    expect(db.getSession("s1")?.state).toBe("failed");
    db.close();
  });

  it("keeps waiting_decision sessions with a fresh claim", () => {
    const db = createDb();
    addSession(db, "s1", "waiting_decision", freshClaim());
    const swept = sweepStaleSessions(db, new Date(NOW));
    expect(swept).toEqual([]);
    expect(db.getSession("s1")?.state).toBe("waiting_decision");
    expect(db.getSession("s1")?.executionClaimTs).not.toBeNull();
    db.close();
  });

  it("fails waiting_decision sessions with a stale claim", () => {
    const db = createDb();
    addSession(db, "s1", "waiting_decision", staleClaim());
    const swept = sweepStaleSessions(db, new Date(NOW));
    expect(swept).toEqual([
      { sessionId: "s1", fromState: "waiting_decision", reason: "stale_claim" },
    ]);
    expect(db.getSession("s1")?.state).toBe("failed");
    db.close();
  });

  it("fails waiting_decision sessions with a missing claim", () => {
    const db = createDb();
    addSession(db, "s1", "waiting_decision", null);
    const swept = sweepStaleSessions(db, new Date(NOW));
    expect(swept).toEqual([
      { sessionId: "s1", fromState: "waiting_decision", reason: "missing_claim" },
    ]);
    expect(db.getSession("s1")?.state).toBe("failed");
    db.close();
  });

  it("applies the same freshness rule to paused sessions", () => {
    const db = createDb();
    addSession(db, "fresh", "paused", freshClaim());
    addSession(db, "old", "paused", staleClaim());
    const swept = sweepStaleSessions(db, new Date(NOW));
    expect(swept).toEqual([
      { sessionId: "old", fromState: "paused", reason: "stale_claim" },
    ]);
    expect(db.getSession("fresh")?.state).toBe("paused");
    expect(db.getSession("old")?.state).toBe("failed");
    db.close();
  });

  it("leaves terminal states untouched", () => {
    const db = createDb();
    addSession(db, "done", "completed", null);
    addSession(db, "boom", "failed", null);
    const swept = sweepStaleSessions(db, new Date(NOW));
    expect(swept).toEqual([]);
    expect(db.getSession("done")?.state).toBe("completed");
    expect(db.getSession("boom")?.state).toBe("failed");
    db.close();
  });

  it("accepts a string timestamp", () => {
    const db = createDb();
    addSession(db, "s1", "waiting_decision", staleClaim());
    const swept = sweepStaleSessions(db, "2026-09-19T12:00:00.000Z");
    expect(swept).toHaveLength(1);
    db.close();
  });
});
