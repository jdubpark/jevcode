import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { TRACE_ROW_TYPES } from "@jevcode/contracts";
import type { EvidenceFact, TraceSessionSummary } from "@jevcode/contracts";
import { factContentId } from "@jevcode/semantic-core";
import { openDb, openTraceReader } from "@jevcode/storage";
import type {
  JevcodeDb,
  ListTraceSessionsOptions,
  TraceReader,
  TraceReaderRow,
} from "@jevcode/storage";
import { afterEach, describe, expect, it } from "vitest";

import { IpcError } from "../shared/errors.js";
import { clipPayload, createTraceService, readAllRows, toTraceRow } from "./trace-service.js";

const SESSION = "sess_trace";
const REPO = "repo_trace";
const TS = "2026-09-28T10:00:00.000Z";

const tempDirs: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  while (closers.length > 0) closers.pop()?.();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function seededStore(): { db: JevcodeDb; reader: TraceReader } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jevcode-trace-service-"));
  tempDirs.push(dir);
  const db = openDb({ dbPath: path.join(dir, "trace.db") });
  db.upsertRepository({ id: REPO, path: "/work/trace", gitRoot: "/work/trace" });
  db.createSession({ id: SESSION, repoId: REPO, prompt: "Trace me" });
  const reader = openTraceReader(db.dbPath);
  closers.push(() => {
    reader.close();
    db.close();
  });
  return { db, reader };
}

function commandFact(command: string, exitCode: number): EvidenceFact {
  return {
    type: "command_executed",
    repoId: REPO,
    sessionId: SESSION,
    command,
    exitCode,
    isDestructive: false,
    ts: TS,
  };
}

interface FakeReader extends TraceReader {
  listCalls: ListTraceSessionsOptions[];
  rowCalls: Array<{ afterSeq: number; limit: number; types: readonly string[] }>;
}

function fakeReader(rows: TraceReaderRow[] = []): FakeReader {
  const summary: TraceSessionSummary = {
    sessionId: SESSION,
    repoId: REPO,
    repoName: "trace",
    prompt: "Trace me",
    state: "running",
    startedAt: TS,
    endedAt: null,
    lastEventSeq: rows.at(-1)?.seq ?? 0,
  };
  const listCalls: FakeReader["listCalls"] = [];
  const rowCalls: FakeReader["rowCalls"] = [];
  return {
    dbPath: "fake.db",
    listCalls,
    rowCalls,
    listSessions: (options) => {
      listCalls.push(options);
      return [summary];
    },
    getSession: (sessionId) => (sessionId === SESSION ? summary : undefined),
    rows: (_sessionId, afterSeq, limit, types) => {
      rowCalls.push({ afterSeq, limit, types });
      const page = rows.filter((row) => row.seq > afterSeq).slice(0, limit);
      return {
        rows: page,
        lastSeq: summary.lastEventSeq,
        state: summary.state,
        full: page.length === limit,
      };
    },
    payloads: () => [],
    close: () => undefined,
  };
}

