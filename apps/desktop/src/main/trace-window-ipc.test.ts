import { describe, expect, it, vi } from "vitest";

import { parseToMain } from "../shared/ipc-registry.js";
import type { IpcHandle } from "./trace-ipc.js";
import { registerTraceWindowHandlers } from "./trace-window-ipc.js";
import type { TraceWindowIpcDeps } from "./trace-window-ipc.js";
import type { TraceWindowHandle, TraceWindowRegistry } from "./trace-window.js";

const TRACE_SENDER = 100;
/** A trace window whose session has since disappeared from the reader. */
const STALE_SENDER = 101;

/** Mirrors the ipc.ts handle wrapper after its sender checks: zod-parse, then call the handler. */
function harness(): {
  handle: IpcHandle;
  channels: () => string[];
  invoke: (channel: string, raw: unknown, senderId?: number) => Promise<unknown>;
} {
  const handlers = new Map<string, (raw: unknown, senderId: number) => unknown>();
  const handle: IpcHandle = (channel, fn) => {
    handlers.set(channel, (raw, senderId) => fn(parseToMain(channel, raw), { senderId }));
  };
  return {
    handle,
    channels: () => [...handlers.keys()].sort(),
    invoke: async (channel, raw, senderId = TRACE_SENDER) => {
      const handler = handlers.get(channel);
      if (handler === undefined) throw new Error(`no handler for ${channel}`);
      return await handler(raw, senderId);
    },
  };
}

function setup() {
  const openTraceWindow = vi.fn<(sessionId: string) => TraceWindowHandle>(
    () => ({}) as TraceWindowHandle,
  );
  const windows: TraceWindowRegistry = {
    openTraceWindow,
    isTraceSender: () => false,
    sessionForSender: (id) =>
      id === TRACE_SENDER ? "sess_1" : id === STALE_SENDER ? "sess_missing" : undefined,
    closeAll: () => undefined,
    count: () => 0,
  };
  const focusMainWindow = vi.fn<() => void>();
  const sent: Array<[string, unknown]> = [];
  const sendToRenderer: TraceWindowIpcDeps["sendToRenderer"] = (channel, payload) => {
    sent.push([channel, payload]);
  };
  const ipc = harness();
  registerTraceWindowHandlers(ipc.handle, {
    windows,
    sessionExists: (sessionId) => sessionId === "sess_1",
    focusMainWindow,
    sendToRenderer,
  });
  return { ipc, openTraceWindow, focusMainWindow, sent };
}

describe("trace window IPC handlers", () => {
  it("registers exactly trace:open and trace:requestChanges", () => {
    const { ipc } = setup();
    expect(ipc.channels()).toEqual(["trace:open", "trace:requestChanges"]);
  });

  it("opens a trace window for an existing session and returns nothing", async () => {
    const { ipc, openTraceWindow, sent } = setup();
    await expect(ipc.invoke("trace:open", { sessionId: "sess_1" })).resolves.toBeUndefined();
    expect(openTraceWindow).toHaveBeenCalledTimes(1);
    expect(openTraceWindow).toHaveBeenCalledWith("sess_1");
    expect(sent).toEqual([]);
  });

  it("refuses to open a window for an unknown session", async () => {
    const { ipc, openTraceWindow } = setup();
    await expect(ipc.invoke("trace:open", { sessionId: "sess_missing" })).rejects.toMatchObject({
      code: "UNKNOWN_SESSION",
    });
    expect(openTraceWindow).not.toHaveBeenCalled();
  });

  it("hands a note to the main window: one focus, one composer:prefill, nothing else", async () => {
    const { ipc, openTraceWindow, focusMainWindow, sent } = setup();
    const text = 'Re: trace sess_1 +0:43 "Claim contradicts tests" (seq 48; evidence seq 46)';
    await expect(
      ipc.invoke("trace:requestChanges", { sessionId: "sess_1", selected: "step:48", text }),
    ).resolves.toBeUndefined();
    expect(focusMainWindow).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([["composer:prefill", { sessionId: "sess_1", text }]]);
    expect(openTraceWindow).not.toHaveBeenCalled();
  });

  it("rejects a note for a session other than the sender window's own", async () => {
    const { ipc, focusMainWindow, sent } = setup();
    const payload = { sessionId: "sess_1", selected: "step:1", text: "x" };
    // Session exists but sender 7 is not a trace window for it.
    await expect(ipc.invoke("trace:requestChanges", payload, 7)).rejects.toMatchObject({
      code: "UNTRUSTED_SENDER",
    });
    expect(focusMainWindow).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("sends nothing for a session that does not exist", async () => {
    const { ipc, focusMainWindow, sent } = setup();
    await expect(
      ipc.invoke(
        "trace:requestChanges",
        { sessionId: "sess_missing", selected: "step:1", text: "x" },
        STALE_SENDER,
      ),
    ).rejects.toMatchObject({ code: "UNKNOWN_SESSION" });
    expect(focusMainWindow).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("an oversized or malformed note sends nothing", async () => {
    const { ipc, focusMainWindow, sent } = setup();
    const bad: unknown[] = [
      { sessionId: "sess_1", selected: "step:48", text: "a".repeat(8_001) },
      { sessionId: "sess_1", selected: "file:src/a.ts", text: "x" },
      { sessionId: "sess_1", selected: "step:48", text: "" },
    ];
    for (const payload of bad) {
      await expect(ipc.invoke("trace:requestChanges", payload)).rejects.toMatchObject({
        code: "INVALID_PAYLOAD",
      });
    }
    expect(focusMainWindow).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
});
