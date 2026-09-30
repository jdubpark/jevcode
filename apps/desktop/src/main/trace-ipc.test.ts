import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { TraceRow, TraceRowsPage, TraceSessionSummary } from "@jevcode/contracts";
import { openDb, openTraceReader } from "@jevcode/storage";
import type { JevcodeDb } from "@jevcode/storage";
import { afterEach, describe, expect, it } from "vitest";

import { parseToMain } from "../shared/ipc-registry.js";
import { registerTraceHandlers } from "./trace-ipc.js";
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
    handlers.set(channel, (raw) => fn(parseToMain(channel, raw)));
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
