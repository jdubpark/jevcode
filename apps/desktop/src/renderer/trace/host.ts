import type { ViewerHost } from "@jevcode/trace-viewer";

import type { JevcodeApi } from "../../shared/api.js";

// C2-3 PERF names (spec §10). PERF is not exported from the package root, so
// the host matches the literal values.
const FULL_LOAD_MARK = "tv:full-load";
const VIEWER_MEASURE_PREFIX = "tv:";

/** The session id from trace.html's query; openTraceWindow loads it with {query: {session}}. */
export function sessionIdFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get("session");
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export interface PerfEntryLike {
  name: string;
  entryType: string;
  startTime: number;
  duration: number;
}

/**
 * One console line per viewer perf entry, read by main/smoke.ts and by
 * JEVCODE_TRACE_PERF=1: "TRACE_LOADED <ms>" for the full-load mark,
 * "TRACE_PERF <name> <ms>" for every tv:* measure, null for anything else.
 */
export function traceConsoleLine(entry: PerfEntryLike): string | null {
  if (entry.entryType === "mark" && entry.name === FULL_LOAD_MARK) {
    return `TRACE_LOADED ${Math.round(entry.startTime)}`;
  }
  if (entry.entryType === "measure" && entry.name.startsWith(VIEWER_MEASURE_PREFIX)) {
    return `TRACE_PERF ${entry.name} ${entry.duration.toFixed(2)}`;
  }
  return null;
}

/**
 * requestChanges → bridge.trace.requestChanges (a rejection reaches the
 * Inspector); onReady → log(`TRACE_READY ${rows}`) once, even under
 * StrictMode. No onLocation: Electron keeps the location in memory (R20).
 */
export function createDesktopViewerHost(
  bridge: Pick<JevcodeApi, "trace">,
  log: (line: string) => void,
): ViewerHost {
  let ready = false;
  return {
    requestChanges: (request) =>
      bridge.trace.requestChanges({
        sessionId: request.sessionId,
        selected: request.selected,
        text: request.text,
      }),
    onReady: (info) => {
      if (ready) return;
      ready = true;
      log(`TRACE_READY ${info.rows}`);
    },
  };
}
