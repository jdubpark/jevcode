import { openDb } from "@jevcode/storage";
import type { JevcodeDb } from "@jevcode/storage";
import { RendererToMainChannels } from "@jevcode/contracts";
import { ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";

import { deserializeIpcError } from "../shared/api.js";
import { registerIpcHandlers } from "./ipc.js";
import type { IpcDeps } from "./ipc.js";
import type { ExplainerRegistry } from "./pipeline/explainer-stage.js";
import type { PipelineRuntime } from "./pipeline/pipeline-runtime.js";
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
