import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { TRACE_ROW_TYPES, isTraceRowType } from "@jevcode/contracts";

import {
  REPO,
  SESSION,
  TS,
  makeAgentEvent,
  makeChangeUnit,
  makeDecision,
  makeExplainerStory,
  makeFact,
  makeJevLog,
  makeOverviewSnapshot,
} from "./fixtures.js";
import type { JevcodeDb } from "./index.js";
import { openSessionDb, tempDbPath } from "./test-utils.js";
import { openQueryOnlyConnection, openTraceReader } from "./trace-reader.js";
import type { TraceReader } from "./trace-reader.js";

/** Appends seqs 1-10. The trace-type seqs are 1, 3, 5, 6, 8, 9 and 10. */
function seedMixedSession(db: JevcodeDb): void {
  db.appendAgentEvent(SESSION, { type: "agent_started", sessionId: SESSION, prompt: "Seed", ts: TS });
  db.appendTelemetry("agent_event_count", {}, SESSION);
  db.appendEvidenceFact(SESSION, makeFact());
  db.upsertUiSnapshot(SESSION, {
    surfaceId: "surf_1",
    spec: { root: "r", elements: { r: { type: "Terminal", props: {} } } },
  });
  db.upsertChangeUnit(makeChangeUnit());
  db.upsertDecision(makeDecision());
  db.upsertGraphNode(SESSION, { id: "node_1", nodeType: "File", payload: { path: "src/a.ts" } });
  db.upsertJevDecision(makeJevLog());
  db.appendAgentEvent(SESSION, makeAgentEvent({ text: "done" }));
  db.appendAgentEvent(SESSION, { type: "agent_completed", sessionId: SESSION, ts: TS });
}

/** The trace-type seqs the writer stored, ascending. */
function traceSeqs(db: JevcodeDb, sessionId: string): number[] {
  return db
    .listEvents(sessionId, { limit: 100_000 })
    .filter((event) => isTraceRowType(event.type))
    .map((event) => event.seq);
}

/** Pages with the paging contract: afterSeq = last row seq when the page is full, else lastSeq. */
function readAll(reader: TraceReader, sessionId: string, limit: number): number[] {
  const seqs: number[] = [];
  let afterSeq = 0;
  for (let guard = 0; guard < 1_000; guard += 1) {
    const page = reader.rows(sessionId, afterSeq, limit, TRACE_ROW_TYPES);
    seqs.push(...page.rows.map((row) => row.seq));
    if (!page.full) return seqs;
    afterSeq = page.rows.at(-1)?.seq ?? page.lastSeq;
  }
  throw new Error("readAll did not terminate");
}

