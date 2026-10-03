import { openDb } from "@jevcode/storage";
import type { JevcodeDb } from "@jevcode/storage";
import { RendererToMainChannels } from "@jevcode/contracts";
import { ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";

import { deserializeIpcError } from "../shared/api.js";
import { registerIpcHandlers, setMainWindow } from "./ipc.js";
import type { IpcDeps } from "./ipc.js";
import type { ExplainerRegistry } from "./pipeline/explainer-stage.js";
import { createNarratorCallLog } from "./pipeline/narrator-call-log.js";
import type { NarratorCallLog } from "./pipeline/narrator-call-log.js";
import { createNarratorSwitch } from "./pipeline/narrator-switch.js";
import type { NarratorSwitch } from "./pipeline/narrator-switch.js";
import type { PipelineRuntime } from "./pipeline/pipeline-runtime.js";
import type { NarratorCallRecord } from "../shared/narrator-log.js";
import { EXPLAIN_WITH_MODEL_PREF_KEY } from "../shared/prefs.js";
import { createAppState } from "./state.js";
import type { AppState } from "./state.js";

/**
 * `ipc.ts` calls `ipcMain.handle` directly rather than taking an injectable
 * wrapper, so this module must be mocked to observe what registerIpcHandlers
 * wires up (mirrors the harness in trace-ipc.test.ts, which the real ipc.ts
 * handle wrapper is built to match).
 */
vi.mock("electron", () => ({
  BrowserWindow: class {},
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
}));

interface StubCall {
  method: string;
  args: unknown[];
}

/** Records every call made on the runtime without asserting a fixed method list (action-dispatcher.test.ts pattern). */
function stubRuntime(): { runtime: PipelineRuntime; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const target: Record<string, unknown> = {};
  const proxy = new Proxy(target, {
    get: (_target, prop: string) => {
      return (...args: unknown[]) => {
        calls.push({ method: prop, args });
        return Promise.resolve(true);
      };
    },
  });
  return { runtime: proxy as unknown as PipelineRuntime, calls };
}

function makeDeps(
  db: JevcodeDb,
  runtime: PipelineRuntime,
  state: AppState,
  senderKind: IpcDeps["senderKind"] = () => "main",
): IpcDeps {
  return {
    db,
    state,
    terminals: {} as unknown as IpcDeps["terminals"],
    runtime,
    instructionRouter: { reloadPending: async () => {} } as unknown as IpcDeps["instructionRouter"],
    requestRepoPath: async () => null,
    log: () => {},
    trace: {} as unknown as IpcDeps["trace"],
    senderKind,
    traceWindows: {} as unknown as IpcDeps["traceWindows"],
  };
}

const TRUSTED_EVENT = {
  senderFrame: { url: "file:///index.html" },
  sender: { id: 1 },
} as unknown as IpcMainInvokeEvent;

type Handler = (event: IpcMainInvokeEvent, raw: unknown) => unknown;

/** Registers the handlers and returns them keyed by channel name. */
function registerAndCapture(deps: IpcDeps): Map<string, Handler> {
  const handleMock = vi.mocked(ipcMain.handle);
  handleMock.mockClear();
  registerIpcHandlers(deps);
  const handlers = new Map<string, Handler>();
  for (const [channel, fn] of handleMock.mock.calls) {
    handlers.set(channel as string, fn as Handler);
  }
  return handlers;
}

function seedRepoAndSession(): { db: JevcodeDb; state: AppState } {
  const db = openDb({ dbPath: ":memory:" });
  const repo = db.upsertRepository({ id: "repo_a", path: "/a", gitRoot: "/a" });
  const session = db.createSession({ id: "sess_a", repoId: "repo_a", prompt: "demo", state: "running" });
  const state = createAppState();
  state.repo = repo;
  state.session = session;
  return { db, state };
}

describe("session:stop / repo:close teardown wiring (D10 resumable stop)", () => {
  it("session:stop parks the session (teardown: false) so resume can relaunch it", async () => {
    const { db, state } = seedRepoAndSession();
    const { runtime, calls } = stubRuntime();
    const handlers = registerAndCapture(makeDeps(db, runtime, state));
    const stop = handlers.get(RendererToMainChannels.sessionStop);
    expect(stop).toBeDefined();

    await stop!(TRUSTED_EVENT, { sessionId: "sess_a" });

    const stopCall = calls.find((call) => call.method === "stopSession");
    expect(stopCall?.args).toEqual(["sess_a", { teardown: false }]);
    db.close();
  });

  it("repo:close keeps the default full teardown", async () => {
    const { db, state } = seedRepoAndSession();
    const { runtime, calls } = stubRuntime();
    const handlers = registerAndCapture(makeDeps(db, runtime, state));
    const close = handlers.get(RendererToMainChannels.repoClose);
    expect(close).toBeDefined();

    await close!(TRUSTED_EVENT, { repoId: "repo_a" });

    const stopCall = calls.find((call) => call.method === "stopSession");
    expect(stopCall?.args).toEqual(["sess_a"]);
    db.close();
  });
});

describe("per-sender allowlist in the handle wrapper (spec 8.6)", () => {
  const AGENT_CHANNEL = RendererToMainChannels.agentInterrupt;

  function setup(kind: "trace" | "main" | "other") {
    const { db, state } = seedRepoAndSession();
    const { runtime, calls } = stubRuntime();
    const log = vi.fn();
    const trace = { rows: vi.fn(() => ({ rows: [], nextCursor: null })) };
    const deps = {
      ...makeDeps(db, runtime, state, () => kind),
      log,
      trace: trace as unknown as IpcDeps["trace"],
    };
    return { db, handlers: registerAndCapture(deps), calls, log, trace };
  }

  it.each(["trace", "other"] as const)(
    "rejects session:stop and an agent channel from a %s sender without calling the handler",
    async (kind) => {
      const { db, handlers, calls, log } = setup(kind);
      const stop = handlers.get(RendererToMainChannels.sessionStop)!;
      const agent = handlers.get(AGENT_CHANNEL);
      expect(agent).toBeDefined();

      await expect(stop(TRUSTED_EVENT, { sessionId: "sess_a" })).rejects.toMatchObject({
        code: "UNTRUSTED_SENDER",
      });
      await expect(agent!(TRUSTED_EVENT, { sessionId: "sess_a" })).rejects.toMatchObject({ code: "UNTRUSTED_SENDER" });

      expect(calls).toEqual([]);
      expect(log).toHaveBeenCalledTimes(2);
      db.close();
    },
  );

  it("lets a trace sender through on an allowlisted trace read", async () => {
    const { db, handlers, trace } = setup("trace");
    const rows = handlers.get("trace:rows")!;
    await rows(TRUSTED_EVENT, { sessionId: "sess_a" });
    expect(trace.rows).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("passes the real sender id to trace:requestChanges so it is bound to that window's session", async () => {
    const { db, state } = seedRepoAndSession();
    const { runtime } = stubRuntime();
    const sendToRenderer = vi.fn();
    const traceWindows: IpcDeps["traceWindows"] = {
      windows: {
        sessionForSender: (id: number) => (id === 100 ? "sess_a" : undefined),
      } as unknown as IpcDeps["traceWindows"]["windows"],
      sessionExists: () => true,
      focusMainWindow: vi.fn(),
      sendToRenderer: sendToRenderer as unknown as IpcDeps["traceWindows"]["sendToRenderer"],
    };
    const deps = {
      ...makeDeps(db, runtime, state, (id) => (id === 100 ? "trace" : "main")),
      traceWindows,
    };
    const handler = registerAndCapture(deps).get("trace:requestChanges")!;
    const traceEvent = {
      senderFrame: { url: "file:///trace.html" },
      sender: { id: 100 },
    } as unknown as IpcMainInvokeEvent;

    await handler(traceEvent, { sessionId: "sess_a", selected: "step:1", text: "note" });
    expect(sendToRenderer).toHaveBeenCalledWith("composer:prefill", { sessionId: "sess_a", text: "note" });

    sendToRenderer.mockClear();
    await expect(
      handler(traceEvent, { sessionId: "sess_b", selected: "step:1", text: "note" }),
    ).rejects.toThrow(/UNTRUSTED_SENDER/);
    expect(sendToRenderer).not.toHaveBeenCalled();
    db.close();
  });
});

describe("explainWithModel preference (spec E15)", () => {
  it("defaults to on, persists an off switch and keeps it through other patches", async () => {
    const { db, state } = seedRepoAndSession();
    const { runtime } = stubRuntime();
    const handlers = registerAndCapture(makeDeps(db, runtime, state));
    const get = handlers.get("preferences:get")!;
    const set = handlers.get("preferences:set")!;

    await expect(get(TRUSTED_EVENT, {})).resolves.toMatchObject({ explainWithModel: true });
    await expect(set(TRUSTED_EVENT, { explainWithModel: false })).resolves.toMatchObject({
      model: "auto",
      explainWithModel: false,
    });
    expect(db.getPreference("explainer.withModel")).toBe(false);
    await expect(get(TRUSTED_EVENT, {})).resolves.toMatchObject({ explainWithModel: false });
    await expect(set(TRUSTED_EVENT, { model: "gpt-5.6-sol" })).resolves.toMatchObject({
      model: "gpt-5.6-sol",
      explainWithModel: false,
    });
    db.close();
  });
});

describe("explainer wiring (console-explainer M-6)", () => {
  function explainerSpy(): { registry: ExplainerRegistry; calls: string[] } {
    const calls: string[] = [];
    const registry: ExplainerRegistry = {
      repoOpened: (repoRoot) => void calls.push(`open ${repoRoot}`),
      repoClosed: (repoRoot) => void calls.push(`close ${repoRoot}`),
      sessionStarted: (repoRoot, sessionId) => void calls.push(`session ${repoRoot} ${sessionId}`),
      filesChanged: () => {},
      rescan: (repoRoot) => void calls.push(`rescan ${repoRoot}`),
      setNarrator: () => {},
      get: () => undefined,
      dispose: () => {},
    };
    return { registry, calls };
  }

  /** A handler-body IpcError crosses IPC as a message; the renderer's api turns it back into a code. */
  const asRenderer = (call: unknown): Promise<unknown> =>
    Promise.resolve(call).catch((error: unknown) => {
      throw deserializeIpcError(error);
    });

  it("repo:close closes the open repo's explainer stage", async () => {
    const { db, state } = seedRepoAndSession();
    const { runtime } = stubRuntime();
    const { registry, calls } = explainerSpy();
    const handlers = registerAndCapture({ ...makeDeps(db, runtime, state), explainer: registry });
    await handlers.get(RendererToMainChannels.repoClose)!(TRUSTED_EVENT, { repoId: "repo_a" });
    expect(calls).toEqual(["close /a"]);
    db.close();
  });

  it("session:start tells the explainer which session started in which repo", async () => {
    const { db, state } = seedRepoAndSession();
    state.info = { gitRoot: "/a", branch: "main", baseCommit: "abc" };
    const { runtime } = stubRuntime();
    const { registry, calls } = explainerSpy();
    const handlers = registerAndCapture({ ...makeDeps(db, runtime, state), explainer: registry });
    await handlers.get(RendererToMainChannels.sessionStart)!(TRUSTED_EVENT, { repoId: "repo_a", prompt: "go" });
    expect(calls).toEqual(["session /a sess_a"]);
    db.close();
  });

  it("overview:rescan forwards the root from the main window and is denied to trace windows", async () => {
    const { db, state } = seedRepoAndSession();
    const { runtime } = stubRuntime();
    const main = explainerSpy();
    const mainHandlers = registerAndCapture({ ...makeDeps(db, runtime, state), explainer: main.registry });
    await mainHandlers.get(RendererToMainChannels.overviewRescan)!(TRUSTED_EVENT, { repoRoot: "/a" });
    expect(main.calls).toEqual(["rescan /a"]);

    const trace = explainerSpy();
    const traceHandlers = registerAndCapture({ ...makeDeps(db, runtime, state, () => "trace"), explainer: trace.registry });
    await expect(
      traceHandlers.get(RendererToMainChannels.overviewRescan)!(TRUSTED_EVENT, { repoRoot: "/a" }),
    ).rejects.toMatchObject({ code: "UNTRUSTED_SENDER" });
    expect(trace.calls).toEqual([]);
    db.close();
  });

  it("overview:rescan rejects a root that is not the open repo, a closed repo and an invalid payload", async () => {
    const { db, state } = seedRepoAndSession();
    const { runtime } = stubRuntime();
    const { registry, calls } = explainerSpy();
    const handlers = registerAndCapture({ ...makeDeps(db, runtime, state), explainer: registry });
    const rescan = handlers.get(RendererToMainChannels.overviewRescan)!;
    await expect(asRenderer(rescan(TRUSTED_EVENT, { repoRoot: "/elsewhere" }))).rejects.toMatchObject({ code: "NO_ACTIVE_SESSION" });
    await expect(rescan(TRUSTED_EVENT, { repoRoot: "" })).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    await expect(rescan(TRUSTED_EVENT, { repoRoot: "/a", extra: true })).resolves.toBeNull();
    state.repo = null;
    await expect(asRenderer(rescan(TRUSTED_EVENT, { repoRoot: "/a" }))).rejects.toMatchObject({ code: "NO_ACTIVE_SESSION" });
    expect(calls).toEqual(["rescan /a"]);
    db.close();
  });

  it("logs a throwing explainer and still starts the session and closes the repo (spec §6.6)", async () => {
    const { db, state } = seedRepoAndSession();
    state.info = { gitRoot: "/a", branch: "main", baseCommit: "abc" };
    const { runtime, calls } = stubRuntime();
    const log = vi.fn();
    const boom = (): never => {
      throw new Error("stage exploded");
    };
    const registry: ExplainerRegistry = { ...explainerSpy().registry, sessionStarted: boom, repoClosed: boom };
    const handlers = registerAndCapture({ ...makeDeps(db, runtime, state), log, explainer: registry });

    await expect(
      handlers.get(RendererToMainChannels.sessionStart)!(TRUSTED_EVENT, { repoId: "repo_a", prompt: "go" }),
    ).resolves.toBeNull();
    expect(calls.map((call) => call.method)).toContain("startSession");
    expect(state.session?.id).toBe("sess_a");
    expect(log).toHaveBeenCalledWith("explainer sessionStarted failed: stage exploded");

    await expect(handlers.get(RendererToMainChannels.repoClose)!(TRUSTED_EVENT, { repoId: "repo_a" })).resolves.toBeNull();
    expect(state.repo).toBeNull();
    expect(log).toHaveBeenCalledWith("explainer repoClosed failed: stage exploded");
    db.close();
  });
});

describe("narrator setting and Inspect log (N-4, spec E15 and §6.3)", () => {
  function narratorStub(availability: "on" | "off_setting" = "on") {
    const setEnabled = vi.fn();
    const narrator: NarratorSwitch = {
      current: () => null,
      availability: () => availability,
      setEnabled,
      subscribe: () => () => undefined,
    };
    return { narrator, setEnabled };
  }

  it("preferences:set explainWithModel false turns the narrator off and persists the choice", async () => {
    const { db, state } = seedRepoAndSession();
    const { runtime } = stubRuntime();
    const { narrator, setEnabled } = narratorStub();
    const handlers = registerAndCapture({ ...makeDeps(db, runtime, state), narrator });
    const result = await handlers.get("preferences:set")!(TRUSTED_EVENT, { explainWithModel: false });
    expect(result).toMatchObject({ explainWithModel: false });
    expect(setEnabled).toHaveBeenCalledWith(false);
    expect(db.getPreference(EXPLAIN_WITH_MODEL_PREF_KEY)).toBe(false);
    db.close();
  });

  it("preferences:get, the preferences:set reply and the preferences:updated broadcast carry the narrator availability", async () => {
    const { db, state } = seedRepoAndSession();
    const { runtime } = stubRuntime();
    // No key: the switch never builds a client and never reads process.env.
    const narrator = createNarratorSwitch({ enabled: true, env: {} });
    const send = vi.fn();
    setMainWindow({ isDestroyed: () => false, webContents: { send } } as unknown as Parameters<typeof setMainWindow>[0]);
    try {
      const handlers = registerAndCapture({ ...makeDeps(db, runtime, state), narrator });
      await expect(handlers.get("preferences:get")!(TRUSTED_EVENT, {})).resolves.toMatchObject({
        explainWithModel: true,
        narratorAvailability: "off_no_key",
      });
      await expect(handlers.get("preferences:set")!(TRUSTED_EVENT, { explainWithModel: false })).resolves.toMatchObject({
        explainWithModel: false,
        narratorAvailability: "off_setting",
      });
      expect(send).toHaveBeenCalledWith(
        "preferences:updated",
        expect.objectContaining({ explainWithModel: false, narratorAvailability: "off_setting" }),
      );
    } finally {
      setMainWindow(null);
      db.close();
    }
  });

  it("debug:listNarratorCalls returns availability and the newest calls first", async () => {
    const { db, state } = seedRepoAndSession();
    const { runtime } = stubRuntime();
    const narratorCalls = createNarratorCallLog();
    for (const id of ["narr_a", "narr_b"]) {
      narratorCalls.record({
        id, ts: "2026-10-02T09:00:00.000Z", repoRoot: "/a", question: "describeComponents", model: "claude-haiku-4-5-20251001",
        ms: 5, batchSize: 1, accepted: 1, dropped: 0, discarded: false, inputTokens: null, outputTokens: null, costUsd: null, error: null, reasons: [],
      });
    }
    const handlers = registerAndCapture({ ...makeDeps(db, runtime, state), narrator: narratorStub("off_setting").narrator, narratorCalls });
    const result = (await handlers.get("debug:listNarratorCalls")!(TRUSTED_EVENT, { limit: 10 })) as {
      availability: string;
      calls: { id: string }[];
    };
    expect(result.availability).toBe("off_setting");
    expect(result.calls.map((call) => call.id)).toEqual(["narr_b", "narr_a"]);
    db.close();
  });

  it("denies debug:listNarratorCalls to a trace window", async () => {
    const { db, state } = seedRepoAndSession();
    const { runtime } = stubRuntime();
    const handlers = registerAndCapture({ ...makeDeps(db, runtime, state, () => "trace"), narratorCalls: createNarratorCallLog() });
    await expect(handlers.get("debug:listNarratorCalls")!(TRUSTED_EVENT, {})).rejects.toMatchObject({ code: "UNTRUSTED_SENDER" });
    db.close();
  });

  it("debug:listNarratorCalls answers only what DebugNarratorCallsPayloadSchema allows and leaves out a bad record (N-4 review, I-3)", async () => {
    const { db, state } = seedRepoAndSession();
    const { runtime } = stubRuntime();
    const record = {
      id: "narr_a", ts: "2026-10-02T09:00:00.000Z", repoRoot: "/a", question: "describeComponents" as const, model: "claude-haiku-4-5-20251001",
      ms: 5, batchSize: 1, accepted: 1, dropped: 0, discarded: false, inputTokens: null, outputTokens: null, costUsd: null, error: null, reasons: [],
    };
    const listing = (calls: unknown[]): NarratorCallLog => ({ record: () => undefined, list: () => calls as NarratorCallRecord[] });
    const list = (narratorCalls: NarratorCallLog) =>
      registerAndCapture({ ...makeDeps(db, runtime, state), narrator: narratorStub().narrator, narratorCalls }).get("debug:listNarratorCalls")!(
        TRUSTED_EVENT,
        {},
      );

    await expect(list(listing([{ ...record, prompt: "model text never crosses IPC" }]))).resolves.toEqual({ availability: "on", calls: [record] });
    // One out-of-cap record is left out; the rest of the list still reaches Inspect.
    await expect(list(listing([{ ...record, id: "narr_bad", model: "m".repeat(65) }, record]))).resolves.toEqual({
      availability: "on",
      calls: [record],
    });
    await expect(list(listing([{ ...record, error: "e".repeat(65) }]))).resolves.toEqual({ availability: "on", calls: [] });

    // One handler logs the error code once, on the first record it leaves out.
    const logged: string[] = [];
    const handler = registerAndCapture({
      ...makeDeps(db, runtime, state),
      log: (message: string) => logged.push(message),
      narrator: narratorStub().narrator,
      narratorCalls: listing([{ ...record, model: "m".repeat(65) }, { ...record, error: "e".repeat(65) }, record]),
    }).get("debug:listNarratorCalls")!;
    await handler(TRUSTED_EVENT, {});
    await handler(TRUSTED_EVENT, {});
    expect(logged.filter((line) => line.startsWith("narrator_record_dropped:"))).toEqual([
      "narrator_record_dropped: debug:listNarratorCalls left out a call record that fails NarratorCallRecordSchema (model: too_big)",
    ]);
    db.close();
  });
});
