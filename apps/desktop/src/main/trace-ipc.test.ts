import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { TraceRow, TraceRowsPage, TraceSessionSummary } from "@jevcode/contracts";
import { openDb, openTraceReader } from "@jevcode/storage";
import type { JevcodeDb } from "@jevcode/storage";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IpcError } from "../shared/errors.js";
import { parseToMain } from "../shared/ipc-registry.js";
import { createRowsReadAhead, registerTraceHandlers } from "./trace-ipc.js";
import type { IpcHandle } from "./trace-ipc.js";
import { createTraceService } from "./trace-service.js";

const SESSION = "sess_ipc";
const OTHER = "sess_other_repo";
const EMPTY = "sess_not_started";
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

/** Mirrors the ipc.ts handle wrapper: zod-parse the raw request, then call the handler. */
function harness(): {
  handle: IpcHandle;
  channels: () => string[];
  invoke: (channel: string, raw: unknown) => Promise<unknown>;
} {
  const handlers = new Map<string, (raw: unknown) => unknown>();
  const handle: IpcHandle = (channel, fn) => {
    handlers.set(channel, (raw) => fn(parseToMain(channel, raw), { senderId: 1 }));
  };
  return {
    handle,
    channels: () => [...handlers.keys()].sort(),
    invoke: async (channel, raw) => {
      const handler = handlers.get(channel);
      if (handler === undefined) throw new Error(`no handler for ${channel}`);
      return await handler(raw);
    },
  };
}

/** Two repositories. SESSION (repo_open, running): seq 1 agent_started, 2 evidence_fact, 3 telemetry, one pending instruction. */
function seeded(): { db: JevcodeDb; ipc: ReturnType<typeof harness> } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jevcode-trace-ipc-"));
  tempDirs.push(dir);
  const db = openDb({ dbPath: path.join(dir, "trace.db") });
  db.upsertRepository({ id: "repo_open", path: "/work/open", gitRoot: "/work/open" });
  db.upsertRepository({ id: "repo_closed", path: "/work/closed", gitRoot: "/work/closed" });
  db.createSession({ id: SESSION, repoId: "repo_open", prompt: "Open repo task", state: "running" });
  db.createSession({ id: OTHER, repoId: "repo_closed", prompt: "Other repo task", state: "completed" });
  db.appendAgentEvent(SESSION, { type: "agent_started", sessionId: SESSION, prompt: "Open repo task", ts: TS });
  db.appendEvidenceFact(SESSION, {
    type: "command_executed",
    repoId: "repo_open",
    sessionId: SESSION,
    command: "pnpm test",
    exitCode: 0,
    isDestructive: false,
    ts: TS,
  });
  db.appendTelemetry("agent_event_count", {}, SESSION);
  db.appendAgentEvent(OTHER, { type: "agent_completed", sessionId: OTHER, ts: TS });
  db.upsertInstruction({
    sessionId: SESSION,
    instructionId: "instr_pending",
    mode: "queue",
    text: "Please also update the README",
  });
  const reader = openTraceReader(db.dbPath);
  const ipc = harness();
  registerTraceHandlers(ipc.handle, createTraceService(reader));
  closers.push(() => {
    reader.close();
    db.close();
  });
  return { db, ipc };
}

