import { isTraceRowType } from "@jevcode/contracts";
import type { EventStoreType, JevcodeDb, StoredEvent } from "@jevcode/storage";

import { parseFromMain } from "../shared/ipc-registry.js";
import { isPushAllowed } from "./trace-allowlist.js";
import type { SenderKind } from "./trace-allowlist.js";

export const ROWS_AVAILABLE_CHANNEL = "trace:rowsAvailable" as const;
/** Spec §7: at most one hint per session every 50 ms, coalesced. */
export const ROWS_AVAILABLE_MIN_INTERVAL_MS = 50;

export interface RowsAvailablePayload {
  sessionId: string;
  lastSeq: number;
}

/** The part of an Electron WebContents the emitter uses. */
export interface PushContents {
  readonly id: number;
  send(channel: string, payload: RowsAvailablePayload): void;
  isDestroyed(): boolean;
}

export interface RowsAvailableTarget {
  kind: Exclude<SenderKind, "other">;
  contents: PushContents;
}

export interface RowsAvailableDeps {
  /** The windows that show sessionId right now (rowsAvailableTargets). */
  targets(sessionId: string): readonly RowsAvailableTarget[];
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  intervalMs?: number;
  log?(message: string): void;
}

export interface RowsAvailableEmitter {
  /** A row with this seq is committed for sessionId. */
  notify(sessionId: string, lastSeq: number): void;
  dispose(): void;
}

interface SessionSlot {
  pendingSeq: number;
  lastSentAt: number;
  timer: unknown | null;
}

/**
 * Spec E5 and §7: a one-way, content-free hint so a viewer pulls at once
 * instead of waiting for its 1 s poll. Leading edge: the first append after a
 * quiet 50 ms is sent immediately. Inside the window, later appends only raise
 * the pending seq, and one trailing hint carries the highest seq. A
 * destroyed or failing window never stops the others.
 */
export function createRowsAvailableEmitter(deps: RowsAvailableDeps): RowsAvailableEmitter {
  const interval = deps.intervalMs ?? ROWS_AVAILABLE_MIN_INTERVAL_MS;
  const slots = new Map<string, SessionSlot>();
  let disposed = false;

  function send(sessionId: string, slot: SessionSlot): void {
    slot.timer = null;
    const payload = parseFromMain(ROWS_AVAILABLE_CHANNEL, {
      sessionId,
      lastSeq: slot.pendingSeq,
    }) as RowsAvailablePayload;
    slot.lastSentAt = deps.now();
    for (const target of deps.targets(sessionId)) {
      if (!isPushAllowed(ROWS_AVAILABLE_CHANNEL, target.kind)) continue;
      if (target.contents.isDestroyed()) continue;
      try {
        target.contents.send(ROWS_AVAILABLE_CHANNEL, payload);
      } catch (error) {
        deps.log?.(
          `${ROWS_AVAILABLE_CHANNEL} to ${target.kind} window ${target.contents.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return {
    notify(sessionId, lastSeq) {
      if (disposed || sessionId.length === 0 || !Number.isInteger(lastSeq) || lastSeq <= 0) return;
      let slot = slots.get(sessionId);
      if (slot === undefined) {
        slot = { pendingSeq: 0, lastSentAt: Number.NEGATIVE_INFINITY, timer: null };
        slots.set(sessionId, slot);
      }
      if (lastSeq <= slot.pendingSeq) return;
      slot.pendingSeq = lastSeq;
      if (slot.timer !== null) return;
      const wait = slot.lastSentAt + interval - deps.now();
      if (wait <= 0) {
        send(sessionId, slot);
        return;
      }
      const due = slot;
      due.timer = deps.setTimeout(() => {
        if (!disposed) send(sessionId, due);
      }, wait);
    },
    dispose() {
      disposed = true;
      for (const slot of slots.values()) {
        if (slot.timer !== null) deps.clearTimeout(slot.timer);
      }
      slots.clear();
    },
  };
}

export interface RowsAvailableWindows {
  main: PushContents | null;
  /** AppState.session?.id: the session the main window shows. */
  mainSessionId: string | null;
  /** TraceWindowRegistry.sendersForSession(sessionId). */
  traceSenderIds: readonly number[];
  fromId(id: number): PushContents | null;
}

/** The main window while it shows sessionId, plus every trace window opened on it. */
export function rowsAvailableTargets(sessionId: string, windows: RowsAvailableWindows): RowsAvailableTarget[] {
  const targets: RowsAvailableTarget[] = [];
  if (windows.main !== null && windows.mainSessionId === sessionId) {
    targets.push({ kind: "main", contents: windows.main });
  }
  for (const id of windows.traceSenderIds) {
    const contents = windows.fromId(id);
    if (contents !== null) targets.push({ kind: "trace", contents });
  }
  return targets;
}

export interface ObservedAppend {
  sessionId: string;
  seq: number;
  type: string;
}

/**
 * Wraps db.appendEvent on this instance. Every typed helper (appendAgentEvent,
 * upsertDecision, …) calls this.appendEvent, so all trace rows pass here after
 * their transaction commits. Telemetry and other non-trace rows are not
 * reported, and a throwing listener never fails the write.
 */
export function observeTraceAppends(
  db: Pick<JevcodeDb, "appendEvent">,
  onAppend: (event: ObservedAppend) => void,
): () => void {
  const target = db as { appendEvent: JevcodeDb["appendEvent"] };
  const prior = target.appendEvent;
  const bound = prior.bind(db);
  const observed = (sessionId: string, type: EventStoreType, payload: unknown): StoredEvent => {
    const stored = bound(sessionId, type, payload);
    if (stored.sessionId.length > 0 && isTraceRowType(stored.type)) {
      try {
        onAppend({ sessionId: stored.sessionId, seq: stored.seq, type: stored.type });
      } catch {
        // A hint is advisory; the 1 s poll still delivers the row.
      }
    }
    return stored;
  };
  target.appendEvent = observed;
  return () => {
    if (target.appendEvent === observed) target.appendEvent = prior;
  };
}
