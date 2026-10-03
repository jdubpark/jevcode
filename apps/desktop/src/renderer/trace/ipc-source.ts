import type { TraceRow, TraceRowsPage, TraceSessionSummary } from "@jevcode/contracts";
import type { TraceRowsRequest, TraceSource } from "@jevcode/trace-viewer";
import { TraceSourceError } from "@jevcode/trace-viewer/sources";
import type { TraceChannel } from "@jevcode/trace-viewer/sources";

import type { JevcodeApi } from "../../shared/api.js";

// The one emitter is main/trace-service.ts ("no session with id <id>"), optionally
// with the serialized "jevcode.ipc.UNKNOWN_SESSION: " prefix. Anchored so other
// errors that merely mention these words stay SOURCE_FAILED.
const UNKNOWN_SESSION_MESSAGE = /^(?:jevcode\.ipc\.UNKNOWN_SESSION: )?no session with id /;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRowsPage(value: unknown): value is TraceRowsPage {
  return (
    isRecord(value) &&
    Array.isArray(value.rows) &&
    typeof value.lastSeq === "number" &&
    typeof value.state === "string"
  );
}

function malformed(channel: TraceChannel): TraceSourceError {
  return new TraceSourceError(channel, "SOURCE_FAILED", `${channel} returned a malformed result`);
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function codeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code: unknown }).code
    : undefined;
}

/** contextBridge copies only an error's message into the page, so the code is also read from the text. */
function toSourceError(channel: TraceChannel, error: unknown): TraceSourceError {
  if (error instanceof TraceSourceError) return error;
  const message = messageOf(error);
  const unknownSession = codeOf(error) === "UNKNOWN_SESSION" || UNKNOWN_SESSION_MESSAGE.test(message);
  return new TraceSourceError(channel, unknownSession ? "UNKNOWN_SESSION" : "SOURCE_FAILED", message);
}

async function call<T>(channel: TraceChannel, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toSourceError(channel, error);
  }
}

/**
 * summary() → trace.listSessions({sessionId, limit: 1}) (TraceSourceError
 * UNKNOWN_SESSION when empty); rows → trace.rows; payloads → trace.payloads;
 * onRowsAvailable → trace.onRowsAvailable for this session; now() → Date.now(). Stateless: the viewer's DataController owns paging, the
 * 1 s live poll, backoff and the terminal-state stop (spec §5.5, §8.3).
 */
export function createIpcTraceSource(bridge: JevcodeApi["trace"], sessionId: string): TraceSource {
  return {
    sessionId,
    summary: () =>
      call("trace:listSessions", async () => {
        const sessions: unknown = await bridge.listSessions({ sessionId, limit: 1 });
        if (!Array.isArray(sessions)) throw malformed("trace:listSessions");
        const found = (sessions as TraceSessionSummary[]).find(
          (session) => isRecord(session) && session.sessionId === sessionId,
        );
        if (found === undefined) {
          throw new TraceSourceError("trace:listSessions", "UNKNOWN_SESSION", `no session with id ${sessionId}`);
        }
        return found;
      }),
    rows: (request: TraceRowsRequest = {}) =>
      call("trace:rows", async (): Promise<TraceRowsPage> => {
        const query: { sessionId: string; afterSeq?: number; limit?: number } = { sessionId };
        if (request.afterSeq !== undefined) query.afterSeq = request.afterSeq;
        if (request.limit !== undefined) query.limit = request.limit;
        const page: unknown = await bridge.rows(query);
        if (!isRowsPage(page)) throw malformed("trace:rows");
        return page;
      }),
    payloads: (seqs) => {
      if (seqs.length === 0) return Promise.resolve([]);
      return call("trace:payloads", async () => {
        const rows: unknown = await bridge.payloads({ sessionId, seqs: [...seqs] });
        if (!Array.isArray(rows)) throw malformed("trace:payloads");
        return rows as TraceRow[];
      });
    },
    now: () => Date.now(),
    // Spec E5: main's push hint, narrowed to this source's session. The
    // DataController polls at once when lastSeq is past its cursor.
    onRowsAvailable: (listener) =>
      bridge.onRowsAvailable((payload) => {
        if (payload.sessionId === sessionId) listener(payload.lastSeq);
      }),
  };
}