describe("trace IPC handlers", () => {
  it("registers exactly the three read-only channels", () => {
    const { ipc } = seeded();
    expect(ipc.channels()).toEqual(["trace:listSessions", "trace:payloads", "trace:rows"]);
  });

  it("reads never deliver, cancel or append anything", async () => {
    const { db, ipc } = seeded();
    const pendingBefore = db.listPendingInstructions(SESSION);
    const countBefore = db.getEventCount(SESSION);
    const latestBefore = db.getLatestSeq(SESSION);
    const sessionBefore = db.getSession(SESSION);
    const walBefore = statSync(`${db.dbPath}-wal`);
    const mainBefore = statSync(db.dbPath);

    const listed = (await ipc.invoke("trace:listSessions", {})) as { sessions: TraceSessionSummary[] };
    const page = (await ipc.invoke("trace:rows", { sessionId: SESSION })) as TraceRowsPage;
    const fetched = (await ipc.invoke("trace:payloads", { sessionId: SESSION, seqs: [1, 2, 3] })) as {
      rows: TraceRow[];
    };

    expect(listed.sessions.map((session) => session.sessionId).sort()).toEqual([OTHER, SESSION].sort());
    expect(page.rows.map((row) => row.type)).toEqual(["agent_event", "evidence_fact"]);
    expect(fetched.rows.map((row) => row.seq)).toEqual([1, 2, 3]);

    expect(pendingBefore).toHaveLength(1);
    expect(db.listPendingInstructions(SESSION)).toEqual(pendingBefore);
    expect(db.getInstruction(SESSION, "instr_pending")?.status).toBe("pending");
    expect(db.getEventCount(SESSION)).toBe(countBefore);
    expect(db.getLatestSeq(SESSION)).toBe(latestBefore);
    expect(db.getSession(SESSION)?.lastEventSeq).toBe(sessionBefore?.lastEventSeq);
    expect(db.getSession(SESSION)?.state).toBe("running");
    const walAfter = statSync(`${db.dbPath}-wal`);
    expect(walAfter.size).toBe(walBefore.size);
    expect(walAfter.mtimeMs).toBe(walBefore.mtimeMs);
    expect(statSync(db.dbPath).mtimeMs).toBe(mainBefore.mtimeMs);
  });

  it("rejects empty, unknown and out-of-bounds requests", async () => {
    const { ipc } = seeded();
    await expect(ipc.invoke("trace:rows", { sessionId: "" })).rejects.toMatchObject({
      code: "INVALID_PAYLOAD",
    });
    await expect(ipc.invoke("trace:rows", { sessionId: SESSION, limit: 5001 })).rejects.toMatchObject({
      code: "INVALID_PAYLOAD",
    });
    await expect(ipc.invoke("trace:rows", { sessionId: "sess_missing" })).rejects.toMatchObject({
      code: "UNKNOWN_SESSION",
    });
    await expect(
      ipc.invoke("trace:payloads", { sessionId: "sess_missing", seqs: [1] }),
    ).rejects.toMatchObject({ code: "UNKNOWN_SESSION" });
  });

  it("reads a session that belongs to another repository", async () => {
    const { ipc } = seeded();
    const page = (await ipc.invoke("trace:rows", { sessionId: OTHER })) as TraceRowsPage;
    expect(page).toMatchObject({ lastSeq: 1, state: "completed", nextAfterSeq: null });
    expect(page.rows.map((row) => row.type)).toEqual(["agent_event"]);
  });

  it("stops a trace:rows page after 2 MiB of payload and resumes at nextAfterSeq", async () => {
    const { db, ipc } = seeded();
    // seq 4-6: three 1 MiB assistant messages; seq 7: agent_completed.
    const oneMiB = "m".repeat(1024 * 1024);
    for (let i = 0; i < 3; i += 1) {
      db.appendAgentEvent(SESSION, {
        type: "agent_message",
        sessionId: SESSION,
        role: "assistant",
        text: oneMiB,
        ts: TS,
      });
    }
    db.appendAgentEvent(SESSION, { type: "agent_completed", sessionId: SESSION, ts: TS });
    const first = (await ipc.invoke("trace:rows", { sessionId: SESSION })) as TraceRowsPage;
    // Seq 5 takes the payload past 2 MiB, so the page ends with it.
    expect(first.rows.map((row) => row.seq)).toEqual([1, 2, 4, 5]);
    expect(first).toMatchObject({ nextAfterSeq: 5, lastSeq: 7 });
    expect(first.rows.filter((row) => row.clipped === true).map((row) => row.seq)).toEqual([4, 5]);
    const second = (await ipc.invoke("trace:rows", {
      sessionId: SESSION,
      afterSeq: first.nextAfterSeq,
    })) as TraceRowsPage;
    expect(second.rows.map((row) => row.seq)).toEqual([6, 7]);
    expect(second).toMatchObject({ nextAfterSeq: null, lastSeq: 7 });
  });

  it("lists a zero-event session by exact id and reads it as an empty page", async () => {
    const { db, ipc } = seeded();
    db.createSession({ id: EMPTY, repoId: "repo_open", prompt: "Not started yet" });
    const listed = (await ipc.invoke("trace:listSessions", {})) as { sessions: TraceSessionSummary[] };
    expect(listed.sessions.map((session) => session.sessionId)).not.toContain(EMPTY);
    const exact = (await ipc.invoke("trace:listSessions", { sessionId: EMPTY, limit: 1 })) as {
      sessions: TraceSessionSummary[];
    };
    expect(exact.sessions).toEqual([
      expect.objectContaining({ sessionId: EMPTY, repoId: "repo_open", prompt: "Not started yet", lastEventSeq: 0 }),
    ]);
    await expect(ipc.invoke("trace:rows", { sessionId: EMPTY })).resolves.toEqual({
      rows: [],
      nextAfterSeq: null,
      lastSeq: 0,
      state: "starting",
    });
    await expect(ipc.invoke("trace:listSessions", { sessionId: "sess_missing" })).resolves.toEqual({
      sessions: [],
    });
    await expect(ipc.invoke("trace:listSessions", { sessionId: "" })).rejects.toMatchObject({
      code: "INVALID_PAYLOAD",
    });
  });
});

