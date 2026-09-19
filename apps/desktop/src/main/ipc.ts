import { BrowserWindow, dialog, ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";

import {
  MainToRendererChannels,
  RendererToMainChannels,
  RepoOpenedPayloadSchema,
} from "@jevcode/contracts";
import type { z } from "zod";
import type { JevcodeDb } from "@jevcode/storage";

import { IpcError } from "../shared/errors.js";
import { serializeIpcError } from "../shared/api.js";
import { parseFromMain, parseToMain } from "../shared/ipc-registry.js";
import type {
  FromMainChannelName,
  FromMainPayload,
  ToMainChannelName,
  ToMainPayload,
} from "../shared/ipc-registry.js";
import {
  MainToRendererLocalChannels,
  RendererToMainLocalChannels,
} from "../shared/local-channels.js";
import { dispatchAction } from "./pipeline/action-dispatcher.js";
import type { InstructionRouter } from "./pipeline/instruction-router.js";
import type { PipelineRuntime } from "./pipeline/pipeline-runtime.js";
import { openRepoByPath } from "./repo-service.js";
import {
  buildSessionState,
  startSession,
  stopSession,
  assertSessionInOpenRepo,
} from "./session-service.js";
import type { AppState } from "./state.js";
import type { TerminalManager } from "./terminal-manager.js";

export type RepoOpenedPayload = z.infer<typeof RepoOpenedPayloadSchema>;

let windowRef: BrowserWindow | null = null;

export function setMainWindow(window: BrowserWindow | null): void {
  windowRef = window;
}

export interface IpcDeps {
  db: JevcodeDb;
  state: AppState;
  terminals: TerminalManager;
  runtime: PipelineRuntime;
  instructionRouter: InstructionRouter;
  requestRepoPath: () => Promise<string | null>;
  log: (message: string) => void;
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame;
  if (!frame) {
    throw new IpcError("UNTRUSTED_SENDER", "missing sender frame");
  }
  let protocol = "";
  try {
    protocol = new URL(frame.url).protocol;
  } catch {
    protocol = "";
  }
  if (protocol !== "file:") {
    throw new IpcError(
      "UNTRUSTED_SENDER",
      `untrusted sender frame: ${frame.url}`,
    );
  }
}

export function sendToRenderer<C extends FromMainChannelName>(
  channel: C,
  payload: FromMainPayload<C>,
): void {
  parseFromMain(channel, payload);
  const window = windowRef;
  if (window && !window.isDestroyed()) {
    window.webContents.send(channel, payload);
  }
}

function emitRepoOpened(payload: RepoOpenedPayload): void {
  sendToRenderer(MainToRendererChannels.repoOpened, payload);
}

function emitRecentRepos(db: JevcodeDb): void {
  sendToRenderer(MainToRendererLocalChannels.recentRepos, {
    repositories: db.listRecentRepositories().map((repo) => ({
      repoId: repo.id,
      path: repo.path,
      name: repo.name,
      branch: repo.branch,
      lastOpenedAt: repo.lastOpenedAt,
    })),
  });
}

function emitSessionState(db: JevcodeDb, sessionId: string): void {
  sendToRenderer(
    MainToRendererChannels.sessionState,
    buildSessionState(db, sessionId),
  );
}

function repoOpenedPayload(
  repo: { id: string; path: string; gitRoot: string; branch: string; baseCommit: string },
): RepoOpenedPayload {
  return {
    repoId: repo.id,
    path: repo.path,
    gitRoot: repo.gitRoot,
    branch: repo.branch,
    baseCommit: repo.baseCommit,
  };
}

export function registerIpcHandlers(deps: IpcDeps): void {
  function handle<C extends ToMainChannelName>(
    channel: C,
    fn: (payload: ToMainPayload<C>) => unknown | Promise<unknown>,
  ): void {
    ipcMain.handle(channel, async (event, raw) => {
      assertTrustedSender(event);
      const payload = parseToMain(channel, raw);
      try {
        return await fn(payload);
      } catch (error) {
        deps.log(`ipc ${channel} failed: ${error instanceof Error ? error.message : String(error)}`);
        throw serializeIpcError(error);
      }
    });
  }

  handle(RendererToMainLocalChannels.repoBrowse, async () => {
    const requestedPath = await deps.requestRepoPath();
    if (!requestedPath) return null;
    const { repo, session, info } = await openRepoByPath(deps.db, requestedPath);
    deps.state.repo = repo;
    deps.state.info = info;
    deps.state.session = session;
    const payload = repoOpenedPayload(repo);
    emitRepoOpened(payload);
    emitRecentRepos(deps.db);
    await deps.instructionRouter.reloadPending(session.id);
    return payload;
  });

  handle(RendererToMainChannels.repoOpen, async ({ path }) => {
    const { repo, session, info } = await openRepoByPath(deps.db, path);
    deps.state.repo = repo;
    deps.state.info = info;
    deps.state.session = session;
    const payload = repoOpenedPayload(repo);
    emitRepoOpened(payload);
    emitRecentRepos(deps.db);
    await deps.instructionRouter.reloadPending(session.id);
    return payload;
  });

  handle(RendererToMainChannels.repoClose, async ({ repoId }) => {
    if (deps.state.repo && deps.state.repo.id !== repoId) {
      throw new IpcError(
        "NO_ACTIVE_SESSION",
        `repo ${repoId} is not the open repo`,
      );
    }
    const activeSessionId = deps.state.session?.id;
    if (activeSessionId !== undefined && deps.runtime.hasSession(activeSessionId)) {
      await deps.runtime.stopSession(activeSessionId);
    }
    deps.state.repo = null;
    deps.state.info = null;
    deps.state.session = null;
    return null;
  });

  handle(RendererToMainLocalChannels.repoListRecent, ({ limit }) => {
    return {
      repositories: deps.db.listRecentRepositories(limit ?? 10).map((repo) => ({
        repoId: repo.id,
        path: repo.path,
        name: repo.name,
        branch: repo.branch,
        lastOpenedAt: repo.lastOpenedAt,
      })),
    };
  });

  handle(RendererToMainLocalChannels.repoListSessions, ({ repoId }) => {
    return {
      sessions: deps.db.listSessions(repoId).map((session) => ({
        sessionId: session.id,
        repoId: session.repoId,
        prompt: session.prompt,
        state: session.state,
        startedAt: session.startedAt,
      })),
    };
  });

  handle(RendererToMainChannels.sessionStart, async ({ repoId, prompt, model, reasoningEffort, approvalMode }) => {
    const active = deps.state.session;
    if (!active) {
      throw new IpcError("NO_ACTIVE_SESSION", "no open repo session");
    }
    const info = deps.state.info;
    if (!info) {
      throw new IpcError("NO_ACTIVE_SESSION", "no open repo info");
    }
    startSession(deps.db, repoId, prompt, active.id);
    await deps.runtime.startSession({
      sessionId: active.id,
      repoId,
      repoPath: info.gitRoot,
      prompt,
      baseCommit: info.baseCommit,
      model,
      reasoningEffort,
      approvalMode,
    });
    deps.state.session = deps.db.getSession(active.id) ?? null;
    sendToRenderer(
      MainToRendererChannels.sessionState,
      buildSessionState(deps.db, active.id),
    );
    await deps.instructionRouter.reloadPending(active.id);
    return null;
  });

  handle(RendererToMainChannels.sessionStop, async ({ sessionId }) => {
    assertSessionInOpenRepo(deps.db, sessionId, deps.state.repo?.id);
    await deps.runtime.stopSession(sessionId);
    const payload = stopSession(deps.db, sessionId);
    sendToRenderer(MainToRendererChannels.sessionState, payload);
    return null;
  });

  handle(RendererToMainLocalChannels.sessionSwitch, ({ sessionId }) => {
    const session = deps.db.getSession(sessionId);
    if (!session) {
      throw new IpcError("UNKNOWN_SESSION", `no session with id ${sessionId}`);
    }
    if (deps.state.repo && session.repoId !== deps.state.repo.id) {
      throw new IpcError(
        "NO_ACTIVE_SESSION",
        `session ${sessionId} does not belong to the open repo`,
      );
    }
    deps.state.session = session;
    emitSessionState(deps.db, sessionId);
    void deps.instructionRouter.reloadPending(sessionId);
    return null;
  });

  handle(RendererToMainChannels.agentInterrupt, async ({ sessionId }) => {
    assertSessionInOpenRepo(deps.db, sessionId, deps.state.repo?.id);
    await deps.runtime.interrupt(sessionId);
    return null;
  });

  handle(RendererToMainChannels.agentResume, async ({ sessionId }) => {
    assertSessionInOpenRepo(deps.db, sessionId, deps.state.repo?.id);
    await deps.runtime.resume(sessionId);
    return null;
  });

  handle(RendererToMainChannels.agentSendInstruction, async (instruction) => {
    assertSessionInOpenRepo(deps.db, instruction.sessionId, deps.state.repo?.id);
    await deps.instructionRouter.admit(instruction.sessionId, instruction);
    return null;
  });

  handle(RendererToMainChannels.agentCancelInstruction, async ({ sessionId, instructionId }) => {
    assertSessionInOpenRepo(deps.db, sessionId, deps.state.repo?.id);
    await deps.instructionRouter.cancelInstruction(sessionId, instructionId);
    return null;
  });

  handle(RendererToMainChannels.actionInvoke, async ({ action, params }) => {
    await dispatchAction(
      {
        runtime: deps.runtime,
        db: deps.db,
        terminals: {
          ensure: (sessionId, cwd) => {
            deps.terminals.ensure(sessionId, { cwd });
          },
          data: (_sessionId, _data) => {},
        },
        activeSessionId: () => deps.state.session?.id ?? null,
        repoPath: () => deps.state.info?.gitRoot ?? null,
        log: deps.log,
      },
      action,
      params,
    );
    return null;
  });

  handle(RendererToMainChannels.terminalInput, ({ sessionId, data }) => {
    assertSessionInOpenRepo(deps.db, sessionId, deps.state.repo?.id);
    if (!deps.state.session || !deps.state.info) {
      throw new IpcError("NO_ACTIVE_SESSION", "no open repo session");
    }
    deps.terminals.ensure(sessionId, { cwd: deps.state.info.gitRoot });
    deps.terminals.write(sessionId, data);
    return null;
  });

  handle(RendererToMainChannels.terminalResize, ({ sessionId, cols, rows }) => {
    assertSessionInOpenRepo(deps.db, sessionId, deps.state.repo?.id);
    deps.terminals.resize(sessionId, cols, rows);
    return null;
  });

  handle(
    RendererToMainLocalChannels.terminalGetScrollback,
    ({ sessionId, maxLines }) => {
      assertSessionInOpenRepo(deps.db, sessionId, deps.state.repo?.id);
      return {
        sessionId,
        lines: deps.terminals.scrollbackLines(sessionId, maxLines),
      };
    },
  );

  handle(RendererToMainChannels.surfacePin, ({ surfaceId, pinned }) => {
    const sessionId = deps.state.session?.id;
    if (sessionId !== undefined) {
      deps.runtime.pinSurface(sessionId, surfaceId, pinned);
    }
    return null;
  });

  handle(RendererToMainChannels.surfaceDismiss, ({ surfaceId }) => {
    const sessionId = deps.state.session?.id;
    if (sessionId !== undefined) {
      deps.runtime.dismissSurface(sessionId, surfaceId);
    }
    return null;
  });

  handle(RendererToMainChannels.telemetryFlush, () => {
    const count = deps.db.listTelemetry().length;
    sendToRenderer(MainToRendererChannels.telemetryAck, { count });
    return { count };
  });

  handle(RendererToMainLocalChannels.debugListTelemetry, ({ sessionId, limit }) => {
    const events = deps.db
      .listTelemetry({ sessionId, limit })
      .map((event) => ({
        id: event.id,
        sessionId: event.sessionId,
        type: event.type,
        payload: event.payload,
        ts: event.ts,
      }));
    return { events };
  });

  handle(RendererToMainLocalChannels.debugListEvents, ({ sessionId, limit }) => {
    const target = sessionId ?? deps.state.session?.id ?? "";
    const events = deps.db.listEvents(target, { limit: limit ?? 200 }).map((event) => ({
      id: event.id,
      sessionId: event.sessionId,
      seq: event.seq,
      type: event.type,
      ts: event.ts,
      payload: JSON.parse(event.payloadJson) as Record<string, unknown>,
    }));
    return { events };
  });

  handle(RendererToMainLocalChannels.debugListJevDecisions, ({ sessionId, limit }) => {
    const target = sessionId ?? deps.state.session?.id ?? "";
    const decisions = deps.db
      .listJevDecisions(target, { limit: limit ?? 50 })
      .map((log) => ({
        id: log.id,
        sessionId: log.sessionId,
        changeUnitId: log.changeUnitId,
        inputHash: log.inputHash,
        output: log.output,
        confidence: log.confidence,
        probabilities: log.probabilities,
        latencyMs: log.latencyMs,
        clientKind: log.clientKind,
        clamps: log.clamps,
        ts: log.ts,
      }));
    return { decisions };
  });
}

export function openDirectoryDialog(
  window: BrowserWindow | null,
): Promise<string | null> {
  if (!window) return Promise.resolve(null);
  return dialog
    .showOpenDialog(window, { properties: ["openDirectory"] })
    .then((result) =>
      result.canceled || !result.filePaths[0] ? null : result.filePaths[0],
    );
}
