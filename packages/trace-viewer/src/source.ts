import type { TraceRow, TraceRowsPage, TraceSessionSummary } from "@jevcode/contracts";

export interface TraceRowsRequest {
  afterSeq?: number;
  limit?: number;
}

/**
 * The viewer's only input, bound to one session. The Electron host adapts
 * window.jevcode.trace with createIpcTraceSource(bridge.trace, sessionId) (M5);
 * the dev host adapts a parsed TraceBundle with createStaticBundleSource (M4a).
 * The viewer never touches window.jevcode, the network or storage directly.
 */
export interface TraceSource {
  readonly sessionId: string;
  /** The session's summary. Rejects when the session does not exist. */
  summary(): Promise<TraceSessionSummary>;
  /** The paging contract of index §2.1 for this session: afterSeq defaults to 0, limit to TRACE_ROWS_PAGE_DEFAULT. */
  rows(request?: TraceRowsRequest): Promise<TraceRowsPage>;
  /** Rows (any type) for up to TRACE_PAYLOADS_MAX seqs, ascending; same clipping as rows() (spec §5.4); unknown seqs are omitted. */
  payloads(seqs: readonly number[]): Promise<TraceRow[]>;
  /** Epoch ms on the session's source clock: Date.now() over IPC; a virtual clock for a drip source. */
  now(): number;
  /**
   * Optional push hint (spec E5, §8.7): the host calls `listener(lastSeq)` when rows up to lastSeq are stored for
   * this session. A hint carries no rows; the data controller polls at once and keeps its 1 s poll as the fallback.
   * Returns the unsubscribe function.
   */
  onRowsAvailable?(listener: (lastSeq: number) => void): () => void;
}

/** The afterSeq for the request that follows `page`. */
export function cursorAfter(page: TraceRowsPage): number {
  return page.nextAfterSeq ?? page.lastSeq;
}