describe("trace:rows read-ahead", () => {
  const SEQS = [1, 2, 3, 4, 5];

  /** Pages of `limit` rows over SEQS; `failAt` makes the read at that afterSeq throw once. */
  function fakeService() {
    const reads: Array<{ afterSeq: number; limit: number | undefined }> = [];
    const control = { failAt: null as number | null, lastSeq: 5, missing: false };
    const service = {
      session(sessionId: string): TraceSessionSummary {
        if (control.missing) throw new IpcError("UNKNOWN_SESSION", `no session with id ${sessionId}`);
        return { sessionId } as TraceSessionSummary;
      },
      rows(request: { sessionId: string; afterSeq?: number; limit?: number }): TraceRowsPage {
        const afterSeq = request.afterSeq ?? 0;
        reads.push({ afterSeq, limit: request.limit });
        if (control.failAt === afterSeq) {
          control.failAt = null;
          throw new Error("database is locked");
        }
        const limit = request.limit ?? 2;
        const rows = SEQS.filter((seq) => seq > afterSeq)
          .slice(0, limit)
          .map((seq) => ({ seq, type: "agent_event", ts: TS }) as TraceRow);
        const last = rows.at(-1);
        return {
          rows,
          nextAfterSeq: rows.length === limit && last !== undefined ? last.seq : null,
          lastSeq: control.lastSeq,
          state: "running",
        };
      },
    };
    const deferred: Array<() => void> = [];
    const clock = { t: 0 };
    const rows = createRowsReadAhead(service, { defer: (fn) => deferred.push(fn), now: () => clock.t });
    const runDeferred = (): void => {
      while (deferred.length > 0) deferred.shift()?.();
    };
    return { rows, reads, control, deferred, clock, runDeferred };
  }

  it("reads the page after a full page once the reply is out and serves it to the next request", () => {
    const f = fakeService();
    const first = f.rows({ sessionId: SESSION, afterSeq: 0, limit: 2 });
    expect(first.rows.map((row) => row.seq)).toEqual([1, 2]);
    // Nothing is read ahead inside the request itself.
    expect(f.reads).toEqual([{ afterSeq: 0, limit: 2 }]);
    f.runDeferred();
    expect(f.reads.map((read) => read.afterSeq)).toEqual([0, 2]);

    const second = f.rows({ sessionId: SESSION, afterSeq: 2, limit: 2 });
    expect(second.rows.map((row) => row.seq)).toEqual([3, 4]);
    expect(f.reads.map((read) => read.afterSeq)).toEqual([0, 2]);
    f.runDeferred();
    const last = f.rows({ sessionId: SESSION, afterSeq: 4, limit: 2 });
    expect(last).toMatchObject({ nextAfterSeq: null });
    expect(last.rows.map((row) => row.seq)).toEqual([5]);
    // A last page (nextAfterSeq null) reads nothing ahead: a caught-up viewer polls instead.
    expect(f.deferred).toHaveLength(0);
    // The read-ahead at 4 found a short page, which is not held, so the request reads it fresh.
    expect(f.reads.map((read) => read.afterSeq)).toEqual([0, 2, 4, 4]);
  });

  it("reads directly for any other request, a held page older than one poll period, or a second ask", () => {
    const f = fakeService();
    f.rows({ sessionId: SESSION, afterSeq: 0, limit: 2 });
    f.runDeferred();
    // Another limit (or session, or afterSeq) is not the held page.
    f.rows({ sessionId: SESSION, afterSeq: 2, limit: 3 });
    expect(f.reads.map((read) => [read.afterSeq, read.limit])).toEqual([[0, 2], [2, 2], [2, 3]]);

    const g = fakeService();
    g.rows({ sessionId: SESSION, afterSeq: 0, limit: 2 });
    g.runDeferred();
    g.control.lastSeq = 9;
    g.clock.t = 1_001;
    expect(g.rows({ sessionId: SESSION, afterSeq: 2, limit: 2 }).lastSeq).toBe(9);
    expect(g.reads.map((read) => read.afterSeq)).toEqual([0, 2, 2]);

    const h = fakeService();
    h.rows({ sessionId: SESSION, afterSeq: 0, limit: 2 });
    h.runDeferred();
    h.rows({ sessionId: SESSION, afterSeq: 2, limit: 2 });
    h.control.lastSeq = 9;
    // The held page was used once; asking again (a retry) reads fresh.
    expect(h.rows({ sessionId: SESSION, afterSeq: 2, limit: 2 }).lastSeq).toBe(9);
  });

  it("still rejects a session deleted since the read-ahead, and a failed read-ahead surfaces on the direct read", () => {
    const f = fakeService();
    f.rows({ sessionId: SESSION, afterSeq: 0, limit: 2 });
    f.runDeferred();
    f.control.missing = true;
    expect(() => f.rows({ sessionId: SESSION, afterSeq: 2, limit: 2 })).toThrow(/no session with id/);

    const g = fakeService();
    g.rows({ sessionId: SESSION, afterSeq: 0, limit: 2 });
    g.control.failAt = 2;
    expect(() => g.runDeferred()).not.toThrow();
    g.control.failAt = 2;
    expect(() => g.rows({ sessionId: SESSION, afterSeq: 2, limit: 2 })).toThrow("database is locked");
  });
  it("keeps one slot per sender, so two loaders do not evict each other", () => {
    const f = fakeService();
    f.rows({ sessionId: SESSION, afterSeq: 0, limit: 2 }, 1);
    f.rows({ sessionId: SESSION, afterSeq: 0, limit: 2 }, 2);
    f.runDeferred();
    expect(f.reads.map((read) => read.afterSeq)).toEqual([0, 0, 2, 2]);
    expect(f.rows({ sessionId: SESSION, afterSeq: 2, limit: 2 }, 1).rows.map((row) => row.seq)).toEqual([3, 4]);
    expect(f.rows({ sessionId: SESSION, afterSeq: 2, limit: 2 }, 2).rows.map((row) => row.seq)).toEqual([3, 4]);
    // Both were served from their own slot: no direct read of afterSeq 2 beyond the two read-aheads.
    expect(f.reads.map((read) => read.afterSeq)).toEqual([0, 0, 2, 2]);
  });

  it("frees a held page after one poll period even if no request arrives", () => {
    vi.useFakeTimers();
    try {
      const f = fakeService();
      f.rows({ sessionId: SESSION, afterSeq: 0, limit: 2 }, 1);
      f.runDeferred();
      vi.advanceTimersByTime(1_000);
      // The injected clock never moved, so only the timer can have dropped the slot.
      f.rows({ sessionId: SESSION, afterSeq: 2, limit: 2 }, 1);
      expect(f.reads.map((read) => read.afterSeq)).toEqual([0, 2, 2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds only full pages, so a short last page is always read fresh", () => {
    const f = fakeService();
    // Page [1,2,3] is full; the read-ahead at afterSeq 3 returns the short page [4,5].
    f.rows({ sessionId: SESSION, afterSeq: 0, limit: 3 });
    f.runDeferred();
    expect(f.reads.map((read) => read.afterSeq)).toEqual([0, 3]);
    f.control.lastSeq = 9;
    const last = f.rows({ sessionId: SESSION, afterSeq: 3, limit: 3 });
    expect(last.lastSeq).toBe(9);
    expect(f.reads.map((read) => read.afterSeq)).toEqual([0, 3, 3]);
  });
});
