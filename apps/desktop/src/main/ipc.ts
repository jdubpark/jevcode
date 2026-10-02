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
  DebugNarratorCallsPayloadSchema,
  MainToRendererLocalChannels,
  RendererToMainLocalChannels,
} from "../shared/local-channels.js";
import {
  AGENT_MODEL_PREF_KEY,
  EXPLAIN_WITH_MODEL_PREF_KEY,
  REASONING_EFFORT_PREF_KEY,
  USAGE_BUDGET_PREF_KEY,
  applyPreferencesPatch,
  readAgentPreferences,
} from "../shared/prefs.js";
import { NarratorCallRecordSchema } from "../shared/narrator-log.js";
import type { AgentPreferences, PreferencesView } from "../shared/prefs.js";
import { dispatchAction } from "./pipeline/action-dispatcher.js";
import type { InstructionRouter } from "./pipeline/instruction-router.js";
import { droppedRecordMessage } from "./pipeline/narrator-call-log.js";
import type { NarratorCallLog } from "./pipeline/narrator-call-log.js";
import type { NarratorSwitch } from "./pipeline/narrator-switch.js";
import type { PipelineRuntime } from "./pipeline/pipeline-runtime.js";
import { openRepoByPath } from "./repo-service.js";
import type { ExplainerRegistry } from "./pipeline/explainer-stage.js";
import {
  buildSessionState,
  startSession,
  stopSession,
  assertSessionInOpenRepo,
} from "./session-service.js";
import type { AppState } from "./state.js";
import type { TerminalManager } from "./terminal-manager.js";
import { registerTraceHandlers } from "./trace-ipc.js";
import type { TraceService } from "./trace-service.js";
import { isChannelAllowed } from "./trace-allowlist.js";
import type { SenderKind } from "./trace-allowlist.js";
import type { IpcHandleContext } from "./trace-ipc.js";
import { registerTraceWindowHandlers } from "./trace-window-ipc.js";
import type { TraceWindowIpcDeps } from "./trace-window-ipc.js";

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
  /** Read-only trace access over a query_only reader (trace-ipc.ts). */
  trace: TraceService;
  /** Classifies an IPC sender by webContents id for the channel allowlist (trace-allowlist.ts). */
  senderKind(webContentsId: number): SenderKind;
  /** trace:open and trace:requestChanges (trace-window-ipc.ts). */
  traceWindows: TraceWindowIpcDeps;
  /** The codebase-map explainer stage for the open repo (console-explainer spec §6). */
  explainer?: ExplainerRegistry;
  /** Spec E15: preferences:set flips it; optional so existing harnesses stay valid. */
  narrator?: NarratorSwitch;
  /** Inspect → Narrator (deviation 9). */
  narratorCalls?: NarratorCallLog;
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
    fn: (payload: ToMainPayload<C>, context: IpcHandleContext) => unknown | Promise<unknown>,
  ): void {
    ipcMain.handle(channel, async (event, raw) => {
      assertTrustedSender(event);
      // Spec §8.6: trace windows share the preload, so each sender may use
      // only the channels its kind allows. Checked before zod parsing.
      const sender = deps.senderKind(event.sender.id);
      if (!isChannelAllowed(channel, sender)) {
        deps.log(`ipc ${channel} rejected: ${sender} sender`);
        throw new IpcError("UNTRUSTED_SENDER", `${channel} is not allowed from a ${sender} sender`);
      }
      const payload = parseToMain(channel, raw);
      try {
        return await fn(payload, { senderId: event.sender.id });
      } catch (error) {
        deps.log(`ipc ${channel} failed: ${error instanceof Error ? error.message : String(error)}`);
        throw serializeIpcError(error);
      }
    });
  }

  /**
   * Spec §6.6: explainer problems never affect repo or agent work, so a throw from the explainer
   * (its stage, a narration seam or a status listener) is logged and the handler goes on.
   */
  function toExplainer(what: string, call: (explainer: ExplainerRegistry) => void): void {
    if (deps.explainer === undefined) return;
    try {
      call(deps.explainer);
    } catch (error) {
      deps.log(`explainer ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  handle(RendererToMainLocalChannels.repoBrowse, async () => {
    const requestedPath = await deps.requestRepoPath();
    if (!requestedPath) return null;
    const { repo, session, info } = await openRepoByPath(deps.db, requestedPath);
    deps.state.repo = repo;
    deps.state.info = info;
    deps.state.session = session;
    toExplainer("repoOpened", (explainer) => explainer.repoOpened(repo.gitRoot));
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
    toExplainer("repoOpened", (explainer) => explainer.repoOpened(repo.gitRoot));
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
    const closedRoot = deps.state.repo?.gitRoot;
    if (closedRoot !== undefined) toExplainer("repoClosed", (explainer) => explainer.repoClosed(closedRoot));
    deps.state.repo = null;
    deps.state.info = null;
    deps.state.session = null;
    return null;
  });

  // overview:rescan (spec §6.6 Retry; interfaces §8.3). Only the open repo may be rescanned,
  // so a renderer cannot start a scan of another directory.
  handle(RendererToMainChannels.overviewRescan, ({ repoRoot }) => {
    const openRoot = deps.state.repo?.gitRoot;
    if (openRoot === undefined || repoRoot !== openRoot) {
      throw new IpcError("NO_ACTIVE_SESSION", "overview:rescan: repoRoot is not the open repo");
    }
    toExplainer("rescan", (explainer) => explainer.rescan(repoRoot));
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

  /** Spec §10 disclosure: the settings note reads what leaves the machine from main's switch. */
  const withNarratorAvailability = (prefs: AgentPreferences): PreferencesView =>
    deps.narrator === undefined ? prefs : { ...prefs, narratorAvailability: deps.narrator.availability() };

  handle(RendererToMainLocalChannels.preferencesGet, () => {
    return withNarratorAvailability(readAgentPreferences((key) => deps.db.getPreference(key)));
  });

  handle(RendererToMainLocalChannels.preferencesSet, (patch) => {
    const current = readAgentPreferences((key) => deps.db.getPreference(key));
    const next = applyPreferencesPatch(current, patch);
    deps.db.setPreference(AGENT_MODEL_PREF_KEY, next.model);
    deps.db.setPreference(REASONING_EFFORT_PREF_KEY, next.reasoningEffort);
    // null marks the "unknown" state; storage has no deletePreference.
    deps.db.setPreference(USAGE_BUDGET_PREF_KEY, next.usageBudgetFraction);
    deps.db.setPreference(EXPLAIN_WITH_MODEL_PREF_KEY, next.explainWithModel);
    deps.narrator?.setEnabled(next.explainWithModel);
    const view = withNarratorAvailability(next);
    sendToRenderer(MainToRendererLocalChannels.preferencesUpdated, view);
    return view;
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
    toExplainer("sessionStarted", (explainer) => explainer.sessionStarted(info.gitRoot, active.id));
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
    await deps.runtime.stopSession(sessionId, { teardown: false });
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

  // The answer is parsed too: only the schema's fields, with its string caps, cross to the renderer.
  // Each record is checked on its own, so one out-of-bounds record is left out instead of failing the list;
  // the first one left out is logged once.
  let narratorRecordDropReported = false;
  handle(RendererToMainLocalChannels.debugListNarratorCalls, ({ limit }) =>
    DebugNarratorCallsPayloadSchema.parse({
      availability: deps.narrator?.availability() ?? "off_setting",
      calls: (deps.narratorCalls?.list(limit ?? 50) ?? []).flatMap((call) => {
        const parsed = NarratorCallRecordSchema.safeParse(call);
        if (parsed.success) return [parsed.data];
        if (!narratorRecordDropReported) {
          narratorRecordDropReported = true;
          deps.log(droppedRecordMessage("debug:listNarratorCalls", parsed.error));
        }
        return [];
      }),
    }),
  );

  registerTraceHandlers(handle, deps.trace);
  registerTraceWindowHandlers(handle, deps.traceWindows);
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
