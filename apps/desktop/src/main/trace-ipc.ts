import { TRACE_LIVE_POLL_MS } from "@jevcode/contracts";
import type { TraceRowsPage } from "@jevcode/contracts";

import type { ToMainChannelName, ToMainPayload } from "../shared/ipc-registry.js";
import { RendererToMainLocalChannels } from "../shared/local-channels.js";
import type { TraceService } from "./trace-service.js";

/** What the ipc.ts wrapper knows about the caller, beyond the parsed payload. */
export interface IpcHandleContext {
  senderId: number;
}

export type IpcHandle = <C extends ToMainChannelName>(
  channel: C,
  fn: (payload: ToMainPayload<C>, context: IpcHandleContext) => unknown | Promise<unknown>,
) => void;

export interface RowsReadAheadDeps {
  /** Runs after the current reply is posted (setImmediate in main). */
  defer(fn: () => void): void;
  /** Epoch ms. */
  now(): number;
}

type RowsRequest = { sessionId: string; afterSeq?: number; limit?: number };

/**
 * trace:rows with one page of read-ahead (M5 full load). A viewer catching up
 * asks for page k+1 only after page k has crossed IPC and the contextBridge, so
 * a serial reader would sit idle for that time on every one of ~100 pages. When
 * a page ends by limit or byte bound (nextAfterSeq set), the next page is read
 * once the reply is posted and held in a single slot; a request for exactly that
 * page (session, afterSeq, limit) within TRACE_LIVE_POLL_MS gets it, still
 * behind the UNKNOWN_SESSION check. The held page is one read transaction, the
 * same snapshot a direct read would return up to one poll period earlier, and its
 * lastSeq is never below the page before it. At most one page is held. A miss
 * reads directly; a failed read-ahead is dropped and the direct read reports it.
 */
export function createRowsReadAhead(
  service: Pick<TraceService, "rows" | "session">,
  deps: RowsReadAheadDeps,
): (request: RowsRequest) => TraceRowsPage {
  let held: { key: string; page: TraceRowsPage; at: number } | null = null;
  const keyOf = (request: RowsRequest): string =>
    JSON.stringify([request.sessionId, request.afterSeq ?? 0, request.limit ?? null]);

  return (request) => {
    const key = keyOf(request);
    const slot = held;
    held = null;
    let page: TraceRowsPage;
    if (slot !== null && slot.key === key && deps.now() - slot.at <= TRACE_LIVE_POLL_MS) {
      service.session(request.sessionId);
      page = slot.page;
    } else {
      page = service.rows(request);
    }
    const nextAfterSeq = page.nextAfterSeq;
    if (nextAfterSeq !== null) {
      const next: RowsRequest = { ...request, afterSeq: nextAfterSeq };
      deps.defer(() => {
        try {
          held = { key: keyOf(next), page: service.rows(next), at: deps.now() };
        } catch {
          held = null;
        }
      });
    }
    return page;
  };
}

/**
 * Registers the three read-only trace channels on the ipc.ts handle wrapper,
 * which checks the sender and zod-parses the request first. The handlers get
 * only the TraceService (a query_only reader underneath): no runtime,
 * instruction router, Jev client or network, so a viewer read can never
 * deliver, cancel or append anything (R5, D9).
 */
export function registerTraceHandlers(
  handle: IpcHandle,
  service: TraceService,
  readAhead: RowsReadAheadDeps = { defer: (fn) => void setImmediate(fn), now: () => Date.now() },
): void {
  const rows = createRowsReadAhead(service, readAhead);
  // -> { sessions: TraceSessionSummary[] }
  handle(RendererToMainLocalChannels.traceListSessions, (request) => ({
    sessions: service.listSessions(request),
  }));
  // -> TraceRowsPage
  handle(RendererToMainLocalChannels.traceRows, (request) => rows(request));
  // -> { rows: TraceRow[] }
  handle(RendererToMainLocalChannels.tracePayloads, (request) => ({
    rows: service.payloads(request),
  }));
}
