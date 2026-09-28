import type { TraceRow, TraceRowsPage, TraceSessionSummary } from "@jevcode/contracts";
import { describe, expect, it } from "vitest";

import { cursorAfter, type TraceRowsRequest, type TraceSource } from "./source.js";

const TS = "2026-09-28T10:00:00.000Z";
const T0 = Date.parse(TS);

function agentRow(seq: number): TraceRow {
  return { seq, type: "agent_event", ts: TS, payload: { type: "agent_waiting", sessionId: "sess_1", ts: TS } };
}

// In-memory source bound to one session. rows() follows the paging contract: rows with
// afterSeq < seq <= lastSeq whose type is served (telemetry is filtered out), ascending, at most
// `limit`; nextAfterSeq is the last row's seq only when the page is full.
function fakeSource(log: TraceRow[]): TraceSource {
  const summary: TraceSessionSummary = {
    sessionId: "sess_1",
    repoId: "repo_1",
    repoName: "demo",
    prompt: "p",
    state: "running",
    startedAt: TS,
    endedAt: null,
    lastEventSeq: 0,
  };
  return {
    sessionId: "sess_1",
    summary: async () => ({ ...summary, lastEventSeq: log.length }),
    rows: async ({ afterSeq = 0, limit = 2 }: TraceRowsRequest = {}): Promise<TraceRowsPage> => {
      const lastSeq = log.length;
      const rows = log
        .filter((row) => row.seq > afterSeq && row.seq <= lastSeq && row.type !== "telemetry")
        .slice(0, limit);
      const last = rows[rows.length - 1];
      return {
        rows,
        nextAfterSeq: rows.length === limit && last !== undefined ? last.seq : null,
        lastSeq,
        state: "running",
      };
    },
    payloads: async (seqs) => log.filter((row) => seqs.includes(row.seq)),
    now: () => T0 + 4_000,
  };
}

async function readAll(source: TraceSource, afterSeq: number): Promise<{ seqs: number[]; cursor: number }> {
  const seqs: number[] = [];
  let cursor = afterSeq;
  for (;;) {
    const page = await source.rows({ afterSeq: cursor, limit: 2 });
    seqs.push(...page.rows.map((row) => row.seq));
    cursor = cursorAfter(page);
    if (page.nextAfterSeq === null) return { seqs, cursor };
  }
}

describe("cursorAfter", () => {
  it("continues from nextAfterSeq while pages are full", () => {
    expect(cursorAfter({ rows: [agentRow(1), agentRow(2)], nextAfterSeq: 2, lastSeq: 9, state: "running" })).toBe(2);
  });

  it("jumps to lastSeq on the last page, past rows the source filtered out", () => {
    expect(cursorAfter({ rows: [agentRow(4)], nextAfterSeq: null, lastSeq: 5, state: "running" })).toBe(5);
  });

  it("drives a reader that sees every served seq exactly once, then only new rows", async () => {
    const log = [agentRow(1), agentRow(2), agentRow(3), agentRow(4), { ...agentRow(5), type: "telemetry" }];
    const source = fakeSource(log);

    const first = await readAll(source, 0);
    expect(first.seqs).toEqual([1, 2, 3, 4]);
    expect(first.cursor).toBe(5);

    log.push(agentRow(6));
    const next = await readAll(source, first.cursor);
    expect(next.seqs).toEqual([6]);
    expect(next.cursor).toBe(6);
  });

  it("lets a host object bound to one session stand in as a TraceSource", async () => {
    const source = fakeSource([agentRow(1)]);
    expect(source.sessionId).toBe("sess_1");
    expect((await source.summary()).lastEventSeq).toBe(1);
    expect((await source.rows()).rows.map((row) => row.seq)).toEqual([1]);
    expect((await source.payloads([1, 99])).map((row) => row.seq)).toEqual([1]);
    expect(source.now() - T0).toBe(4_000);
  });
});
