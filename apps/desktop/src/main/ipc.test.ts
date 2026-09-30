import { openDb } from "@jevcode/storage";
import type { JevcodeDb } from "@jevcode/storage";
import { RendererToMainChannels } from "@jevcode/contracts";
import { ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";

import { registerIpcHandlers } from "./ipc.js";
import type { IpcDeps } from "./ipc.js";
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

function makeDeps(db: JevcodeDb, runtime: PipelineRuntime, state: AppState): IpcDeps {
  return {
    db,
    state,
    terminals: {} as unknown as IpcDeps["terminals"],
    runtime,
    instructionRouter: { reloadPending: async () => {} } as unknown as IpcDeps["instructionRouter"],
    requestRepoPath: async () => null,
    log: () => {},
    trace: {} as unknown as IpcDeps["trace"],
    senderKind: () => "main",
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
