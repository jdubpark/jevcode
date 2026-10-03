import type { TraceRowsPage, TraceSessionSummary } from "@jevcode/contracts";
import { vi } from "vitest";

import type { AgentInstructionStatePayload, JevcodeApi } from "../../shared/api.js";
import type { ComposerPrefillPayload } from "../../shared/local-channels.js";

type Listener<T> = (payload: T) => void;
type RowsHint = { sessionId: string; lastSeq: number };

export function summaryFor(sessionId: string): TraceSessionSummary {
  return {
    sessionId,
    repoId: "repo_1",
    repoName: "api",
    prompt: `prompt for ${sessionId}`,
    state: "running",
    startedAt: "2026-10-02T10:00:00.000Z",
    endedAt: null,
    lastEventSeq: 0,
  };
}

const EMPTY_PAGE: TraceRowsPage = { rows: [], nextAfterSeq: null, lastSeq: 0, state: "running" };

/** A window.jevcode for jsdom tests: every invoke is a vi.fn, every push can be fired by hand. */
export function installFakeBridge() {
  const channel = new Map<string, Set<Listener<unknown>>>();
  const hints = new Set<Listener<RowsHint>>();
  const prefills = new Set<Listener<ComposerPrefillPayload>>();
  const instructions = new Set<Listener<AgentInstructionStatePayload>>();
  const rowsBySession = new Map<string, number>();
  const subscribe = <T>(set: Set<Listener<T>>, listener: Listener<T>): (() => void) => {
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  };
  const channelSet = (name: string): Set<Listener<unknown>> => {
    let set = channel.get(name);
    if (set === undefined) {
      set = new Set();
      channel.set(name, set);
    }
    return set;
  };

  const calls = {
    actionInvoke: vi.fn(async (_action: string, _params: Record<string, unknown>) => undefined),
    sendInstruction: vi.fn(async (_sessionId: string, _text: string, _mode?: "queue" | "steer") => undefined),
    resume: vi.fn(async (_sessionId: string) => undefined),
    interrupt: vi.fn(async (_sessionId: string) => undefined),
    cancelInstruction: vi.fn(async (_sessionId: string, _instructionId: string) => undefined),
    switchTo: vi.fn(async (_sessionId: string) => undefined),
    traceOpen: vi.fn(async (_sessionId: string) => undefined),
    traceRequestChanges: vi.fn(async (_request: unknown) => undefined),
    rescan: vi.fn(async (_repoRoot: string) => undefined),
    pin: vi.fn(async (_surfaceId: string, _pinned: boolean) => undefined),
    dismiss: vi.fn(async (_surfaceId: string) => undefined),
  };

  const api = {
    platform: "test",
    repo: {
      browse: vi.fn(async () => undefined),
      open: vi.fn(async () => undefined),
      listRecent: vi.fn(async () => []),
      listSessions: vi.fn(async () => []),
      close: vi.fn(async () => undefined),
    },
    session: { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), switchTo: calls.switchTo },
    agent: {
      interrupt: calls.interrupt,
      resume: calls.resume,
      sendInstruction: calls.sendInstruction,
      cancelInstruction: calls.cancelInstruction,
    },
    action: { invoke: calls.actionInvoke },
    terminal: {
      input: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined),
      getScrollback: vi.fn(async () => []),
    },
    surface: { pin: calls.pin, dismiss: calls.dismiss },
    telemetry: { flush: vi.fn(async () => ({ count: 0 })) },
    prefs: { get: vi.fn(async () => ({})), set: vi.fn(async () => ({})) },
    debug: {
      listTelemetry: vi.fn(async () => []),
      listEvents: vi.fn(async () => []),
      listJevDecisions: vi.fn(async () => []),
    },
    trace: {
      listSessions: vi.fn(async (request?: { sessionId?: string }) =>
        request?.sessionId === undefined ? [] : [summaryFor(request.sessionId)],
      ),
      rows: vi.fn(async (request: { sessionId: string }) => {
        rowsBySession.set(request.sessionId, (rowsBySession.get(request.sessionId) ?? 0) + 1);
        return EMPTY_PAGE;
      }),
      payloads: vi.fn(async () => []),
      open: calls.traceOpen,
      requestChanges: calls.traceRequestChanges,
      onRowsAvailable: (listener: Listener<RowsHint>) => subscribe(hints, listener),
    },
    overview: { rescan: calls.rescan },
    on: (name: string, listener: Listener<unknown>) => subscribe(channelSet(name), listener),
    onInstructionState: (listener: Listener<AgentInstructionStatePayload>) => subscribe(instructions, listener),
    onPrefsUpdated: () => () => undefined,
    onComposerPrefill: (listener: Listener<ComposerPrefillPayload>) => subscribe(prefills, listener),
  };

  window.jevcode = api as unknown as JevcodeApi;

  return {
    api: api as unknown as JevcodeApi,
    calls,
    rowsCalls: (sessionId: string): number => rowsBySession.get(sessionId) ?? 0,
    rowsListenerCount: (): number => hints.size,
    emitRowsAvailable: (payload: RowsHint): void => {
      for (const listener of [...hints]) listener(payload);
    },
    emitComposerPrefill: (payload: ComposerPrefillPayload): void => {
      for (const listener of [...prefills]) listener(payload);
    },
    emitInstructionState: (payload: AgentInstructionStatePayload): void => {
      for (const listener of [...instructions]) listener(payload);
    },
    emit: (name: string, payload: unknown): void => {
      for (const listener of [...channelSet(name)]) listener(payload);
    },
  };
}

export type FakeBridge = ReturnType<typeof installFakeBridge>;