describe("trace service", () => {
  it("attaches factId to evidence rows only, computed from the stored payload", () => {
    const { db, reader } = seededStore();
    db.appendAgentEvent(SESSION, { type: "agent_started", sessionId: SESSION, prompt: "Trace me", ts: TS });
    db.appendEvidenceFact(SESSION, commandFact("pnpm test", 1));
    db.appendTelemetry("fact_count", {}, SESSION);
    const page = createTraceService(reader).rows({ sessionId: SESSION });
    expect(page.rows.map((row) => row.type)).toEqual(["agent_event", "evidence_fact"]);
    expect(page).toMatchObject({ nextAfterSeq: null, lastSeq: 3, state: "starting" });
    const stored = db.listEvents(SESSION).find((event) => event.type === "evidence_fact");
    const [agentRow, factRow] = page.rows;
    expect(factRow?.factId).toBe(factContentId(SESSION, JSON.parse(stored?.payloadJson ?? "null")));
    expect(factRow?.factId).toMatch(/^fact_[0-9a-f]{16}$/);
    expect(agentRow !== undefined && "factId" in agentRow).toBe(false);
    expect(page.rows.some((row) => "clipped" in row)).toBe(false);
  });

  it("clips a 20 KiB stdout to a 4 KiB head and a 12 KiB tail", () => {
    const { db, reader } = seededStore();
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    const stdout = alphabet.repeat(Math.ceil((20 * 1024) / alphabet.length)).slice(0, 20 * 1024);
    db.appendAgentEvent(SESSION, {
      type: "command_completed",
      sessionId: SESSION,
      command: "cat big.log",
      exitCode: 0,
      stdout,
      stderr: "",
      ts: TS,
    });
    db.appendEvidenceFact(SESSION, {
      type: "test_result",
      repoId: REPO,
      sessionId: SESSION,
      runner: "vitest",
      command: "pnpm test",
      passed: 0,
      failed: 1,
      skipped: 0,
      failures: [{ file: "big.test.ts", testName: "big", message: "x".repeat(40 * 1024) }],
      ts: TS,
    });
    const service = createTraceService(reader);
    const [commandRow, factRow] = service.rows({ sessionId: SESSION }).rows;
    const payload = commandRow?.payload as { command: string; stdout: string };
    expect(commandRow?.clipped).toBe(true);
    expect(payload.command).toBe("cat big.log");
    // 20,480 bytes = 4,096 head + 4,096 clipped + 12,288 tail.
    expect(payload.stdout).toBe(
      `${stdout.slice(0, 4096)}\n… [4096 bytes clipped] …\n${stdout.slice(-12_288)}`,
    );
    const stored = db.listEvents(SESSION).find((event) => event.type === "evidence_fact");
    expect(factRow?.clipped).toBe(true);
    expect(factRow?.factId).toBe(factContentId(SESSION, JSON.parse(stored?.payloadJson ?? "null")));
    const [unclipped] = service.rows({ sessionId: SESSION }, { clip: false }).rows;
    expect((unclipped?.payload as { stdout: string }).stdout).toBe(stdout);
    expect(unclipped !== undefined && "clipped" in unclipped).toBe(false);
  });

  it("passes a git_hunk's 30 KiB diff.text through whole and clips the same text elsewhere", () => {
    const { db, reader } = seededStore();
    const hunkLine = "+export const answer = 42;\n";
    const text =
      "diff --git a/src/big.ts b/src/big.ts\n--- a/src/big.ts\n+++ b/src/big.ts\n@@ -0,0 +1,1180 @@\n" +
      hunkLine.repeat(1_180);
    expect(text.length).toBeGreaterThan(30 * 1024);
    db.appendEvidenceFact(SESSION, {
      type: "git_hunk",
      repoId: REPO,
      sessionId: SESSION,
      file: "src/big.ts",
      added: 1_180,
      removed: 0,
      isFormattingOnly: false,
      isConfigOnly: false,
      isLockfile: false,
      diff: { hash: "0123456789abcdef", bytes: text.length, text, truncated: false, redactions: 0 },
      ts: TS,
    });
    db.appendAgentEvent(SESSION, {
      type: "agent_message",
      sessionId: SESSION,
      role: "assistant",
      text,
      ts: TS,
    });
    // The diff is redacted and capped at 32 KiB when stored (spec §4.3), so
    // Evidence gets it byte for byte; the same text as a message is clipped.
    const [hunkRow, messageRow] = createTraceService(reader).rows({ sessionId: SESSION }).rows;
    expect((hunkRow?.payload as { diff: { text: string } }).diff.text).toBe(text);
    expect(hunkRow !== undefined && "clipped" in hunkRow).toBe(false);
    expect(messageRow?.clipped).toBe(true);
  });

  it("clipPayload keeps short payloads by reference and cuts long strings around a marker", () => {
    const short = { a: "x", list: ["y"] };
    expect(clipPayload(short).payload).toBe(short);
    expect(clipPayload(short).clipped).toBe(false);
    const long = { nested: [{ text: "abcdefghijklmnopqrstuvwxyz" }], keep: "ok" };
    expect(clipPayload(long, 16)).toEqual({
      payload: { nested: [{ text: "abcd\n… [10 bytes clipped] …\nopqrstuvwxyz" }], keep: "ok" },
      clipped: true,
    });
    expect(long.nested[0]?.text).toBe("abcdefghijklmnopqrstuvwxyz");
    expect(() => clipPayload("abc", 3)).toThrow(RangeError);
  });

  it("measures the 16 KiB bound in UTF-8 bytes and cuts at code-point boundaries", () => {
    const exact = "a".repeat(16 * 1024);
    expect(clipPayload(exact)).toEqual({ payload: exact, clipped: false });
    // 9,000 "é" are 9,000 UTF-16 code units but 18,000 UTF-8 bytes.
    expect(clipPayload("é".repeat(9_000))).toEqual({
      payload: `${"é".repeat(2_048)}\n… [1616 bytes clipped] …\n${"é".repeat(6_144)}`,
      clipped: true,
    });
    // maxBytes 16: a 4-byte head and a 12-byte tail. "😀" (4 bytes) does not
    // fit after "abc", and "é" (2 bytes) does not fit before the three emoji.
    expect(clipPayload(`abc😀${"x".repeat(20)}é😀😀😀`, 16)).toEqual({
      payload: "abc\n… [26 bytes clipped] …\n😀😀😀",
      clipped: true,
    });
    expect(clipPayload(`abé${"x".repeat(20)}`, 16)).toEqual({
      payload: `abé\n… [8 bytes clipped] …\n${"x".repeat(12)}`,
      clipped: true,
    });
  });

  it("turns a damaged payload row into a row without payload and keeps its neighbors", () => {
    const damaged = toTraceRow(SESSION, { seq: 4, type: "evidence_fact", ts: TS, payloadJson: '{"type":' });
    expect(damaged).toEqual({ seq: 4, type: "evidence_fact", ts: TS });
    expect("payload" in damaged).toBe(false);
    expect("factId" in damaged).toBe(false);
    const service = createTraceService(
      fakeReader([
        {
          seq: 1,
          type: "agent_event",
          ts: TS,
          payloadJson: JSON.stringify({ type: "agent_waiting", sessionId: SESSION, ts: TS }),
        },
        { seq: 2, type: "agent_event", ts: TS, payloadJson: "not json" },
        {
          seq: 3,
          type: "agent_event",
          ts: TS,
          payloadJson: JSON.stringify({ type: "agent_completed", sessionId: SESSION, ts: TS }),
        },
      ]),
    );
    const page = service.rows({ sessionId: SESSION });
    expect(page.rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(page.rows.map((row) => "payload" in row)).toEqual([true, false, true]);
  });

  it("defaults and clamps list and page limits and passes an exact sessionId through", () => {
    const reader = fakeReader();
    const service = createTraceService(reader);
    service.listSessions({});
    service.listSessions({ repoId: REPO, limit: 10_000 });
    service.listSessions({ sessionId: SESSION, limit: 1 });
    expect(reader.listCalls).toEqual([
      { limit: 100 },
      { repoId: REPO, limit: 500 },
      { sessionId: SESSION, limit: 1 },
    ]);
    service.rows({ sessionId: SESSION });
    service.rows({ sessionId: SESSION, afterSeq: 7, limit: 99_999 });
    expect(reader.rowCalls).toEqual([
      { afterSeq: 0, limit: 2_000, types: TRACE_ROW_TYPES },
      { afterSeq: 7, limit: 5_000, types: TRACE_ROW_TYPES },
    ]);
  });

  it("throws IpcError UNKNOWN_SESSION for a missing session", () => {
    const service = createTraceService(fakeReader());
    const calls = [
      () => service.session("sess_missing"),
      () => service.rows({ sessionId: "sess_missing" }),
      () => service.payloads({ sessionId: "sess_missing", seqs: [1] }),
    ];
    for (const call of calls) {
      expect(call).toThrowError(IpcError);
      expect(call).toThrowError(/sess_missing/);
      try {
        call();
      } catch (error) {
        expect(error).toMatchObject({ code: "UNKNOWN_SESSION" });
      }
    }
  });

  it("pages with nextAfterSeq and readAllRows returns every trace row", () => {
    const { db, reader } = seededStore();
    db.appendAgentEvent(SESSION, { type: "agent_started", sessionId: SESSION, prompt: "Trace me", ts: TS });
    db.appendTelemetry("agent_event_count", {}, SESSION);
    db.appendEvidenceFact(SESSION, commandFact("pnpm test", 0));
    db.appendAgentEvent(SESSION, { type: "agent_message", sessionId: SESSION, role: "assistant", text: "one", ts: TS });
    db.appendTelemetry("agent_event_count", {}, SESSION);
    db.appendAgentEvent(SESSION, { type: "agent_message", sessionId: SESSION, role: "assistant", text: "two", ts: TS });
    db.appendAgentEvent(SESSION, { type: "agent_completed", sessionId: SESSION, ts: TS });
    const service = createTraceService(reader);
    const first = service.rows({ sessionId: SESSION, limit: 2 });
    expect(first.rows.map((row) => row.seq)).toEqual([1, 3]);
    expect(first.nextAfterSeq).toBe(3);
    const last = service.rows({ sessionId: SESSION, afterSeq: 6, limit: 2 });
    expect(last.rows.map((row) => row.seq)).toEqual([7]);
    expect(last.nextAfterSeq).toBeNull();
    expect(last.lastSeq).toBe(7);
    for (const pageSize of [2, 5, 5_000]) {
      const all = readAllRows(service, SESSION, pageSize);
      expect(all.rows.map((row) => row.seq)).toEqual([1, 3, 4, 6, 7]);
      expect(all.lastSeq).toBe(7);
      expect(all.state).toBe("starting");
    }
  });

  it("payloads returns any row type with factId and clipping applied", () => {
    const { db, reader } = seededStore();
    db.appendTelemetry("agent_event_count", {}, SESSION);
    db.appendEvidenceFact(SESSION, commandFact("x".repeat(20_000), 1));
    const rows = createTraceService(reader).payloads({ sessionId: SESSION, seqs: [2, 1, 42] });
    expect(rows.map((row) => [row.seq, row.type])).toEqual([
      [1, "telemetry"],
      [2, "evidence_fact"],
    ]);
    expect(rows[1]?.clipped).toBe(true);
    expect(rows[1]?.factId).toMatch(/^fact_[0-9a-f]{16}$/);
    expect(rows[0] !== undefined && "factId" in rows[0]).toBe(false);
  });
});
