import { describe, expect, it, vi } from "vitest";

import { createJevcodeApi } from "./api.js";
import { IpcError } from "./errors.js";

function makeDeps(): {
  invoke: ReturnType<
    typeof vi.fn<(channel: string, payload: unknown) => Promise<unknown>>
  >;
  on: ReturnType<
    typeof vi.fn<
      (channel: string, listener: (payload: unknown) => void) => () => void
    >
  >;
  platform: string;
} {
  const invoke = vi.fn<(channel: string, payload: unknown) => Promise<unknown>>(
    async () => undefined,
  );
  const on = vi.fn<
    (channel: string, listener: (payload: unknown) => void) => () => void
  >(() => () => undefined);
  return { invoke, on, platform: "test" };
}

describe("createJevcodeApi", () => {
  it("forwards valid channels with validated payloads", async () => {
    const deps = makeDeps();
    const api = createJevcodeApi(deps);
    await api.repo.open("/work/repo");
    expect(deps.invoke).toHaveBeenCalledWith("repo:open", { path: "/work/repo" });
  });

  it("rejects invalid payloads client-side with a typed error", async () => {
    const deps = makeDeps();
    const api = createJevcodeApi(deps);
    await expect(
      (api as never as { repo: { open: (p: unknown) => Promise<void> } }).repo.open({}),
    ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    expect(deps.invoke).not.toHaveBeenCalled();
  });

  it("unwraps serialized IpcError codes from main rejections", async () => {
    const deps = makeDeps();
    deps.invoke.mockImplementation(async () => {
      throw new Error(
        "Error invoking remote method 'repo:open': jevcode.ipc.NOT_A_GIT_REPO: /x is not inside a git work tree",
      );
    });
    const api = createJevcodeApi(deps);
    await expect(api.repo.open("/x")).rejects.toMatchObject({
      name: "IpcError",
      code: "NOT_A_GIT_REPO",
    });
  });

  it("rethrows non-IpcError rejections unchanged", async () => {
    const original = new Error("boom");
    const deps = makeDeps();
    deps.invoke.mockImplementation(async () => {
      throw original;
    });
    const api = createJevcodeApi(deps);
    await expect(api.repo.open("/x")).rejects.toBe(original);
  });

  it("on() rejects unknown channels and parses valid inbound payloads", () => {
    const deps = makeDeps();
    const api = createJevcodeApi(deps);
    expect(() => api.on("nope:channel" as never, () => undefined)).toThrowError(
      IpcError,
    );
    const listener = vi.fn();
    const unsubscribe = api.on("repo:opened", listener);
    expect(deps.on).toHaveBeenCalledWith("repo:opened", expect.any(Function));
    const registered = deps.on.mock.calls[0]?.[1] as (p: unknown) => void;
    registered({
      repoId: "r1",
      path: "/x",
      gitRoot: "/x",
      branch: "main",
      baseCommit: "abc",
    });
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: "r1", branch: "main" }),
    );
    unsubscribe();
  });

  it("on() drops invalid inbound payloads without calling the listener", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = makeDeps();
    const api = createJevcodeApi(deps);
    const listener = vi.fn();
    api.on("repo:opened", listener);
    const registered = deps.on.mock.calls[0]?.[1] as (p: unknown) => void;
    registered({ repoId: "r1", branch: "main" });
    expect(listener).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("exposes typed helpers for the terminal and debug flows", async () => {
    const deps = makeDeps();
    deps.invoke.mockImplementation(async (channel: string) => {
      if (channel === "terminal:getScrollback") {
        return { sessionId: "s1", lines: ["a", "b"] };
      }
      if (channel === "debug:listTelemetry") {
        return { events: [] };
      }
      return undefined;
    });
    const api = createJevcodeApi(deps);
    await expect(api.terminal.getScrollback("s1")).resolves.toEqual(["a", "b"]);
    await expect(api.debug.listTelemetry("s1")).resolves.toEqual([]);
    await api.terminal.input("s1", "ls\r");
    expect(deps.invoke).toHaveBeenCalledWith("terminal:input", {
      sessionId: "s1",
      data: "ls\r",
    });
  });

  it("sends instructions with a generated id and cancels via the agent channel", async () => {
    const deps = makeDeps();
    const api = createJevcodeApi(deps);
    await api.agent.sendInstruction("s1", "do the thing");
    expect(deps.invoke).toHaveBeenCalledWith("agent:sendInstruction", {
      id: expect.stringMatching(/^instr_/),
      sessionId: "s1",
      mode: "queue",
      text: "do the thing",
    });
    await api.agent.sendInstruction("s1", "change direction", "steer");
    expect(deps.invoke).toHaveBeenCalledWith("agent:sendInstruction", {
      id: expect.stringMatching(/^instr_/),
      sessionId: "s1",
      mode: "steer",
      text: "change direction",
    });
    await api.agent.cancelInstruction("s1", "instr_1");
    expect(deps.invoke).toHaveBeenCalledWith("agent:cancelInstruction", {
      sessionId: "s1",
      instructionId: "instr_1",
    });
  });

  it("onInstructionState subscribes to the instruction state channel", () => {
    const deps = makeDeps();
    const api = createJevcodeApi(deps);
    const listener = vi.fn();
    const unsubscribe = api.onInstructionState(listener);
    expect(deps.on).toHaveBeenCalledWith(
      "agent:instructionState",
      expect.any(Function),
    );
    const registered = deps.on.mock.calls[0]?.[1] as (p: unknown) => void;
    registered({
      sessionId: "s1",
      pending: [
        { id: "i1", mode: "queue", text: "x", createdAt: "2026-09-19T00:00:00.000Z" },
      ],
    });
    expect(listener).toHaveBeenCalledWith({
      sessionId: "s1",
      pending: [
        expect.objectContaining({ id: "i1", mode: "queue" }),
      ],
    });
    unsubscribe();
  });

  it("reads traces through the three trace channels", async () => {
    const deps = makeDeps();
    const page = {
      rows: [{ seq: 1, type: "agent_event", ts: "2026-09-28T10:00:00.000Z", payload: {} }],
      nextAfterSeq: null,
      lastSeq: 1,
      state: "running",
    };
    deps.invoke.mockImplementation(async (channel: string) => {
      if (channel === "trace:listSessions") return { sessions: [] };
      if (channel === "trace:rows") return page;
      if (channel === "trace:payloads") return { rows: page.rows };
      return undefined;
    });
    const api = createJevcodeApi(deps);
    await expect(api.trace.listSessions()).resolves.toEqual([]);
    expect(deps.invoke).toHaveBeenCalledWith("trace:listSessions", {});
    await expect(api.trace.listSessions({ sessionId: "s", limit: 1 })).resolves.toEqual([]);
    expect(deps.invoke).toHaveBeenCalledWith("trace:listSessions", { sessionId: "s", limit: 1 });
    await expect(api.trace.rows({ sessionId: "s" })).resolves.toEqual(page);
    expect(deps.invoke).toHaveBeenCalledWith("trace:rows", { sessionId: "s" });
    const seqs: readonly number[] = Object.freeze([3, 1]);
    await expect(api.trace.payloads({ sessionId: "s", seqs })).resolves.toEqual(page.rows);
    const sent = deps.invoke.mock.calls.find(([channel]) => channel === "trace:payloads")?.[1] as
      | { sessionId: string; seqs: number[] }
      | undefined;
    expect(sent).toEqual({ sessionId: "s", seqs: [3, 1] });
    expect(sent !== undefined && Object.isFrozen(sent.seqs)).toBe(false);
  });

  it("rejects out-of-bounds trace requests before they reach main", async () => {
    const deps = makeDeps();
    const api = createJevcodeApi(deps);
    await expect(api.trace.rows({ sessionId: "s", limit: 5001 })).rejects.toMatchObject({
      code: "INVALID_PAYLOAD",
    });
    await expect(api.trace.payloads({ sessionId: "s", seqs: [] })).rejects.toMatchObject({
      code: "INVALID_PAYLOAD",
    });
    await expect(api.trace.listSessions({ sessionId: "" })).rejects.toMatchObject({
      code: "INVALID_PAYLOAD",
    });
    expect(deps.invoke).not.toHaveBeenCalled();
  });

  it("the trace namespace holds three reads, open and requestChanges", () => {
    const trace = createJevcodeApi(makeDeps()).trace;
    expect(Object.keys(trace).sort()).toEqual([
      "listSessions",
      "open",
      "payloads",
      "requestChanges",
      "rows",
    ]);
  });
});

