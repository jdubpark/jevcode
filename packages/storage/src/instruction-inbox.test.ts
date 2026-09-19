import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { LATEST_SCHEMA_VERSION, openDb } from "./index.js";
import { openSessionDb, tempDbPath } from "./test-utils.js";

const SESSION = "sess_fixture";

describe("migration v4", () => {
  it("upgrades a v3 database in place, preserving sessions", () => {
    const dbPath = tempDbPath();
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL, appliedAt TEXT NOT NULL);
      INSERT INTO schema_version (version, appliedAt) VALUES (3, '2026-01-01T00:00:00.000Z');
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        repoId TEXT NOT NULL,
        prompt TEXT NOT NULL DEFAULT '',
        baseCommit TEXT NOT NULL DEFAULT '',
        branch TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'starting',
        lastEventSeq INTEGER NOT NULL DEFAULT 0,
        startedAt TEXT NOT NULL,
        endedAt TEXT,
        createdAt TEXT NOT NULL
      );
      INSERT INTO sessions (id, repoId, prompt, baseCommit, branch, state, lastEventSeq, startedAt, endedAt, createdAt)
        VALUES ('sess_legacy', 'repo_x', 'legacy prompt', '', '', 'running', 3, '2026-01-02T00:00:00.000Z', NULL, '2026-01-02T00:00:00.000Z');
    `);
    raw.close();

    const db = openDb({ dbPath });
    expect(db.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(4);

    const rawCheck = new Database(dbPath);
    const sessionColumns = rawCheck
      .prepare("PRAGMA table_info(sessions)")
      .all() as { name: string; dflt_value: string | null }[];
    const names = sessionColumns.map((column) => column.name);
    expect(names).toContain("execution_claim_ts");
    expect(names).toContain("resume_attempts");
    const resumeColumn = sessionColumns.find((column) => column.name === "resume_attempts");
    expect(resumeColumn?.dflt_value).toBe("0");

    const inboxTable = rawCheck
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'instruction_inbox'",
      )
      .get() as { name: string } | undefined;
    expect(inboxTable).toBeDefined();
    rawCheck.close();

    const legacy = db.getSession("sess_legacy");
    expect(legacy).toMatchObject({
      id: "sess_legacy",
      prompt: "legacy prompt",
      state: "running",
      resumeAttempts: 0,
      executionClaimTs: null,
    });
    db.close();
  });
});

describe("instruction inbox", () => {
  it("lists pending instructions in admission order", () => {
    const db = openSessionDb();
    db.upsertInstruction({ sessionId: SESSION, instructionId: "i1", mode: "queue", text: "first" });
    db.upsertInstruction({ sessionId: SESSION, instructionId: "i2", mode: "steer", text: "second" });
    const pending = db.listPendingInstructions(SESSION);
    expect(pending.map((entry) => entry.instructionId)).toEqual(["i1", "i2"]);
    expect(pending[0]).toMatchObject({
      sessionId: SESSION,
      instructionId: "i1",
      mode: "queue",
      text: "first",
      status: "pending",
      deliveredAt: null,
    });
    db.close();
  });

  it("upsert is idempotent per (sessionId, instructionId)", () => {
    const db = openSessionDb();
    const first = db.upsertInstruction({ sessionId: SESSION, instructionId: "i1", mode: "queue", text: "original" });
    const second = db.upsertInstruction({ sessionId: SESSION, instructionId: "i1", mode: "steer", text: "changed" });
    expect(second).toEqual(first);
    expect(second.text).toBe("original");
    expect(second.seq).toBe(first.seq);
    const all = db
      .getInstruction(SESSION, "i1");
    expect(all?.text).toBe("original");
    db.close();
  });

  it("delivered and cancelled rows leave the pending list", () => {
    const db = openSessionDb();
    db.upsertInstruction({ sessionId: SESSION, instructionId: "i1", mode: "queue", text: "deliver me" });
    db.upsertInstruction({ sessionId: SESSION, instructionId: "i2", mode: "queue", text: "cancel me" });

    db.markInstructionDelivered(SESSION, "i1");
    expect(db.getInstruction(SESSION, "i1")).toMatchObject({
      status: "delivered",
    });
    expect(db.getInstruction(SESSION, "i1")?.deliveredAt).not.toBeNull();

    db.markInstructionCancelled(SESSION, "i2");
    expect(db.getInstruction(SESSION, "i2")).toMatchObject({ status: "cancelled" });

    expect(db.listPendingInstructions(SESSION)).toEqual([]);
    db.close();
  });

  it("re-admission does not resurrect cancelled or delivered rows", () => {
    const db = openSessionDb();
    db.upsertInstruction({ sessionId: SESSION, instructionId: "i1", mode: "queue", text: "x" });
    db.markInstructionCancelled(SESSION, "i1");
    db.upsertInstruction({ sessionId: SESSION, instructionId: "i1", mode: "queue", text: "again" });
    expect(db.getInstruction(SESSION, "i1")?.status).toBe("cancelled");

    db.upsertInstruction({ sessionId: SESSION, instructionId: "i2", mode: "queue", text: "y" });
    db.markInstructionDelivered(SESSION, "i2");
    db.upsertInstruction({ sessionId: SESSION, instructionId: "i2", mode: "queue", text: "again" });
    expect(db.getInstruction(SESSION, "i2")?.status).toBe("delivered");
    db.close();
  });

  it("scopes pending lists per session", () => {
    const db = openSessionDb();
    const other = "sess_other";
    db.createSession({ id: other, repoId: "repo_fixture" });
    db.upsertInstruction({ sessionId: SESSION, instructionId: "i1", mode: "queue", text: "mine" });
    db.upsertInstruction({ sessionId: other, instructionId: "i2", mode: "queue", text: "theirs" });
    expect(db.listPendingInstructions(SESSION).map((entry) => entry.instructionId)).toEqual(["i1"]);
    expect(db.listPendingInstructions(other).map((entry) => entry.instructionId)).toEqual(["i2"]);
    db.close();
  });

  it("pending instructions survive a close and reopen", () => {
    const dbPath = tempDbPath();
    const first = openDb({ dbPath });
    first.upsertRepository({ id: "repo_fixture", path: "/work/fixture", gitRoot: "/work/fixture" });
    first.createSession({ id: SESSION, repoId: "repo_fixture" });
    first.upsertInstruction({ sessionId: SESSION, instructionId: "i1", mode: "queue", text: "durable" });
    first.close();

    const second = openDb({ dbPath });
    const pending = second.listPendingInstructions(SESSION);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ instructionId: "i1", text: "durable" });
    second.close();
  });
});

describe("execution claim and resume attempts", () => {
  it("sets and releases the execution claim", () => {
    const db = openSessionDb();
    const ts = "2026-09-19T10:00:00.000Z";
    db.setExecutionClaim(SESSION, ts);
    expect(db.getSession(SESSION)?.executionClaimTs).toBe(ts);
    db.setExecutionClaim(SESSION, null);
    expect(db.getSession(SESSION)?.executionClaimTs).toBeNull();
    db.close();
  });

  it("increments resume attempts and returns the new value", () => {
    const db = openSessionDb();
    expect(db.getResumeAttempts(SESSION)).toBe(0);
    expect(db.incrementResumeAttempts(SESSION)).toBe(1);
    expect(db.incrementResumeAttempts(SESSION)).toBe(2);
    expect(db.incrementResumeAttempts(SESSION)).toBe(3);
    expect(db.getSession(SESSION)?.resumeAttempts).toBe(3);
    db.close();
  });

  it("lists sessions by state", () => {
    const db = openSessionDb();
    db.createSession({ id: "sess_paused", repoId: "repo_fixture", state: "paused" });
    const rows = db.listSessionsByStates(["running", "paused"]);
    expect(rows.map((row) => row.id)).toEqual(["sess_paused"]);
    db.close();
  });
});
