import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { TraceRow, TraceSessionSummary } from "@jevcode/contracts";

import { accumulateAll, createTraceState, finalize, type TraceSession } from "../model/index.js";
import { arbRowSession } from "../test-support/row-arbitraries.js";
import { buildConsoleRows, consoleRowStepIds, type ConsoleRowsState } from "./console-rows.js";
import { buildTraceIndex, type TraceIndex } from "./trace-index.js";

const NOW = Date.parse("2026-09-18T09:30:00.000Z");

/** One finalize per cut point, on one fold state: what a Live viewer commits. */
function commits(meta: TraceSessionSummary, rows: readonly TraceRow[], cuts: readonly number[]): TraceSession[] {
  const state = createTraceState(meta);
  const points = [...new Set(cuts.map((cut) => cut % (rows.length + 1)))].sort((a, b) => a - b);
  const out: TraceSession[] = [];
  let at = 0;
  for (const point of [...points, rows.length]) {
    accumulateAll(state, rows.slice(at, point));
    at = point;
    out.push(finalize(state, { live: true, nowMs: NOW }));
  }
  return out;
}

function plain(state: ConsoleRowsState) {
  return { rows: state.rows, byStep: [...state.byStep.entries()] };
}

describe("buildConsoleRows properties (spec §8.2)", () => {
  it("an incremental build equals a fresh build after every commit, and is deterministic", () => {
    fc.assert(
      fc.property(arbRowSession({ maxOps: 60 }), fc.array(fc.nat(), { minLength: 1, maxLength: 4 }), ({ meta, rows }, cuts) => {
        let index: TraceIndex | undefined;
        let previous: ConsoleRowsState | undefined;
        for (const session of commits(meta, rows, cuts)) {
          index = buildTraceIndex(session, index);
          const next = buildConsoleRows(session, index, previous);
          const fresh = buildConsoleRows(session, buildTraceIndex(session));
          expect(plain(next)).toStrictEqual(plain(fresh));
          expect(plain(buildConsoleRows(session, buildTraceIndex(session)))).toStrictEqual(plain(fresh));
          previous = next;
        }
      }),
      { numRuns: 120 },
    );
  });

  it("keys are unique, rows follow step order, and every shown step is indexed to a row that names it", () => {
    fc.assert(
      fc.property(arbRowSession({ maxOps: 60 }), ({ meta, rows }) => {
        const session = finalize(accumulateAll(createTraceState(meta), rows), { live: false });
        const index = buildTraceIndex(session);
        const out = buildConsoleRows(session, index);
        expect(new Set(out.rows.map((row) => row.key)).size).toBe(out.rows.length);
        const firstSeqOf = new Map(session.steps.map((step) => [step.id as string, step.firstSeq]));
        let last = 0;
        for (const row of out.rows) {
          const ids = consoleRowStepIds(row);
          const seq = firstSeqOf.get(ids[0] ?? "") ?? last;
          expect(seq).toBeGreaterThanOrEqual(last);
          last = seq;
        }
        for (const step of session.steps) {
          const at = out.byStep.get(step.id);
          const silent = (step.kind === "guardrail" || step.kind === "attention") &&
            !step.findingIds.some((id) => index.findingsById.get(id)?.anchorStepId === step.id);
          if (silent) {
            expect(at, step.id).toBeUndefined();
            continue;
          }
          expect(at, step.id).toBeDefined();
          expect(consoleRowStepIds(out.rows[at ?? -1] ?? { kind: "summary", key: "", sentences: [] })).toContain(step.id);
        }
      }),
      { numRuns: 150 },
    );
  });
});
