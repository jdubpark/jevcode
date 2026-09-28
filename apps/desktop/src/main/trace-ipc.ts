import type { ToMainChannelName, ToMainPayload } from "../shared/ipc-registry.js";
import { RendererToMainLocalChannels } from "../shared/local-channels.js";
import type { TraceService } from "./trace-service.js";

export type IpcHandle = <C extends ToMainChannelName>(
  channel: C,
  fn: (payload: ToMainPayload<C>) => unknown | Promise<unknown>,
) => void;

/**
 * Registers the three read-only trace channels on the ipc.ts handle wrapper,
 * which checks the sender and zod-parses the request first. The handlers get
 * only the TraceService (a query_only reader underneath): no runtime,
 * instruction router, Jev client or network, so a viewer read can never
 * deliver, cancel or append anything (R5, D9).
 */
export function registerTraceHandlers(handle: IpcHandle, service: TraceService): void {
  // -> { sessions: TraceSessionSummary[] }
  handle(RendererToMainLocalChannels.traceListSessions, (request) => ({
    sessions: service.listSessions(request),
  }));
  // -> TraceRowsPage
  handle(RendererToMainLocalChannels.traceRows, (request) => service.rows(request));
  // -> { rows: TraceRow[] }
  handle(RendererToMainLocalChannels.tracePayloads, (request) => ({
    rows: service.payloads(request),
  }));
}
