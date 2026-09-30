import type { TraceRow, TraceRowsPage, TraceSessionSummary } from "@jevcode/contracts";

import type { TraceSource } from "../source.js";
import { TraceSourceError } from "./errors.js";

export interface LoadedTrace { summary: TraceSessionSummary; rows: TraceRow[]; lastPage: TraceRowsPage }

/** summary(), then rows() from afterSeq 0 until nextAfterSeq is null. */
export async function readAllTraceRows(source: TraceSource, options: { pageSize?: number } = {}): Promise<LoadedTrace> {
  const summary = await source.summary();
  const rows: TraceRow[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = await source.rows(options.pageSize === undefined ? { afterSeq } : { afterSeq, limit: options.pageSize });
    for (const row of page.rows) rows.push(row);
    if (page.nextAfterSeq === null) return { summary, rows, lastPage: page };
    if (page.nextAfterSeq <= afterSeq) {
      throw new TraceSourceError("trace:rows", "SOURCE_FAILED", `rows cursor did not advance past ${afterSeq}`);
    }
    afterSeq = page.nextAfterSeq;
  }
}
