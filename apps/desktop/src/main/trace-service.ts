import {
  TRACE_CLIP_CHARS,
  TRACE_LIST_SESSIONS_DEFAULT,
  TRACE_LIST_SESSIONS_MAX,
  TRACE_ROWS_PAGE_DEFAULT,
  TRACE_ROWS_PAGE_MAX,
  TRACE_ROW_TYPES,
} from "@jevcode/contracts";
import type { TraceRow, TraceRowsPage, TraceSessionSummary } from "@jevcode/contracts";
import { factContentId } from "@jevcode/semantic-core";
import type { TraceReader, TraceReaderRow } from "@jevcode/storage";

import { IpcError } from "../shared/errors.js";

export interface TraceRowsOptions {
  /**
   * Default true. false returns every payload as stored, unclipped. Only
   * buildTraceBundle passes it, because it must redact whole strings before it
   * clips (spec §5.7); the trace:* handlers never pass options.
   */
  clip?: boolean;
}

export interface TraceService {
  /** With sessionId: that one session, even with zero events (spec §5.2); else sessions with events. */
  listSessions(request: { repoId?: string; sessionId?: string; limit?: number }): TraceSessionSummary[];
  /** Throws IpcError("UNKNOWN_SESSION") when the session row is missing. */
  session(sessionId: string): TraceSessionSummary;
  /**
   * Paging contract of section 2.1; types = TRACE_ROW_TYPES; limit defaults to
   * TRACE_ROWS_PAGE_DEFAULT. nextAfterSeq is set when the page is full by
   * limit or by the reader's 2 MiB payload bound (spec §5.2).
   */
  rows(
    request: { sessionId: string; afterSeq?: number; limit?: number },
    options?: TraceRowsOptions,
  ): TraceRowsPage;
  payloads(request: { sessionId: string; seqs: readonly number[] }): TraceRow[];
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** UTF-8 bytes of one code point. A lone surrogate counts 3, as Buffer.byteLength encodes it as U+FFFD. */
function utf8Width(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** Is the UTF-8 length over maxBytes? Each UTF-16 code unit is 1 to 3 UTF-8 bytes, so most strings skip the count. */
function exceedsBytes(value: string, maxBytes: number): boolean {
  if (value.length > maxBytes) return true;
  if (value.length * 3 <= maxBytes) return false;
  return Buffer.byteLength(value, "utf8") > maxBytes;
}

/** The first headBytes and the last tailBytes of UTF-8 around a marker line, cut at code-point boundaries. */
function clipString(value: string, headBytes: number, tailBytes: number): string {
  let headEnd = 0;
  let headUsed = 0;
  while (headEnd < value.length) {
    const codePoint = value.codePointAt(headEnd) ?? 0;
    const width = utf8Width(codePoint);
    if (headUsed + width > headBytes) break;
    headUsed += width;
    headEnd += codePoint > 0xffff ? 2 : 1;
  }
  let tailStart = value.length;
  let tailUsed = 0;
  while (tailStart > headEnd) {
    let start = tailStart - 1;
    if (
      start > headEnd &&
      isLowSurrogate(value.charCodeAt(start)) &&
      isHighSurrogate(value.charCodeAt(start - 1))
    ) {
      start -= 1;
    }
    const width = utf8Width(value.codePointAt(start) ?? 0);
    if (tailUsed + width > tailBytes) break;
    tailUsed += width;
    tailStart = start;
  }
  const omitted = Buffer.byteLength(value, "utf8") - headUsed - tailUsed;
  return `${value.slice(0, headEnd)}\n… [${omitted} bytes clipped] …\n${value.slice(tailStart)}`;
}

/** The diff object of a git_hunk payload; clipPayload leaves its text whole. */
function gitHunkDiff(payload: unknown): object | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  if (record["type"] !== "git_hunk") return undefined;
  const diff = record["diff"];
  return diff !== null && typeof diff === "object" && !Array.isArray(diff) ? diff : undefined;
}

/**
 * Deep walk (spec §5.3). A string over maxBytes of UTF-8 becomes its first
 * maxBytes/4 bytes + "\n… [N bytes clipped] …\n" + its last 3*maxBytes/4
 * bytes, cut at code-point boundaries: 4 KiB + 12 KiB at the default 16 KiB,
 * because failures sit at the end of output. A git_hunk's diff.text is never
 * clipped: it is redacted and capped at 32 KiB when stored (spec §4.3), so
 * Evidence always gets the whole stored diff.
 */
export function clipPayload(
  payload: unknown,
  maxBytes: number = TRACE_CLIP_CHARS,
): { payload: unknown; clipped: boolean } {
  if (!Number.isInteger(maxBytes) || maxBytes < 4) {
    throw new RangeError(`clipPayload: maxBytes must be an integer >= 4, got ${String(maxBytes)}`);
  }
  const headBytes = Math.floor(maxBytes / 4);
  const tailBytes = maxBytes - headBytes;
  const exemptDiff = gitHunkDiff(payload);
  let clipped = false;
  // Returns the same reference when nothing below changed, so unclipped
  // payloads are never copied.
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (!exceedsBytes(value, maxBytes)) return value;
      clipped = true;
      return clipString(value, headBytes, tailBytes);
    }
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((entry: unknown) => {
        const result = walk(entry);
        if (result !== entry) changed = true;
        return result;
      });
      return changed ? next : value;
    }
    if (value !== null && typeof value === "object") {
      let changed = false;
      const entries = Object.entries(value).map(([key, entry]): [string, unknown] => {
        if (value === exemptDiff && key === "text") return [key, entry];
        const result = walk(entry);
        if (result !== entry) changed = true;
        return [key, result];
      });
      // fromEntries defines own data properties, so a "__proto__" key stays data.
      return changed ? Object.fromEntries(entries) : value;
    }
    return value;
  };
  const result = walk(payload);
  return { payload: result, clipped };
}

