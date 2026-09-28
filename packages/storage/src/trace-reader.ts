import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";

import type { TraceSessionSummary } from "@jevcode/contracts";

export interface TraceReaderRow {
  seq: number;
  type: string;
  ts: string;
  payloadJson: string;
}

export interface TraceReaderPage {
  rows: TraceReaderRow[];
  lastSeq: number;
  state: TraceSessionSummary["state"];
  /** True when the page stopped at `limit` rows or at the 2 MiB payload bound; the caller resumes after its last row. */
  full: boolean;
}

export interface ListTraceSessionsOptions {
  repoId?: string;
  /** Exact-id lookup: at most that one session, returned even with zero events (spec §5.2). */
  sessionId?: string;
  limit: number;
}

export interface TraceReader {
  readonly dbPath: string;
  /** Joins repositories; ORDER BY startedAt DESC, id ASC. Hides sessions with lastEventSeq = 0 unless sessionId is given. */
  listSessions(options: ListTraceSessionsOptions): TraceSessionSummary[];
  getSession(sessionId: string): TraceSessionSummary | undefined;
  /**
   * One read transaction: session row, then seq > afterSeq AND seq <= lastEventSeq AND type IN (types)
   * ORDER BY seq LIMIT limit, stopping after the row whose cumulative payloadJson passes 2 MiB of UTF-8.
   */
  rows(sessionId: string, afterSeq: number, limit: number, types: readonly string[]): TraceReaderPage;
  /** Rows of any type for the given seqs, ascending; unknown seqs omitted. */
  payloads(sessionId: string, seqs: readonly number[]): TraceReaderRow[];
  close(): void;
}

const SUMMARY_SELECT =
  "SELECT s.id AS sessionId, s.repoId AS repoId, COALESCE(r.name, '') AS repoName, " +
  "s.prompt AS prompt, s.state AS state, s.startedAt AS startedAt, s.endedAt AS endedAt, " +
  "s.lastEventSeq AS lastEventSeq FROM sessions s LEFT JOIN repositories r ON r.id = s.repoId";

const LIST_ORDER = "ORDER BY s.startedAt DESC, s.id ASC LIMIT ?";

/**
 * A rows() page stops after the row whose cumulative payloadJson passes this
 * many UTF-8 bytes (spec §5.2). Real agent rows average about 12 KB, so 5,000
 * of them would otherwise make one page of about 60 MB. A page always holds at
 * least one row, so a single larger row still arrives.
 */
const PAGE_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

function requireInteger(label: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`trace reader: ${label} must be an integer >= ${min}, got ${String(value)}`);
  }
}

/** A second connection: new Database(dbPath, { fileMustExist: true }), busy_timeout = 5000, PRAGMA query_only = ON. */
export function openQueryOnlyConnection(dbPath: string): BetterSqlite3.Database {
  if (dbPath === "" || dbPath === ":memory:") {
    throw new TypeError("trace reader: needs a database file path, not an in-memory database");
  }
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("query_only = ON");
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

export function openTraceReader(dbPath: string): TraceReader {
  const db = openQueryOnlyConnection(dbPath);
  const listAll = db.prepare(`${SUMMARY_SELECT} WHERE s.lastEventSeq > 0 ${LIST_ORDER}`);
  const listByRepo = db.prepare(
    `${SUMMARY_SELECT} WHERE s.lastEventSeq > 0 AND s.repoId = ? ${LIST_ORDER}`,
  );
  // Exact-id lookups (spec §5.2) skip the lastEventSeq > 0 filter: the trace
  // window reads its summary this way, also before the agent logs anything.
  const listById = db.prepare(`${SUMMARY_SELECT} WHERE s.id = ? ${LIST_ORDER}`);
  const listByRepoAndId = db.prepare(
    `${SUMMARY_SELECT} WHERE s.repoId = ? AND s.id = ? ${LIST_ORDER}`,
  );
  const getOne = db.prepare(`${SUMMARY_SELECT} WHERE s.id = ?`);
  const head = db.prepare("SELECT lastEventSeq, state FROM sessions WHERE id = ?");
  const pageRows = db.prepare(
    "SELECT seq, type, ts, payloadJson FROM events WHERE sessionId = ? AND seq > ? AND seq <= ? " +
      "AND type IN (SELECT value FROM json_each(?)) ORDER BY seq ASC LIMIT ?",
  );
  const bySeq = db.prepare(
    "SELECT seq, type, ts, payloadJson FROM events WHERE sessionId = ? " +
      "AND seq IN (SELECT value FROM json_each(?)) ORDER BY seq ASC",
  );

  // One deferred read transaction. In WAL mode both SELECTs read the same
  // snapshot, and appendEvent (db.ts) writes the row and lastEventSeq in one
  // write transaction, so a page never runs past lastSeq or skips a row.
  const readPage = db.transaction(
    (sessionId: string, afterSeq: number, limit: number, typesJson: string): TraceReaderPage => {
      const session = head.get(sessionId) as { lastEventSeq: number; state: string } | undefined;
      if (session === undefined) {
        throw new Error(`trace reader: unknown session ${sessionId}`);
      }
      // iterate(), not all(): a page cut by the byte bound never reads the
      // payloads of the rows after the cut.
      const rows: TraceReaderRow[] = [];
      let payloadBytes = 0;
      let full = false;
      const cursor = pageRows.iterate(
        sessionId,
        afterSeq,
        session.lastEventSeq,
        typesJson,
        limit,
      ) as IterableIterator<TraceReaderRow>;
      for (const row of cursor) {
        rows.push(row);
        payloadBytes += Buffer.byteLength(row.payloadJson, "utf8");
        if (payloadBytes > PAGE_MAX_PAYLOAD_BYTES) {
          full = true;
          break;
        }
      }
      return {
        rows,
        lastSeq: session.lastEventSeq,
        state: session.state as TraceSessionSummary["state"],
        full: full || rows.length === limit,
      };
    },
  );

  return {
    dbPath,
    listSessions({ repoId, sessionId, limit }) {
      requireInteger("limit", limit, 1);
      let rows: unknown[];
      if (sessionId !== undefined) {
        rows =
          repoId === undefined
            ? listById.all(sessionId, limit)
            : listByRepoAndId.all(repoId, sessionId, limit);
      } else {
        rows = repoId === undefined ? listAll.all(limit) : listByRepo.all(repoId, limit);
      }
      return rows as TraceSessionSummary[];
    },
    getSession(sessionId) {
      return getOne.get(sessionId) as TraceSessionSummary | undefined;
    },
    rows(sessionId, afterSeq, limit, types) {
      requireInteger("afterSeq", afterSeq, 0);
      requireInteger("limit", limit, 1);
      return readPage(sessionId, afterSeq, limit, JSON.stringify(types));
    },
    payloads(sessionId, seqs) {
      if (seqs.length === 0) return [];
      return bySeq.all(sessionId, JSON.stringify(seqs)) as TraceReaderRow[];
    },
    close() {
      db.close();
    },
  };
}
