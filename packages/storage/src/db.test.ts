import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  LATEST_SCHEMA_VERSION,
  defaultDbPath,
  openDb,
} from "./index.js";
import { openTempDb, tempDbPath } from "./test-utils.js";

describe("openDb", () => {
  it("creates the database with WAL mode and current schema version", () => {
    const db = openTempDb();
    const info = db.dbInfo();
    expect(info.journalMode).toBe("wal");
    expect(info.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(info.dbPath.endsWith("test.db")).toBe(true);
    db.close();
  });

  it("defaults to ~/.jevcode/jevcode.db", () => {
    expect(defaultDbPath()).toBe(path.join(os.homedir(), ".jevcode", "jevcode.db"));
  });

  it("honors JEVCODE_DB env override", () => {
    const override = path.join(os.tmpdir(), "jevcode-env-override.db");
    process.env.JEVCODE_DB = override;
    try {
      expect(defaultDbPath()).toBe(override);
      const db = openDb();
      expect(db.dbPath).toBe(override);
      db.close();
    } finally {
      delete process.env.JEVCODE_DB;
      rmSync(override, { force: true });
    }
  });

  it("isolates data between separate database files", () => {
    const a = openTempDb();
    const b = openTempDb();
    a.setPreference("only_in_a", { hello: "world" });
    expect(b.getPreference("only_in_a")).toBeUndefined();
    expect(a.getPreference("only_in_a")).toEqual({ hello: "world" });
    a.close();
    b.close();
  });

  it("persists across close and reopen without re-running migrations", () => {
    const dbPath = tempDbPath();
    const first = openDb({ dbPath });
    first.setPreference("k", { v: 1 });
    first.close();
    const second = openDb({ dbPath });
    expect(second.getPreference("k")).toEqual({ v: 1 });
    expect(second.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    second.close();
  });

  it("rejects a database newer than the supported schema", () => {
    const dbPath = tempDbPath();
    const db = openDb({ dbPath });
    db.close();
    const raw = new Database(dbPath);
    raw.prepare("INSERT INTO schema_version (version, appliedAt) VALUES (?, ?)").run(
      LATEST_SCHEMA_VERSION + 1,
      "2026-01-01T00:00:00.000Z",
    );
    raw.close();
    expect(() => openDb({ dbPath })).toThrow(/newer than supported/);
  });

  it("applies the events ts index and ui_snapshots semanticEventId migration (v3)", () => {
    const db = openTempDb();
    expect(db.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(3);

    const raw = new Database(db.dbPath);
    const eventsIndexes = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'")
      .all() as { name: string }[];
    expect(eventsIndexes.map((entry) => entry.name)).toContain("idx_events_ts");

    const snapshotColumns = raw
      .prepare("PRAGMA table_info(ui_snapshots)")
      .all() as { name: string }[];
    expect(snapshotColumns.map((column) => column.name)).toContain("semanticEventId");
    raw.close();
    db.close();
  });

  it("upgrades an existing v2 database in place", () => {
    const dbPath = tempDbPath();
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL, appliedAt TEXT NOT NULL);
      INSERT INTO schema_version (version, appliedAt) VALUES (2, '2026-01-01T00:00:00.000Z');
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payloadJson TEXT NOT NULL,
        ts TEXT NOT NULL,
        UNIQUE (sessionId, seq)
      );
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
      CREATE TABLE ui_snapshots (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0,
        surfaceId TEXT NOT NULL,
        changeUnitId TEXT,
        intentJson TEXT,
        specJson TEXT NOT NULL,
        ts TEXT NOT NULL,
        payloadJson TEXT NOT NULL
      );
    `);
    raw.close();

    const db = openDb({ dbPath });
    expect(db.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    const rawCheck = new Database(dbPath);
    const eventsIndexes = rawCheck
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'")
      .all() as { name: string }[];
    expect(eventsIndexes.map((entry) => entry.name)).toContain("idx_events_ts");
    const snapshotColumns = rawCheck
      .prepare("PRAGMA table_info(ui_snapshots)")
      .all() as { name: string }[];
    expect(snapshotColumns.map((column) => column.name)).toContain("semanticEventId");
    const sessionColumns = rawCheck
      .prepare("PRAGMA table_info(sessions)")
      .all() as { name: string }[];
    expect(sessionColumns.map((column) => column.name)).toContain("execution_claim_ts");
    expect(sessionColumns.map((column) => column.name)).toContain("resume_attempts");
    rawCheck.close();
    db.close();
  });
});
