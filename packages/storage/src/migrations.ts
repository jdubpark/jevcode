import type BetterSqlite3 from "better-sqlite3";

export interface Migration {
  version: number;
  up: (db: BetterSqlite3.Database) => void;
}

const v1: Migration = {
  version: 1,
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS repositories (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        gitRoot TEXT NOT NULL,
        name TEXT NOT NULL,
        branch TEXT NOT NULL DEFAULT '',
        baseCommit TEXT NOT NULL DEFAULT '',
        lastOpenedAt TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        repoId TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL DEFAULT '',
        baseCommit TEXT NOT NULL DEFAULT '',
        branch TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'starting',
        lastEventSeq INTEGER NOT NULL DEFAULT 0,
        startedAt TEXT NOT NULL,
        endedAt TEXT,
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payloadJson TEXT NOT NULL,
        ts TEXT NOT NULL,
        UNIQUE (sessionId, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events (sessionId, seq);

      CREATE TABLE IF NOT EXISTS agent_events (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payloadJson TEXT NOT NULL,
        ts TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_events_session_seq ON agent_events (sessionId, seq);

      CREATE TABLE IF NOT EXISTS evidence_facts (
        id TEXT PRIMARY KEY,
        repoId TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payloadJson TEXT NOT NULL,
        ts TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_evidence_facts_session_seq ON evidence_facts (sessionId, seq);

      CREATE TABLE IF NOT EXISTS change_units (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL,
        intent TEXT,
        category TEXT NOT NULL,
        status TEXT NOT NULL,
        behaviorBefore TEXT,
        behaviorAfter TEXT,
        filesJson TEXT NOT NULL,
        symbolsJson TEXT NOT NULL,
        interfacesChangedJson TEXT NOT NULL,
        schemaChangesJson TEXT NOT NULL,
        dependencyChangesJson TEXT NOT NULL,
        relatedDecisionsJson TEXT NOT NULL,
        validationResultsJson TEXT NOT NULL,
        blastRadiusJson TEXT,
        importance REAL,
        relevance REAL,
        interruption REAL,
        uncertainty REAL,
        mentalModelChange REAL,
        evidenceJson TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_change_units_session ON change_units (sessionId, updatedAt);

      CREATE TABLE IF NOT EXISTS change_unit_files (
        changeUnitId TEXT NOT NULL,
        file TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        PRIMARY KEY (changeUnitId, file)
      );

      CREATE TABLE IF NOT EXISTS change_unit_symbols (
        changeUnitId TEXT NOT NULL,
        symbolId TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        kind TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        PRIMARY KEY (changeUnitId, symbolId)
      );

      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL,
        context TEXT NOT NULL,
        severity TEXT NOT NULL,
        status TEXT NOT NULL,
        affectedChangeUnitsJson TEXT NOT NULL,
        evidenceJson TEXT NOT NULL,
        answerJson TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions (sessionId, updatedAt);

      CREATE TABLE IF NOT EXISTS decision_options (
        decisionId TEXT NOT NULL,
        optionId TEXT NOT NULL,
        label TEXT NOT NULL,
        description TEXT NOT NULL,
        tradeoffsJson TEXT,
        PRIMARY KEY (decisionId, optionId)
      );

      CREATE TABLE IF NOT EXISTS validations (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        kind TEXT NOT NULL,
        command TEXT NOT NULL,
        status TEXT NOT NULL,
        passed INTEGER NOT NULL,
        failed INTEGER NOT NULL,
        skipped INTEGER NOT NULL,
        ts TEXT NOT NULL,
        payloadJson TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_validations_session ON validations (sessionId, ts);

      CREATE TABLE IF NOT EXISTS failures (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        validationId TEXT NOT NULL,
        file TEXT NOT NULL,
        testName TEXT NOT NULL,
        message TEXT NOT NULL,
        ts TEXT NOT NULL,
        payloadJson TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_failures_session ON failures (sessionId);
      CREATE INDEX IF NOT EXISTS idx_failures_validation ON failures (validationId);

      CREATE TABLE IF NOT EXISTS jev_decisions (
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
      CREATE INDEX IF NOT EXISTS idx_jev_decisions_session ON jev_decisions (sessionId, ts);

      CREATE TABLE IF NOT EXISTS ui_intents (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0,
        changeUnitId TEXT NOT NULL,
        intentJson TEXT NOT NULL,
        ts TEXT NOT NULL,
        payloadJson TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ui_intents_session ON ui_intents (sessionId, changeUnitId);

      CREATE TABLE IF NOT EXISTS ui_snapshots (
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
      CREATE INDEX IF NOT EXISTS idx_ui_snapshots_session ON ui_snapshots (sessionId, ts);

      CREATE TABLE IF NOT EXISTS graph_nodes (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        nodeType TEXT NOT NULL,
        payloadJson TEXT NOT NULL,
        ts TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_session ON graph_nodes (sessionId);

      CREATE TABLE IF NOT EXISTS graph_edges (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        fromId TEXT NOT NULL,
        toId TEXT NOT NULL,
        edgeType TEXT NOT NULL,
        payloadJson TEXT,
        ts TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_graph_edges_session ON graph_edges (sessionId);

      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0,
        command TEXT NOT NULL,
        exitCode INTEGER,
        isDestructive INTEGER NOT NULL DEFAULT 0,
        ts TEXT NOT NULL,
        payloadJson TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_commands_session ON commands (sessionId, seq);

      CREATE TABLE IF NOT EXISTS telemetry_events (
        id TEXT PRIMARY KEY,
        sessionId TEXT,
        type TEXT NOT NULL,
        payloadJson TEXT NOT NULL,
        ts TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_telemetry_session ON telemetry_events (sessionId, ts);

      CREATE TABLE IF NOT EXISTS preferences (
        key TEXT PRIMARY KEY,
        valueJson TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);
  },
};

const v2: Migration = {
  version: 2,
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_events (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        changeUnitId TEXT,
        evidenceJson TEXT NOT NULL,
        filesJson TEXT NOT NULL,
        symbolsJson TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        ts TEXT NOT NULL,
        payloadJson TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_semantic_events_session ON semantic_events (sessionId, seq);
    `);
  },
};

const v3: Migration = {
  version: 3,
  up: (db) => {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);
      ALTER TABLE ui_snapshots ADD COLUMN semanticEventId TEXT;
    `);
  },
};

const v4: Migration = {
  version: 4,
  up: (db) => {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN execution_claim_ts TEXT;
      ALTER TABLE sessions ADD COLUMN resume_attempts INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE IF NOT EXISTS instruction_inbox (
        sessionId TEXT NOT NULL,
        instructionId TEXT NOT NULL,
        mode TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        seq INTEGER NOT NULL,
        createdAt TEXT NOT NULL,
        deliveredAt TEXT,
        PRIMARY KEY (sessionId, instructionId)
      );
      CREATE INDEX IF NOT EXISTS idx_instruction_inbox_session_status
        ON instruction_inbox (sessionId, status, seq);
    `);
  },
};

export const MIGRATIONS: Migration[] = [v1, v2, v3, v4];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
