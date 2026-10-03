import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { EVENT_TYPES as CONTRACT_EVENT_TYPES } from "@jevcode/contracts";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  EVENT_TYPES,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  defaultDbPath,
  openDb,
} from "./index.js";
import { makeJevLog, makeOverviewSnapshot } from "./fixtures.js";
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
      -- v1's table, which v6 indexes (lane 07 PL-3).
      CREATE TABLE jev_decisions (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0,
        changeUnitId TEXT,
        inputHash TEXT NOT NULL,
        outputJson TEXT NOT NULL,
        confidence REAL NOT NULL,
        probabilitiesJson TEXT,
        latencyMs INTEGER NOT NULL,
        clientKind TEXT NOT NULL,
        clampsJson TEXT NOT NULL,
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

  it("upgrades a v4 database built by migrations 1-4 through v5 without touching its rows", () => {
    const dbPath = tempDbPath();
    const TS0 = "2026-09-01T00:00:00.000Z";
    const v4 = new Database(dbPath);
    v4.exec("CREATE TABLE schema_version (version INTEGER NOT NULL, appliedAt TEXT NOT NULL)");
    for (const migration of MIGRATIONS) {
      if (migration.version > 4) continue;
      v4.transaction(() => {
        migration.up(v4);
        v4.prepare("INSERT INTO schema_version (version, appliedAt) VALUES (?, ?)").run(migration.version, TS0);
      })();
    }
    v4.prepare(
      "INSERT INTO repositories (id, path, gitRoot, name, lastOpenedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("repo_v4", "/work/v4", "/work/v4", "v4", TS0, TS0);
    v4.prepare(
      "INSERT INTO sessions (id, repoId, prompt, lastEventSeq, startedAt, createdAt) VALUES (?, ?, ?, 1, ?, ?)",
    ).run("sess_v4", "repo_v4", "old prompt", TS0, TS0);
    v4.prepare(
      "INSERT INTO events (id, sessionId, seq, type, payloadJson, ts) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "evt_v4",
      "sess_v4",
      1,
      "agent_event",
      JSON.stringify({ type: "agent_started", sessionId: "sess_v4", prompt: "old prompt", ts: TS0 }),
      TS0,
    );
    expect(v4.prepare("SELECT MAX(version) AS v FROM schema_version").get()).toEqual({ v: 4 });
    expect(
      v4
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('component_text_cache', 'overview_state')")
        .all(),
    ).toEqual([]);
    v4.close();

    const db = openDb({ dbPath });
    // v5 and every later migration (v6, lane 07 PL-3: an index only) apply.
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(5);
    expect(db.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);

    const raw = new Database(dbPath);
    const columns = (table: string) =>
      (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number; notnull: number }[]).map(
        (column) => [column.name, column.pk, column.notnull],
      );
    expect(columns("component_text_cache")).toEqual([
      ["repo_root", 1, 1],
      ["component_id", 2, 1],
      ["content_hash", 3, 1],
      ["purpose", 0, 0],
      ["role", 0, 1],
      ["model", 0, 1],
      ["created_at", 0, 1],
    ]);
    expect(columns("overview_state")).toEqual([
      ["repo_root", 1, 0],
      ["snapshot_json", 0, 1],
      ["narrative_inputs_hash", 0, 0],
      ["narrative_json", 0, 0],
      ["updated_at", 0, 1],
    ]);
    expect(raw.prepare("SELECT version FROM schema_version ORDER BY version").all()).toEqual(
      MIGRATIONS.map((migration) => ({ version: migration.version })),
    );
    raw.close();

    // Rows written at v4 are untouched and the session's seq continues gaplessly.
    expect(db.listEvents("sess_v4").map((event) => [event.seq, event.type])).toEqual([[1, "agent_event"]]);
    const appended = db.appendEvent(
      "sess_v4",
      "overview_snapshot",
      makeOverviewSnapshot({ sessionId: "sess_v4", repoRoot: "/work/v4" }),
    );
    expect(appended.seq).toBe(2);
    expect(db.getSession("sess_v4")?.lastEventSeq).toBe(2);
    db.putComponentText("/work/v4", "cmp_0123456789ab", "1".repeat(40), { purpose: "Core logic.", role: "domain", model: "m" });
    db.close();

    const reopened = openDb({ dbPath });
    expect(reopened.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    expect(reopened.getComponentText("/work/v4", "cmp_0123456789ab", "1".repeat(40))?.purpose).toBe("Core logic.");
    reopened.close();
  });

  it("upgrades a v5 database to v6: an index the latest-Jev-decisions read uses for its filter and order (PL-3)", () => {
    const dbPath = tempDbPath();
    const TS0 = "2026-10-01T00:00:00.000Z";
    const query = "SELECT payloadJson FROM jev_decisions WHERE sessionId = ? ORDER BY seq DESC LIMIT ?";
    const plan = (raw: Database.Database): string[] =>
      (raw.prepare(`EXPLAIN QUERY PLAN ${query}`).all("sess_v5", 50) as { detail: string }[]).map((row) => row.detail);
    const v5 = new Database(dbPath);
    v5.exec("CREATE TABLE schema_version (version INTEGER NOT NULL, appliedAt TEXT NOT NULL)");
    for (const migration of MIGRATIONS) {
      if (migration.version > 5) continue;
      v5.transaction(() => {
        migration.up(v5);
        v5.prepare("INSERT INTO schema_version (version, appliedAt) VALUES (?, ?)").run(migration.version, TS0);
      })();
    }
    // At v5 the read sorts every row of the session.
    expect(plan(v5).some((detail) => detail.includes("TEMP B-TREE"))).toBe(true);
    v5.close();

    const db = openDb({ dbPath });
    expect(db.schemaVersion()).toBe(6);
    db.upsertRepository({ id: "repo_v5", path: "/work/v5", gitRoot: "/work/v5" });
    db.createSession({ id: "sess_v5", repoId: "repo_v5" });
    for (const id of ["jev_a", "jev_b", "jev_c"]) {
      db.upsertJevDecision(makeJevLog({ id, sessionId: "sess_v5", ts: TS0 }));
    }
    // Same rows and order as before the index: the latest by seq first.
    expect(db.latestJevDecisions("sess_v5", 2).map((log) => log.id)).toEqual(["jev_c", "jev_b"]);
    db.close();

    const raw = new Database(dbPath);
    const indexColumns = (raw.prepare("PRAGMA index_info(idx_jev_decisions_session_seq)").all() as { name: string }[]).map(
      (column) => column.name,
    );
    expect(indexColumns).toEqual(["sessionId", "seq"]);
    expect(plan(raw).join(" | ")).toContain("USING INDEX idx_jev_decisions_session_seq");
    expect(plan(raw).some((detail) => detail.includes("TEMP B-TREE"))).toBe(false);
    // Idempotent: running v6 again changes nothing.
    MIGRATIONS.find((migration) => migration.version === 6)?.up(raw);
    expect(
      raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_jev_decisions_session_seq'").get(),
    ).toEqual({ n: 1 });
    raw.close();
  });
});

