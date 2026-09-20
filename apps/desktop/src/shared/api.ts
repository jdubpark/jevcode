import {
  AgentInstructionStatePayloadSchema,
  MainToRendererChannels,
} from "@jevcode/contracts";
import type { z } from "zod";

import { IpcError } from "./errors.js";
import {
  fromMainRegistry,
  parseFromMain,
  parseToMain,
} from "./ipc-registry.js";
import type {
  FromMainChannelName,
  FromMainPayload,
  ToMainChannelName,
} from "./ipc-registry.js";
import {
  MainToRendererLocalChannels,
} from "./local-channels.js";
import type {
  DebugEventsPayload,
  DebugJevDecisionsPayload,
  DebugTelemetryPayload,
  RecentReposPayload,
  RepositorySummary,
  RepoSessionsPayload,
  SessionSummary,
} from "./local-channels.js";
import type {
  AgentPreferences,
  AgentPreferencesPatch,
} from "./prefs.js";

export const IPC_ERROR_PREFIX = "jevcode.ipc.";

export type AgentInstructionStatePayload = z.infer<
  typeof AgentInstructionStatePayloadSchema
>;

// The preload sandbox stubs node:crypto, so instruction ids are generated
// without it. Collisions are additionally protected by the durable inbox's
// (sessionId, instructionId) idempotency.
function newInstructionId(): string {
  return `instr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

export function serializeIpcError(error: unknown): Error {
  if (error instanceof IpcError) {
    return new Error(`${IPC_ERROR_PREFIX}${error.code}: ${error.message}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function deserializeIpcError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  const pattern = new RegExp(`${IPC_ERROR_PREFIX.replace(".", "\\.")}([A-Z_]+):\\s*(.*)$`, "s");
  const match = pattern.exec(message);
  if (match) {
    const code = match[1];
    const detail = match[2];
    return new IpcError(code as IpcError["code"], detail ?? message);
  }
  return error;
}

export interface ApiDeps {
  invoke(channel: string, payload: unknown): Promise<unknown>;
  on(channel: string, listener: (payload: unknown) => void): () => void;
  platform: string;
}

export interface JevcodeApi {
  platform: string;
  repo: {
    browse(): Promise<void>;
    open(path: string): Promise<void>;
    listRecent(limit?: number): Promise<RepositorySummary[]>;
    listSessions(repoId: string): Promise<SessionSummary[]>;
    close(repoId: string): Promise<void>;
  };
  session: {
    start(repoId: string, prompt: string): Promise<void>;
    stop(sessionId: string): Promise<void>;
    switchTo(sessionId: string): Promise<void>;
  };
  agent: {
    interrupt(sessionId: string): Promise<void>;
    resume(sessionId: string): Promise<void>;
    sendInstruction(
      sessionId: string,
      text: string,
      mode?: "queue" | "steer",
    ): Promise<void>;
    cancelInstruction(sessionId: string, instructionId: string): Promise<void>;
  };
  action: {
    invoke(
      action: string,
      params: Record<string, unknown>,
      surfaceId?: string,
    ): Promise<void>;
  };
  terminal: {
    input(sessionId: string, data: string): Promise<void>;
    resize(sessionId: string, cols: number, rows: number): Promise<void>;
    getScrollback(sessionId: string, maxLines?: number): Promise<string[]>;
  };
  surface: {
    pin(surfaceId: string, pinned: boolean): Promise<void>;
    dismiss(surfaceId: string): Promise<void>;
  };
  telemetry: {
    flush(sessionId?: string): Promise<{ count: number }>;
  };
  prefs: {
    get(): Promise<AgentPreferences>;
    set(patch: AgentPreferencesPatch): Promise<AgentPreferences>;
  };
  debug: {
    listTelemetry(
      sessionId?: string,
      limit?: number,
    ): Promise<DebugTelemetryPayload["events"]>;
    listEvents(
      sessionId?: string,
      limit?: number,
    ): Promise<DebugEventsPayload["events"]>;
    listJevDecisions(
      sessionId?: string,
      limit?: number,
    ): Promise<DebugJevDecisionsPayload["decisions"]>;
  };
  on<C extends FromMainChannelName>(
    channel: C,
    listener: (payload: FromMainPayload<C>) => void,
  ): () => void;
  onInstructionState(
    listener: (payload: AgentInstructionStatePayload) => void,
  ): () => void;
  onPrefsUpdated(listener: (payload: AgentPreferences) => void): () => void;
}