describe("trace window API", () => {
  it("opens a trace window and hands a review note to main", async () => {
    const deps = makeDeps();
    const api = createJevcodeApi(deps);
    await api.trace.open("sess_1");
    expect(deps.invoke).toHaveBeenCalledWith("trace:open", { sessionId: "sess_1" });
    await api.trace.requestChanges({ sessionId: "sess_1", selected: "step:48", text: "Re: trace" });
    expect(deps.invoke).toHaveBeenCalledWith("trace:requestChanges", {
      sessionId: "sess_1",
      selected: "step:48",
      text: "Re: trace",
    });
  });

  it("rejects malformed trace window requests before they reach main", async () => {
    const deps = makeDeps();
    const api = createJevcodeApi(deps);
    await expect(api.trace.open("")).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    await expect(
      api.trace.requestChanges({ sessionId: "sess_1", selected: "file:a.ts", text: "x" }),
    ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    await expect(
      api.trace.requestChanges({ sessionId: "sess_1", selected: "step:1", text: "a".repeat(8_001) }),
    ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    expect(deps.invoke).not.toHaveBeenCalled();
  });

  it("delivers composer:prefill payloads and drops invalid ones", () => {
    const deps = makeDeps();
    const captured = new Map<string, (payload: unknown) => void>();
    deps.on.mockImplementation((channel, listener) => {
      captured.set(channel, listener);
      return () => undefined;
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const listener = vi.fn();
    createJevcodeApi(deps).onComposerPrefill(listener);
    const push = captured.get("composer:prefill");
    expect(push).toBeDefined();
    push?.({ sessionId: "sess_1", text: "note" });
    push?.({ sessionId: "", text: "note" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ sessionId: "sess_1", text: "note" });
    quiet.mockRestore();
  });
});