describe("EVENT_TYPES", () => {
  it("re-exports the contracts list instead of keeping a copy", () => {
    expect(EVENT_TYPES).toBe(CONTRACT_EVENT_TYPES);
  });
});

function modeOf(target: string): number {
  return statSync(target).mode & 0o777;
}

describe.skipIf(process.platform === "win32")("openDb file modes (POSIX)", () => {
  const roots: string[] = [];
  const makeRoot = (): string => {
    const root = mkdtempSync(path.join(os.tmpdir(), "jevcode-modes-"));
    roots.push(root);
    return root;
  };
  const savedHome = process.env.HOME;
  const savedDb = process.env.JEVCODE_DB;

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedDb === undefined) delete process.env.JEVCODE_DB;
    else process.env.JEVCODE_DB = savedDb;
    while (roots.length > 0) {
      const root = roots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates a missing parent directory 0700 and the db, -wal and -shm files 0600", () => {
    const dir = path.join(makeRoot(), "nested", "store");
    const dbPath = path.join(dir, "jevcode.db");
    const db = openDb({ dbPath });
    db.setPreference("probe", { v: 1 });
    expect(modeOf(dir)).toBe(0o700);
    expect(modeOf(dbPath)).toBe(0o600);
    expect(modeOf(`${dbPath}-wal`)).toBe(0o600);
    expect(modeOf(`${dbPath}-shm`)).toBe(0o600);
    db.close();
  });

  it("tightens an existing ~/.jevcode and its 0644 database files on open", () => {
    const home = makeRoot();
    process.env.HOME = home;
    delete process.env.JEVCODE_DB;
    const dataDir = path.join(home, ".jevcode");
    mkdirSync(dataDir, { mode: 0o755 });
    chmodSync(dataDir, 0o755);
    const dbPath = path.join(dataDir, "jevcode.db");
    const legacy = new Database(dbPath);
    legacy.pragma("journal_mode = WAL");
    legacy.exec("CREATE TABLE legacy (x INTEGER)");
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) chmodSync(file, 0o644);

    const db = openDb();
    expect(db.dbPath).toBe(dbPath);
    expect(modeOf(dataDir)).toBe(0o700);
    expect(modeOf(dbPath)).toBe(0o600);
    expect(modeOf(`${dbPath}-wal`)).toBe(0o600);
    expect(modeOf(`${dbPath}-shm`)).toBe(0o600);
    db.close();
    legacy.close();
  });

  it("never changes the mode of an existing directory it does not own by default", () => {
    const shared = makeRoot();
    chmodSync(shared, 0o755);
    const dbPath = path.join(shared, "custom.db");
    process.env.JEVCODE_DB = dbPath;
    const db = openDb();
    expect(modeOf(shared)).toBe(0o755);
    expect(modeOf(dbPath)).toBe(0o600);
    db.close();
  });

  it("still opens an in-memory database without touching the filesystem", () => {
    const cwdMarker = path.resolve(":memory:");
    const db = openDb({ dbPath: ":memory:" });
    db.setPreference("k", { v: 1 });
    expect(db.getPreference("k")).toEqual({ v: 1 });
    expect(existsSync(cwdMarker)).toBe(false);
    db.close();
  });
});
