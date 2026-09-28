import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { TraceRow, TraceSessionSummary } from "@jevcode/contracts";

import { FIXTURE_NAMES, loadFixtureTrace, stripCaptureFields } from "../test-support/fixture-rows.js";
import { SYNTHETIC_META, syntheticRows } from "../test-support/synthetic-rows.js";
import { accumulateAll, createTraceState, finalize, foldRows } from "./fold.js";

// accumulate mutates its state in place for speed (R8); these properties are the guard that
// batch boundaries, intermediate finalize calls (one per live poll) and redelivered pages
// never change the result.

function splitAt(rows: readonly TraceRow[], cuts: readonly number[]): TraceRow[][] {
  const points = [...new Set(cuts)].sort((a, b) => a - b);
  const batches: TraceRow[][] = [];
  let start = 0;
  for (const point of points) {
    batches.push(rows.slice(start, point));
    start = point;
  }
  batches.push(rows.slice(start));
  return batches;
}

function checkParity(meta: TraceSessionSummary, rows: readonly TraceRow[], runs: number): void {
  const cutsArb = fc.uniqueArray(fc.integer({ min: 1, max: Math.max(1, rows.length - 1) }), { maxLength: 12 });
  fc.assert(
    fc.property(cutsArb, fc.boolean(), (cuts, live) => {
      const whole = foldRows(meta, rows, { live });
      const state = createTraceState(meta);
      for (const batch of splitAt(rows, cuts)) {
        accumulateAll(state, batch);
        finalize(state, { live });
      }
      expect(finalize(state, { live })).toEqual(whole);
    }),
    { numRuns: runs },
  );
  fc.assert(
    fc.property(fc.integer({ min: 0, max: rows.length }), (prefix) => {
      const state = accumulateAll(createTraceState(meta), rows);
      const before = finalize(state, { live: false });
      accumulateAll(state, rows.slice(0, prefix));
      expect(finalize(state, { live: false })).toEqual(before);
    }),
    { numRuns: Math.max(10, Math.floor(runs / 2)) },
  );
}

describe("fold parity", () => {
  it.each(FIXTURE_NAMES)("%s: any batch split and any redelivered prefix fold the same", (name) => {
    const trace = loadFixtureTrace(name);
    checkParity(trace.meta, trace.rows, 60);
    checkParity(trace.meta, stripCaptureFields(trace.rows), 20);
  });

  it("a 3,000-row synthetic session folds the same in any batch split", () => {
    const rows = syntheticRows(3_000);
    checkParity({ ...SYNTHETIC_META, lastEventSeq: rows.length }, rows, 8);
  });
});