describe("openTraceReader", () => {
  it("pages trace-type rows exactly once and never returns hidden types", () => {
    const db = openSessionDb();
    seedMixedSession(db);
    const reader = openTraceReader(db.dbPath);
    expect(traceSeqs(db, SESSION)).toEqual([1, 3, 5, 6, 8, 9, 10]);
    for (const limit of [1, 2, 3, 7, 50]) {
      expect(readAll(reader, SESSION, limit)).toEqual([1, 3, 5, 6, 8, 9, 10]);
    }
    const page = reader.rows(SESSION, 0, 50, TRACE_ROW_TYPES);
    expect(page.rows.every((row) => isTraceRowType(row.type))).toBe(true);
    expect(page.rows[0]).toEqual({
      seq: 1,
      type: "agent_event",
      ts: expect.any(String),
      payloadJson: expect.stringContaining('"agent_started"'),
    });
    reader.close();
    db.close();
  });


  it("serves overview_snapshot and explainer rows through rows() and payloads()", () => {
    const db = openSessionDb();
    db.appendAgentEvent(SESSION, { type: "agent_started", sessionId: SESSION, prompt: "Seed", ts: TS });
    db.appendEvent(SESSION, "overview_snapshot", makeOverviewSnapshot());
    db.appendTelemetry("agent_event_count", {}, SESSION);
    db.appendEvent(SESSION, "explainer", makeExplainerStory());
    const reader = openTraceReader(db.dbPath);
    const page = reader.rows(SESSION, 0, 50, TRACE_ROW_TYPES);
    expect(page.rows.map((row) => [row.seq, row.type])).toEqual([
      [1, "agent_event"],
      [2, "overview_snapshot"],
      [4, "explainer"],
    ]);
    expect(page.lastSeq).toBe(4);
    expect(JSON.parse(page.rows[1]?.payloadJson ?? "null")).toEqual(makeOverviewSnapshot());
    expect(reader.payloads(SESSION, [2, 4]).map((row) => row.type)).toEqual(["overview_snapshot", "explainer"]);
    reader.close();
    db.close();
  });
  it("pages stay gapless while the writer appends", () => {
    const db = openSessionDb();
    for (let i = 0; i < 5; i += 1) {
      db.appendAgentEvent(SESSION, makeAgentEvent({ text: `seed ${i}` }));
    }
    const reader = openTraceReader(db.dbPath);
    const seen: number[] = [];
    let afterSeq = 0;
    let appendsLeft = 6;
    for (let guard = 0; guard < 100; guard += 1) {
      const page = reader.rows(SESSION, afterSeq, 3, TRACE_ROW_TYPES);
      seen.push(...page.rows.map((row) => row.seq));
      const full = page.full;
      afterSeq = full ? (page.rows.at(-1)?.seq ?? page.lastSeq) : page.lastSeq;
      if (appendsLeft > 0) {
        appendsLeft -= 1;
        db.appendTelemetry("tick", { left: appendsLeft }, SESSION);
        db.appendAgentEvent(SESSION, makeAgentEvent({ text: `live ${appendsLeft}` }));
        continue;
      }
      if (!full) break;
    }
    expect(appendsLeft).toBe(0);
    expect(seen).toHaveLength(11);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(traceSeqs(db, SESSION));
    reader.close();
    db.close();
  });

  it("returns a page window with the session's lastSeq and state", () => {
    const db = openSessionDb();
    seedMixedSession(db);
    db.setSessionState(SESSION, "running");
    const reader = openTraceReader(db.dbPath);
    const page = reader.rows(SESSION, 3, 2, TRACE_ROW_TYPES);
    expect(page.rows.map((row) => row.seq)).toEqual([5, 6]);
    expect(page.lastSeq).toBe(10);
    expect(page.state).toBe("running");
    expect(page.full).toBe(true);
    expect(reader.rows(SESSION, 8, 5, TRACE_ROW_TYPES).full).toBe(false);
    expect(reader.rows(SESSION, 10, 5, TRACE_ROW_TYPES).rows).toEqual([]);
    expect(reader.rows(SESSION, 0, 5, ["telemetry"]).rows.map((row) => row.seq)).toEqual([2]);
    reader.close();
    db.close();
  });

  it("stops a page after the row whose payload bytes pass 2 MiB", () => {
    const db = openSessionDb();
    // "é" is one UTF-16 code unit but two UTF-8 bytes: each wide message
    // stores about 1.2 MiB of payload JSON in 0.6 Mi code units.
    const wide = "é".repeat(600 * 1024);
    db.appendAgentEvent(SESSION, makeAgentEvent({ text: wide }));
    db.appendAgentEvent(SESSION, makeAgentEvent({ text: wide }));
    db.appendAgentEvent(SESSION, makeAgentEvent({ text: "small" }));
    db.appendAgentEvent(SESSION, makeAgentEvent({ text: "x".repeat(3 * 1024 * 1024) }));
    db.appendAgentEvent(SESSION, makeAgentEvent({ text: "last" }));
    const reader = openTraceReader(db.dbPath);
    const pages = [0, 2, 3, 4].map((afterSeq) => reader.rows(SESSION, afterSeq, 50, TRACE_ROW_TYPES));
    expect(pages.map((page) => [page.rows.map((row) => row.seq), page.full])).toEqual([
      [[1, 2], true], // about 2.4 MiB of UTF-8 in 1.2 Mi code units: the bound counts bytes
      [[3, 4], true], // the 3 MiB row passes the bound and ends the page
      [[4], true], // a row over 2 MiB on its own still makes a page
      [[5], false],
    ]);
    expect(readAll(reader, SESSION, 50)).toEqual([1, 2, 3, 4, 5]);
    reader.close();
    db.close();
  });

  it("returns rows of any type for requested seqs and omits unknown ones", () => {
    const db = openSessionDb();
    seedMixedSession(db);
    db.createSession({ id: "sess_other", repoId: REPO });
    db.appendAgentEvent("sess_other", makeAgentEvent({ sessionId: "sess_other" }));
    const reader = openTraceReader(db.dbPath);
    expect(reader.payloads(SESSION, [7, 2, 99, 2]).map((row) => [row.seq, row.type])).toEqual([
      [2, "telemetry"],
      [7, "graph_node"],
    ]);
    expect(reader.payloads("sess_other", [2])).toEqual([]);
    expect(reader.payloads(SESSION, [])).toEqual([]);
    reader.close();
    db.close();
  });

  it("lists sessions with events across repositories, newest first, ties by id", () => {
    const db = openSessionDb();
    db.upsertRepository({ id: "repo_other", path: "/work/other", gitRoot: "/work/other" });
    db.createSession({ id: "sess_b", repoId: "repo_other", prompt: "B" });
    db.createSession({ id: "sess_a", repoId: REPO, prompt: "A" });
    db.createSession({ id: "sess_empty", repoId: REPO });
    db.appendAgentEvent("sess_b", makeAgentEvent({ sessionId: "sess_b" }));
    db.appendAgentEvent("sess_a", makeAgentEvent({ sessionId: "sess_a" }));
    db.appendAgentEvent(SESSION, makeAgentEvent());
    const raw = new Database(db.dbPath);
    raw
      .prepare("UPDATE sessions SET startedAt = ? WHERE id IN ('sess_a', 'sess_b')")
      .run("2026-09-02T00:00:00.000Z");
    raw
      .prepare("UPDATE sessions SET startedAt = ? WHERE id = ?")
      .run("2026-09-01T00:00:00.000Z", SESSION);
    raw.close();
    const reader = openTraceReader(db.dbPath);
    const all = reader.listSessions({ limit: 10 });
    expect(all.map((session) => session.sessionId)).toEqual(["sess_a", "sess_b", SESSION]);
    expect(all[1]).toEqual({
      sessionId: "sess_b",
      repoId: "repo_other",
      repoName: "other",
      prompt: "B",
      state: "starting",
      startedAt: "2026-09-02T00:00:00.000Z",
      endedAt: null,
      lastEventSeq: 1,
    });
    expect(
      reader.listSessions({ repoId: "repo_other", limit: 10 }).map((session) => session.sessionId),
    ).toEqual(["sess_b"]);
    expect(reader.listSessions({ limit: 1 }).map((session) => session.sessionId)).toEqual([
      "sess_a",
    ]);
    expect(reader.getSession("sess_empty")).toMatchObject({
      sessionId: "sess_empty",
      lastEventSeq: 0,
    });
    expect(reader.getSession("sess_missing")).toBeUndefined();
    reader.close();
    db.close();
  });

  it("lists a zero-event session by exact id", () => {
    const db = openSessionDb();
    db.upsertRepository({ id: "repo_other", path: "/work/other", gitRoot: "/work/other" });
    db.createSession({ id: "sess_b", repoId: "repo_other", prompt: "B" });
    db.appendAgentEvent("sess_b", makeAgentEvent({ sessionId: "sess_b" }));
    const reader = openTraceReader(db.dbPath);
    expect(reader.listSessions({ sessionId: SESSION, limit: 1 })).toEqual([
      expect.objectContaining({ sessionId: SESSION, repoId: REPO, repoName: "fixture", lastEventSeq: 0 }),
    ]);
    expect(reader.listSessions({ limit: 10 }).map((session) => session.sessionId)).toEqual(["sess_b"]);
    expect(
      reader.listSessions({ sessionId: "sess_b", repoId: "repo_other", limit: 1 }).map((session) => session.sessionId),
    ).toEqual(["sess_b"]);
    expect(reader.listSessions({ sessionId: "sess_b", repoId: REPO, limit: 1 })).toEqual([]);
    expect(reader.listSessions({ sessionId: "sess_missing", limit: 1 })).toEqual([]);
    expect(() => reader.listSessions({ sessionId: SESSION, limit: 0 })).toThrow(RangeError);
    reader.close();
    db.close();
  });

  it("rejects an unknown session, a bad window and a missing file", () => {
    const db = openSessionDb();
    const reader = openTraceReader(db.dbPath);
    expect(() => reader.rows("sess_missing", 0, 10, TRACE_ROW_TYPES)).toThrow(
      /unknown session sess_missing/,
    );
    expect(() => reader.rows(SESSION, 0, 0, TRACE_ROW_TYPES)).toThrow(RangeError);
    expect(() => reader.rows(SESSION, -1, 10, TRACE_ROW_TYPES)).toThrow(RangeError);
    expect(() => reader.listSessions({ limit: 0 })).toThrow(RangeError);
    expect(() => openTraceReader(tempDbPath())).toThrow();
    expect(() => openTraceReader(":memory:")).toThrow(TypeError);
    reader.close();
    db.close();
  });

  it("exposes no write surface and its connection refuses writes", () => {
    const db = openSessionDb();
    const reader = openTraceReader(db.dbPath);
    expect(Object.keys(reader).sort()).toEqual([
      "close",
      "dbPath",
      "getSession",
      "listSessions",
      "payloads",
      "rows",
    ]);
    const connection = openQueryOnlyConnection(db.dbPath);
    expect(connection.pragma("query_only", { simple: true })).toBe(1);
    expect(() =>
      connection
        .prepare(
          "INSERT INTO repositories (id, path, gitRoot, name, lastOpenedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("repo_x", "/x", "/x", "x", TS, TS),
    ).toThrow(/readonly|query_only/);
    expect(() =>
      connection.prepare("UPDATE sessions SET state = 'failed' WHERE id = ?").run(SESSION),
    ).toThrow(/readonly|query_only/);
    connection.close();
    expect(db.getSession(SESSION)?.state).toBe("starting");
    expect(db.getRepository("repo_x")).toBeUndefined();
    reader.close();
    db.close();
  });
});
