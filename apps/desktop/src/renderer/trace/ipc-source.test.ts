import type { TraceRowsPage, TraceSessionSummary } from "@jevcode/contracts";
import { TraceSourceError } from "@jevcode/trace-viewer/sources";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JevcodeApi } from "../../shared/api.js";
import { createIpcTraceSource } from "./ipc-source.js";

type Bridge = JevcodeApi["trace"];

const SUMMARY: TraceSessionSummary = {
  sessionId: "s",
  repoId: "repo_1",
  repoName: "api",
  prompt: "Add Google OAuth",
  state: "running",
  startedAt: "2026-09-28T10:00:00.000Z",
  endedAt: null,
  lastEventSeq: 3,
};

const PAGE: TraceRowsPage = {
  rows: [{ seq: 1, type: "agent_event", ts: "2026-09-28T10:00:00.000Z", payload: {} }],
  nextAfterSeq: null,
  lastSeq: 3,
  state: "running",
};

function fakeBridge() {
  return {
    listSessions: vi.fn<Bridge["listSessions"]>(async () => [SUMMARY]),
    rows: vi.fn<Bridge["rows"]>(async () => PAGE),
    payloads: vi.fn<Bridge["payloads"]>(async () => PAGE.rows),
    open: vi.fn<Bridge["open"]>(async () => undefined),
    requestChanges: vi.fn<Bridge["requestChanges"]>(async () => undefined),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createIpcTraceSource", () => {
  it("is bound to one session", () => {
    expect(createIpcTraceSource(fakeBridge(), "s").sessionId).toBe("s");
  });

  it("summary() asks main for exactly this session", async () => {
    const bridge = fakeBridge();
    await expect(createIpcTraceSource(bridge, "s").summary()).resolves.toEqual(SUMMARY);
    expect(bridge.listSessions).toHaveBeenCalledWith({ sessionId: "s", limit: 1 });
  });

  it("summary() rejects UNKNOWN_SESSION when main lists nothing", async () => {
    const bridge = fakeBridge();
    bridge.listSessions.mockResolvedValue([]);
    const failure = createIpcTraceSource(bridge, "s").summary();
    await expect(failure).rejects.toBeInstanceOf(TraceSourceError);
    await expect(failure).rejects.toMatchObject({
      channel: "trace:listSessions",
      code: "UNKNOWN_SESSION",
    });
  });

  it("summary() ignores a different session in the reply", async () => {
    const bridge = fakeBridge();
    bridge.listSessions.mockResolvedValue([{ ...SUMMARY, sessionId: "other" }]);
    await expect(createIpcTraceSource(bridge, "s").summary()).rejects.toMatchObject({
      code: "UNKNOWN_SESSION",
    });
  });

  it("rows() binds the session and forwards only the fields given", async () => {
    const bridge = fakeBridge();
    const source = createIpcTraceSource(bridge, "s");
    await expect(source.rows()).resolves.toEqual(PAGE);
    await source.rows({ afterSeq: 5, limit: 7 });
    expect(bridge.rows.mock.calls.map(([request]) => request)).toEqual([
      { sessionId: "s" },
      { sessionId: "s", afterSeq: 5, limit: 7 },
    ]);
  });

  it("payloads() passes a plain array and skips an empty request", async () => {
    const bridge = fakeBridge();
    const source = createIpcTraceSource(bridge, "s");
    await source.payloads(Object.freeze([1, 2]));
    const sent = bridge.payloads.mock.calls[0]?.[0];
    expect(sent).toEqual({ sessionId: "s", seqs: [1, 2] });
    expect(sent !== undefined && Object.isFrozen(sent.seqs)).toBe(false);
    await expect(source.payloads([])).resolves.toEqual([]);
    expect(bridge.payloads).toHaveBeenCalledTimes(1);
  });

  it("an IPC rejection becomes a TraceSourceError naming the channel", async () => {
    const bridge = fakeBridge();
    bridge.rows.mockRejectedValue(new Error("Error invoking remote method 'trace:rows': boom"));
    const failure = createIpcTraceSource(bridge, "s").rows({ afterSeq: 3 });
    await expect(failure).rejects.toBeInstanceOf(TraceSourceError);
    await expect(failure).rejects.toMatchObject({ channel: "trace:rows", code: "SOURCE_FAILED" });
    await expect(failure).rejects.toThrow(/boom/);
  });

  it("maps a bridge error without a code by its message", async () => {
    const bridge = fakeBridge();
    // contextBridge copies only the message of an IpcError into the page.
    bridge.payloads.mockRejectedValue(new Error("no session with id s"));
    await expect(createIpcTraceSource(bridge, "s").payloads([1])).rejects.toMatchObject({
      channel: "trace:payloads",
      code: "UNKNOWN_SESSION",
    });
    bridge.rows.mockRejectedValue({ code: "UNKNOWN_SESSION", message: "gone" });
    await expect(createIpcTraceSource(bridge, "s").rows()).rejects.toMatchObject({
      channel: "trace:rows",
      code: "UNKNOWN_SESSION",
    });
  });

  it("does not treat 'unknown session' inside another error as UNKNOWN_SESSION", async () => {
    const bridge = fakeBridge();
    for (const message of [
      "database is locked while resolving unknown session state",
      "failed: UNKNOWN_SESSION appears in agent text",
      "Error: no session with id s",
    ]) {
      bridge.rows.mockRejectedValue(new Error(message));
      await expect(createIpcTraceSource(bridge, "s").rows()).rejects.toMatchObject({ code: "SOURCE_FAILED" });
    }
    bridge.rows.mockRejectedValue(new Error("jevcode.ipc.UNKNOWN_SESSION: no session with id s"));
    await expect(createIpcTraceSource(bridge, "s").rows()).rejects.toMatchObject({ code: "UNKNOWN_SESSION" });
  });

  it("malformed results become SOURCE_FAILED instead of reaching the viewer", async () => {
    const bridge = fakeBridge();
    const source = createIpcTraceSource(bridge, "s");
    for (const bad of [null, "x", {}, { ...PAGE, rows: "no" }, { ...PAGE, lastSeq: "3" }, { ...PAGE, state: 4 }]) {
      bridge.rows.mockResolvedValue(bad as never);
      await expect(source.rows()).rejects.toMatchObject({ channel: "trace:rows", code: "SOURCE_FAILED" });
    }
    bridge.listSessions.mockResolvedValue({ sessions: [] } as never);
    await expect(source.summary()).rejects.toMatchObject({ channel: "trace:listSessions", code: "SOURCE_FAILED" });
    bridge.payloads.mockResolvedValue({} as never);
    await expect(source.payloads([1])).rejects.toMatchObject({ channel: "trace:payloads", code: "SOURCE_FAILED" });
  });

  it("now() is the wall clock", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_234);
    expect(createIpcTraceSource(fakeBridge(), "s").now()).toBe(1_234);
  });
});