/** clipPayload over row.payload, with clipped: true only when a string was cut. A row without payload is returned as is. */
export function clipTraceRow(row: TraceRow): TraceRow {
  if (!("payload" in row)) return row;
  const result = clipPayload(row.payload);
  return result.clipped ? { ...row, payload: result.payload, clipped: true } : row;
}

/** JSON.parse(payloadJson); factId = factContentId(sessionId, payload) for evidence_fact rows (before clipping); then clipTraceRow unless options.clip is false. */
export function toTraceRow(
  sessionId: string,
  row: TraceReaderRow,
  options: TraceRowsOptions = {},
): TraceRow {
  const traceRow: TraceRow = { seq: row.seq, type: row.type, ts: row.ts };
  let payload: unknown;
  try {
    payload = JSON.parse(row.payloadJson);
  } catch {
    // A damaged row keeps its place in the sequence without a payload; the
    // fold records it as an invalid_row gap (interfaces §2.1).
    return traceRow;
  }
  if (row.type === "evidence_fact") {
    traceRow.factId = factContentId(sessionId, payload);
  }
  traceRow.payload = payload;
  return options.clip === false ? traceRow : clipTraceRow(traceRow);
}

export function createTraceService(reader: TraceReader): TraceService {
  function session(sessionId: string): TraceSessionSummary {
    const summary = reader.getSession(sessionId);
    if (summary === undefined) {
      throw new IpcError("UNKNOWN_SESSION", `no session with id ${sessionId}`);
    }
    return summary;
  }

  return {
    listSessions(request) {
      const limit = Math.min(request.limit ?? TRACE_LIST_SESSIONS_DEFAULT, TRACE_LIST_SESSIONS_MAX);
      return reader.listSessions({ repoId: request.repoId, sessionId: request.sessionId, limit });
    },
    session,
    rows(request, options = {}) {
      session(request.sessionId);
      const limit = Math.min(request.limit ?? TRACE_ROWS_PAGE_DEFAULT, TRACE_ROWS_PAGE_MAX);
      const page = reader.rows(request.sessionId, request.afterSeq ?? 0, limit, TRACE_ROW_TYPES);
      const last = page.rows.at(-1);
      return {
        rows: page.rows.map((row) => toTraceRow(request.sessionId, row, options)),
        // Full by limit or by the reader's 2 MiB bound: resume after the last row.
        nextAfterSeq: page.full && last !== undefined ? last.seq : null,
        lastSeq: page.lastSeq,
        state: page.state,
      };
    },
    payloads(request) {
      session(request.sessionId);
      return reader
        .payloads(request.sessionId, request.seqs)
        .map((row) => toTraceRow(request.sessionId, row));
    },
  };
}

/** Pages rows() from afterSeq 0 until nextAfterSeq is null. */
export function readAllRows(
  service: TraceService,
  sessionId: string,
  pageSize: number = TRACE_ROWS_PAGE_MAX,
): { rows: TraceRow[]; lastSeq: number; state: TraceSessionSummary["state"] } {
  const rows: TraceRow[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = service.rows({ sessionId, afterSeq, limit: pageSize });
    for (const row of page.rows) rows.push(row);
    if (page.nextAfterSeq === null) {
      return { rows, lastSeq: page.lastSeq, state: page.state };
    }
    afterSeq = page.nextAfterSeq;
  }
}