export function createJevcodeApi(deps: ApiDeps): JevcodeApi {
  async function invoke<C extends ToMainChannelName>(
    channel: C,
    payload: unknown,
  ): Promise<unknown> {
    parseToMain(channel, payload);
    try {
      return await deps.invoke(channel, payload);
    } catch (error) {
      throw deserializeIpcError(error);
    }
  }

  function on<C extends FromMainChannelName>(
    channel: C,
    listener: (payload: FromMainPayload<C>) => void,
  ): () => void {
    if (fromMainRegistry[channel] === undefined) {
      throw new IpcError(
        "UNKNOWN_CHANNEL",
        `fromMain channel not registered: ${channel}`,
      );
    }
    return deps.on(channel, (payload) => {
      try {
        const parsed = parseFromMain(channel, payload);
        listener(parsed);
      } catch (error) {
        console.error(`[jevcode] dropped invalid payload on ${channel}:`, error);
      }
    });
  }

  return {
    platform: deps.platform,
    repo: {
      browse: async () => {
        await invoke("repo:browse", {});
      },
      open: async (path) => {
        await invoke("repo:open", { path });
      },
      listRecent: async (limit) => {
        const result = (await invoke("repo:listRecent", { limit })) as RecentReposPayload;
        return result.repositories;
      },
      listSessions: async (repoId) => {
        const result = (await invoke("repo:listSessions", { repoId })) as RepoSessionsPayload;
        return result.sessions;
      },
      close: async (repoId) => {
        await invoke("repo:close", { repoId });
      },
    },
    session: {
      start: async (repoId, prompt) => {
        await invoke("session:start", { repoId, prompt });
      },
      stop: async (sessionId) => {
        await invoke("session:stop", { sessionId });
      },
      switchTo: async (sessionId) => {
        await invoke("session:switch", { sessionId });
      },
    },
    agent: {
      interrupt: async (sessionId) => {
        await invoke("agent:interrupt", { sessionId });
      },
      resume: async (sessionId) => {
        await invoke("agent:resume", { sessionId });
      },
      sendInstruction: async (sessionId, text, mode = "queue") => {
        await invoke("agent:sendInstruction", {
          id: newInstructionId(),
          sessionId,
          mode,
          text,
        });
      },
      cancelInstruction: async (sessionId, instructionId) => {
        await invoke("agent:cancelInstruction", { sessionId, instructionId });
      },
    },
    action: {
      invoke: async (action, params, surfaceId) => {
        await invoke("action:invoke", { action, params, surfaceId });
      },
    },
    terminal: {
      input: async (sessionId, data) => {
        await invoke("terminal:input", { sessionId, data });
      },
      resize: async (sessionId, cols, rows) => {
        await invoke("terminal:resize", { sessionId, cols, rows });
      },
      getScrollback: async (sessionId, maxLines) => {
        const result = (await invoke("terminal:getScrollback", {
          sessionId,
          maxLines,
        })) as { lines: string[] };
        return result.lines;
      },
    },
    surface: {
      pin: async (surfaceId, pinned) => {
        await invoke("surface:pin", { surfaceId, pinned });
      },
      dismiss: async (surfaceId) => {
        await invoke("surface:dismiss", { surfaceId });
      },
    },
    telemetry: {
      flush: async (sessionId) => {
        return (await invoke("telemetry:flush", { sessionId })) as { count: number };
      },
    },
    prefs: {
      get: async () => {
        return (await invoke("preferences:get", {})) as AgentPreferences;
      },
      set: async (patch) => {
        return (await invoke("preferences:set", patch)) as AgentPreferences;
      },
    },
    debug: {
      listTelemetry: async (sessionId, limit) => {
        const result = (await invoke("debug:listTelemetry", {
          sessionId,
          limit,
        })) as DebugTelemetryPayload;
        return result.events;
      },
      listEvents: async (sessionId, limit) => {
        const result = (await invoke("debug:listEvents", {
          sessionId,
          limit,
        })) as DebugEventsPayload;
        return result.events;
      },
      listJevDecisions: async (sessionId, limit) => {
        const result = (await invoke("debug:listJevDecisions", {
          sessionId,
          limit,
        })) as DebugJevDecisionsPayload;
        return result.decisions;
      },
    },
    on,
    onInstructionState: (listener) =>
      on(MainToRendererChannels.agentInstructionState, listener),
    onPrefsUpdated: (listener) =>
      on(MainToRendererLocalChannels.preferencesUpdated, listener),
  };
}
