import type { TraceRowsPage, TraceSessionSummary } from "@jevcode/contracts";
import type { TraceSource } from "@jevcode/trace-viewer";
import { describe, expect, it } from "vitest";

import { SeqLedger, consolePaintLine, createPaintProbe } from "./paint-probe.js";

function page(seqs: number[]): TraceRowsPage {
  return {
    rows: seqs.map((seq) => ({ seq, type: "agent_event", ts: "2026-10-02T10:00:00.000Z", payload: {} })),
    nextAfterSeq: null,
    lastSeq: seqs.at(-1) ?? 0,
    state: "running",
  };
}

function source(pages: TraceRowsPage[]): TraceSource {
  let index = 0;
  return {
    sessionId: "s1",
    summary: async () => ({ sessionId: "s1" }) as TraceSessionSummary,
    rows: async () => pages[Math.min(index++, pages.length - 1)] ?? page([]),
    payloads: async () => [],
    now: () => 0,
  };
}

describe("SeqLedger", () => {
  it("answers the highest seq that had arrived by a time", () => {
    const ledger = new SeqLedger();
    ledger.record(10, 3);
    ledger.record(20, 5);
    ledger.record(25, 4);
    expect([ledger.throughAt(5), ledger.throughAt(10), ledger.throughAt(19), ledger.throughAt(30)]).toEqual([0, 3, 3, 5]);
  });
});

describe("createPaintProbe", () => {
  it("logs one CONSOLE_PAINT per live-tick measure that paints new rows, in epoch ms", async () => {
    let now = 100;
    const lines: string[] = [];
    const probe = createPaintProbe({ now: () => now, timeOrigin: 1_000_000, log: (line) => lines.push(line) });
    const wrapped = probe.wrap(source([page([1, 2]), page([3])]));
    await wrapped.rows();
    now = 200;
    await wrapped.rows();
    probe.onEntry({ name: "tv:live-tick", entryType: "measure", startTime: 150, duration: 12 });
    probe.onEntry({ name: "tv:live-tick", entryType: "measure", startTime: 160, duration: 5 });
    probe.onEntry({ name: "tv:first-paint", entryType: "measure", startTime: 300, duration: 5 });
    probe.onEntry({ name: "tv:live-tick", entryType: "measure", startTime: 210, duration: 8 });
    expect(lines).toEqual([consolePaintLine("s1", 2, 1_000_162), consolePaintLine("s1", 3, 1_000_218)]);
    expect(lines[0]).toBe("CONSOLE_PAINT s1 2 1000162");
  });

  it("keeps the wrapped source's other members", () => {
    const probe = createPaintProbe({ now: () => 0, timeOrigin: 0, log: () => undefined });
    const base = { ...source([page([])]), onRowsAvailable: () => () => undefined };
    const wrapped = probe.wrap(base);
    expect(wrapped.sessionId).toBe("s1");
    expect(wrapped.onRowsAvailable).toBe(base.onRowsAvailable);
  });
});
