import { chmodSync, closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  TRACE_BUNDLE_FORMAT,
  TRACE_BUNDLE_VERSION,
  TRACE_ROWS_PAGE_MAX,
  TraceBundleSchema,
} from "@jevcode/contracts";
import type { TraceBundle, TraceRow, TraceRowsPage } from "@jevcode/contracts";

import { redactText } from "./pipeline/redactor.js";
import { clipTraceRow } from "./trace-service.js";
import type { TraceService } from "./trace-service.js";

export interface BuildTraceBundleOptions {
  homeDir?: string; // default os.homedir()
  now?: () => string; // default () => new Date().toISOString()
  pageSize?: number; // default TRACE_ROWS_PAGE_MAX
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches homeDir only where a path segment ends, so "/Users/ann" maps in
 * "/Users/ann/x" and "/Users/ann" but not in "/Users/anna/x" or "/Users/ann.bak".
 * Returns null for "" and "/", which would otherwise rewrite every path.
 */
function homePattern(homeDir: string): RegExp | null {
  const trimmed = homeDir.replace(/[\\/]+$/, "");
  if (trimmed.length === 0) return null;
  return new RegExp(`${escapeRegExp(trimmed)}(?![\\w.-])`, "g");
}

/**
 * Deep walk: every string passes redactText, then homeDir becomes "~".
 * count adds a string's redaction hits only when redaction changed it, so an
 * already-redacted marker such as "token=[REDACTED:token]" is not counted again.
 */
export function redactBundleValue(
  value: unknown,
  homeDir: string,
): { value: unknown; count: number } {
  const home = homePattern(homeDir);
  let count = 0;
  const walk = (current: unknown): unknown => {
    if (typeof current === "string") {
      const redacted = redactText(current);
      if (redacted.text !== current) count += redacted.count;
      return home === null ? redacted.text : redacted.text.replace(home, "~");
    }
    if (Array.isArray(current)) return current.map(walk);
    if (current !== null && typeof current === "object") {
      return Object.fromEntries(
        Object.entries(current).map(([key, entry]): [string, unknown] => [key, walk(entry)]),
      );
    }
    return current;
  };
  return { value: walk(value), count };
}

/**
 * Pages the service to the end with clipping off, then per row: redactBundleValue
 * over the whole payload, and only then the service's 16 KiB head + tail clip
 * (spec §5.7). A secret that straddles the 4 KiB head cut is redacted before the
 * cut exists. factId is kept as computed, before redaction. One unclipped page is
 * bounded by the reader's 2 MiB payload bound.
 */
export function buildTraceBundle(
  service: TraceService,
  sessionId: string,
  options: BuildTraceBundleOptions = {},
): TraceBundle {
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? (() => new Date().toISOString());
  const pageSize = options.pageSize ?? TRACE_ROWS_PAGE_MAX;
  const summary = service.session(sessionId);
  const rows: TraceRow[] = [];
  let redactionCount = 0;
  let afterSeq = 0;
  let page: TraceRowsPage;
  for (;;) {
    page = service.rows({ sessionId, afterSeq, limit: pageSize }, { clip: false });
    for (const row of page.rows) {
      // Envelope fields (seq, type, ts, factId) are machine values; factId
      // must stay the pre-redaction content id.
      if (!("payload" in row)) {
        rows.push(row);
        continue;
      }
      const payload = redactBundleValue(row.payload, homeDir);
      redactionCount += payload.count;
      rows.push(clipTraceRow({ ...row, payload: payload.value }));
    }
    if (page.nextAfterSeq === null) break;
    afterSeq = page.nextAfterSeq;
  }
  // The summary is re-stamped from the last page so lastEventSeq and state
  // describe exactly the rows in this bundle.
  const session = redactBundleValue(
    { ...summary, lastEventSeq: page.lastSeq, state: page.state },
    homeDir,
  );
  redactionCount += session.count;
  return TraceBundleSchema.parse({
    format: TRACE_BUNDLE_FORMAT,
    version: TRACE_BUNDLE_VERSION,
    exportedAt: now(),
    redactionCount,
    session: session.value,
    rows,
  });
}

/** JSON + "\n", file mode 0o600. Rows are written one at a time, so a large session never becomes one giant string. */
export function writeTraceBundle(filePath: string, bundle: TraceBundle): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const { rows, ...head } = bundle;
  const headJson = JSON.stringify(head);
  const fd = openSync(filePath, "w", 0o600);
  try {
    writeSync(fd, `${headJson.slice(0, -1)},"rows":[`);
    rows.forEach((row, index) => {
      writeSync(fd, `${index === 0 ? "" : ","}${JSON.stringify(row)}`);
    });
    writeSync(fd, "]}\n");
  } finally {
    closeSync(fd);
  }
  // openSync's mode applies only when it creates the file.
  chmodSync(filePath, 0o600);
}
