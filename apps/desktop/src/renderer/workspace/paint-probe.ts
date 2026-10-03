import { PERF } from "@jevcode/trace-viewer";
import type { TraceSource } from "@jevcode/trace-viewer";

export interface PerfEntryLike {
  name: string;
  entryType: string;
  startTime: number;
  duration: number;
}

/** "CONSOLE_PAINT <sessionId> <throughSeq> <epochMs>": rows up to throughSeq were on screen at epochMs. */
export function consolePaintLine(sessionId: string, throughSeq: number, epochMs: number): string {
  return `CONSOLE_PAINT ${sessionId} ${throughSeq} ${Math.round(epochMs)}`;
}

/** Row arrivals in renderer time; throughAt(t) is the highest seq that had arrived by t. */
export class SeqLedger {
  private readonly arrivals: Array<{ at: number; seq: number }> = [];

  record(at: number, seq: number): void {
    const last = this.arrivals.at(-1);
    if (last !== undefined && seq <= last.seq) return;
    this.arrivals.push({ at, seq });
  }

  throughAt(at: number): number {
    let through = 0;
    for (const arrival of this.arrivals) {
      if (arrival.at > at) break;
      through = arrival.seq;
    }
    return through;
  }
}

export interface PaintProbe {
  wrap(source: TraceSource): TraceSource;
  onEntry(entry: PerfEntryLike): void;
}

/**
 * Smoke-only (?smoke=1). Spec §11 measures Console append latency as "row
 * stored → line painted". The Shell records tv:live-tick from the page that
 * carried new rows to the paint after its commit. A row counts as painted at
 * that measure's end when it had arrived by the measure's start. Rows that
 * arrive later in the same commit are credited to the next tick, so the
 * estimate errs high.
 */
export function createPaintProbe(deps: { now(): number; timeOrigin: number; log(line: string): void }): PaintProbe {
  let current: { sessionId: string; ledger: SeqLedger } | null = null;
  let lastLogged = 0;
  return {
    wrap(source) {
      const ledger = new SeqLedger();
      current = { sessionId: source.sessionId, ledger };
      lastLogged = 0;
      return {
        ...source,
        rows: async (request) => {
          const page = await source.rows(request);
          const last = page.rows.at(-1);
          if (last !== undefined) ledger.record(deps.now(), last.seq);
          return page;
        },
      };
    },
    onEntry(entry) {
      if (current === null || entry.entryType !== "measure" || entry.name !== PERF.liveTick) return;
      const through = current.ledger.throughAt(entry.startTime);
      if (through <= lastLogged) return;
      lastLogged = through;
      deps.log(consolePaintLine(current.sessionId, through, deps.timeOrigin + entry.startTime + entry.duration));
    },
  };
}

let active: PaintProbe | null = null;

export function installPaintProbe(probe: PaintProbe | null): void {
  active = probe;
}

export function paintProbe(): PaintProbe | null {
  return active;
}
