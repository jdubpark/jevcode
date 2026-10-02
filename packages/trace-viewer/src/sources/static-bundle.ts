import {
  TRACE_BUNDLE_FORMAT, TRACE_BUNDLE_VERSIONS_SUPPORTED, TRACE_PAYLOADS_MAX, TRACE_ROWS_PAGE_DEFAULT, TraceBundleSchema,
  type TraceBundle, type TraceRow, type TraceRowsPage, type TraceSessionSummary,
} from "@jevcode/contracts";

import type { TraceRowsRequest, TraceSource } from "../source.js";
import { TraceSourceError } from "./errors.js";

export type ParsedBundle =
  | { ok: true; bundle: TraceBundle }
  | { ok: false; code: "NOT_A_TRACE" | "UNSUPPORTED_VERSION"; message: string };

const NOT_A_TRACE: ParsedBundle = { ok: false, code: "NOT_A_TRACE", message: "Not a jevcode trace" };

const SUPPORTED_VERSIONS: readonly unknown[] = TRACE_BUNDLE_VERSIONS_SUPPORTED;

/** v1 and v2 parse (a v1 bundle has no overview_snapshot or explainer rows); any other version is named in the message. */
export function parseTraceBundle(json: unknown): ParsedBundle {
  if (json === null || typeof json !== "object") return NOT_A_TRACE;
  const record = json as { format?: unknown; version?: unknown };
  if (record.format !== TRACE_BUNDLE_FORMAT) return NOT_A_TRACE;
  if (!SUPPORTED_VERSIONS.includes(record.version)) {
    return { ok: false, code: "UNSUPPORTED_VERSION", message: `Trace format v${String(record.version)} is not supported` };
  }
  const parsed = TraceBundleSchema.safeParse(json);
  return parsed.success ? { ok: true, bundle: parsed.data } : NOT_A_TRACE;
}

export interface DripOptions { rowsPerTick: number; intervalMs: number; manual?: boolean; startAtSeq?: number }

export interface StaticBundleSource extends TraceSource {
  /** Rows released so far (all rows without drip). */
  released(): number;
  /** Releases rowsPerTick more rows now (manual drip and tests). */
  tick(): void;
  dispose(): void;
}

const CLOCK_ROW_TYPES: ReadonlySet<string> = new Set(["agent_event", "evidence_fact"]);

function sourceTimeMs(row: TraceRow): number | null {
  if (!CLOCK_ROW_TYPES.has(row.type)) return null;
  const payload = row.payload;
  const ts = payload !== null && typeof payload === "object" ? (payload as { ts?: unknown }).ts : undefined;
  const ms = typeof ts === "string" ? Date.parse(ts) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** First index with rows[i].seq > seq. */
function firstAfter(rows: readonly TraceRow[], seq: number, limit: number): number {
  let lo = 0;
  let hi = limit;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((rows[mid]?.seq ?? Number.POSITIVE_INFINITY) <= seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** rows() returns only released rows; state "running" until the last row, then bundle.session.state; now() = the last released row's source time. */
export function createStaticBundleSource(bundle: TraceBundle, options: { drip?: DripOptions } = {}): StaticBundleSource {
  const rows = [...bundle.rows].sort((a, b) => a.seq - b.seq);
  const drip = options.drip;
  const perTick = Math.max(1, drip?.rowsPerTick ?? rows.length);
  let released = rows.length;
  if (drip !== undefined) released = Math.min(rows.length, firstAfter(rows, drip.startAtSeq ?? 0, rows.length) + perTick);
  const startedAtMs = Date.parse(bundle.session.startedAt);
  let timer: ReturnType<typeof setInterval> | null = null;

  const done = (): boolean => released >= rows.length;
  const lastReleasedSeq = (): number => rows[released - 1]?.seq ?? 0;
  const lastSeq = (): number => (done() ? Math.max(bundle.session.lastEventSeq, lastReleasedSeq()) : lastReleasedSeq());
  const state = (): TraceSessionSummary["state"] => (done() ? bundle.session.state : "running");
  const stop = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const tick = (): void => {
    released = Math.min(rows.length, released + perTick);
    if (done()) stop();
  };
  if (drip !== undefined && drip.manual !== true && !done()) timer = setInterval(tick, Math.max(1, drip.intervalMs));

  return {
    sessionId: bundle.session.sessionId,
    async summary() {
      return { ...bundle.session, state: state(), endedAt: done() ? bundle.session.endedAt : null, lastEventSeq: lastSeq() };
    },
    async rows(request: TraceRowsRequest = {}): Promise<TraceRowsPage> {
      const limit = Math.max(1, request.limit ?? TRACE_ROWS_PAGE_DEFAULT);
      const start = firstAfter(rows, request.afterSeq ?? 0, released);
      const page = rows.slice(start, Math.min(released, start + limit));
      const last = page[page.length - 1];
      return { rows: page, nextAfterSeq: page.length === limit && last !== undefined ? last.seq : null, lastSeq: lastSeq(), state: state() };
    },
    async payloads(seqs: readonly number[]): Promise<TraceRow[]> {
      if (seqs.length > TRACE_PAYLOADS_MAX) {
        throw new TraceSourceError("bundle", "SOURCE_FAILED", `at most ${TRACE_PAYLOADS_MAX} seqs per payloads request`);
      }
      const wanted = new Set(seqs);
      return rows.slice(0, released).filter((row) => wanted.has(row.seq));
    },
    now(): number {
      for (let i = released - 1; i >= 0; i -= 1) {
        const row = rows[i];
        const ms = row === undefined ? null : sourceTimeMs(row);
        if (ms !== null) return ms;
      }
      return startedAtMs;
    },
    released: () => released,
    tick,
    dispose: stop,
  };
}
