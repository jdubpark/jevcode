import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { TraceRow, TraceSessionSummary } from "@jevcode/contracts";

import { FIXTURE_NAMES, loadFixtureTrace, stripCaptureFields } from "../test-support/fixture-rows.js";
import { arbRowSession, soakShapedRows } from "../test-support/row-arbitraries.js";
import { TraceBuilder } from "../test-support/trace-builder.js";
import { accumulateAll, createTraceState, finalize, foldRows, type FinalizeOptions, type TraceState } from "./fold.js";
import { lastFinalizeWork } from "./fold-finalize.js";
import type { FoldState } from "./fold-state.js";
import type { TraceSession } from "./types.js";

// finalize is incremental (fold-finalize.ts): it keeps derived state between calls and re-derives
// only what new rows can change. These properties hold it to a fresh fold of the same rows after
// every batch (spec P5: incremental == fresh), and check that no session it returned changes later.

const NOW = Date.parse("2026-09-18T09:30:00.000Z");

function batches(rows: readonly TraceRow[], cuts: readonly number[]): TraceRow[][] {
  const points = [...new Set(cuts.map((cut) => cut % Math.max(1, rows.length)))].sort((a, b) => a - b);
  const out: TraceRow[][] = [];
  let start = 0;
  for (const point of points) {
    if (point <= start) continue;
    out.push(rows.slice(start, point));
    start = point;
  }
  out.push(rows.slice(start));
  return out;
}

/** Folds batch by batch, checking each finalize against a fresh fold of the rows so far; then checks
 *  that no returned session changed after later batches. */
function checkIncremental(
  meta: TraceSessionSummary,
  rows: readonly TraceRow[],
  cuts: readonly number[],
  optionsAt: (batch: number) => FinalizeOptions,
): void {
  const state = createTraceState(meta);
  const returned: { session: TraceSession; copy: TraceSession }[] = [];
  let seen = 0;
  batches(rows, cuts).forEach((batch, index) => {
    accumulateAll(state, batch);
    seen += batch.length;
    const options = optionsAt(index);
    const session = finalize(state, options);
    expect(session).toStrictEqual(foldRows(meta, rows.slice(0, seen), options));
    returned.push({ session, copy: structuredClone(session) });
  });
  for (const { session, copy } of returned) expect(session).toStrictEqual(copy);
}

const cutsArb = fc.uniqueArray(fc.nat(), { maxLength: 10 });
const optionsArb = fc.record({
  live: fc.boolean(),
  /** Flip live between batches (a full re-derive) instead of keeping it. */
  flips: fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }),
  vary: fc.boolean(),
  now: fc.boolean(),
});

function optionsOf(arb: { live: boolean; flips: boolean[]; vary: boolean; now: boolean }) {
  return (batch: number): FinalizeOptions => ({
    live: arb.vary ? (arb.flips[batch] ?? arb.live) : arb.live,
    ...(arb.now ? { nowMs: NOW + batch * 1_000 } : {}),
  });
}

describe("incremental finalize", () => {
  it("random rows: every batch finalizes to the fresh fold, and returned sessions never change", () => {
    fc.assert(
      fc.property(arbRowSession(), cutsArb, optionsArb, ({ meta, rows }, cuts, options) => {
        checkIncremental(meta, rows, cuts, optionsOf(options));
      }),
      // INC_RUNS=20000 for a longer local search.
      { numRuns: Number(process.env["INC_RUNS"] ?? 400) },
    );
  }, 600_000);

  it("row by row: every prefix finalizes to the fresh fold", () => {
    fc.assert(
      fc.property(arbRowSession({ maxOps: 25 }), fc.boolean(), ({ meta, rows }, live) => {
        checkIncremental(meta, rows, rows.map((_, index) => index + 1), () => ({ live, nowMs: NOW }));
      }),
      { numRuns: 100 },
    );
  });

  it.each(FIXTURE_NAMES)("%s: every prefix and any batch split finalize to the fresh fold", (name) => {
    const trace = loadFixtureTrace(name);
    for (const rows of [trace.rows, stripCaptureFields(trace.rows)]) {
      for (const live of [false, true]) {
        checkIncremental(trace.meta, rows, rows.map((_, index) => index + 1), () => ({ live, nowMs: NOW }));
      }
      fc.assert(
        fc.property(cutsArb, optionsArb, (cuts, options) => checkIncremental(trace.meta, rows, cuts, optionsOf(options))),
        { numRuns: 20 },
      );
    }
  });

  it("soak-shaped rows (runs every unit cites): any batch split finalizes to the fresh fold", () => {
    const { meta, rows } = soakShapedRows({ units: 60, runs: 6, reemits: 3 });
    fc.assert(
      fc.property(cutsArb, optionsArb, (cuts, options) => checkIncremental(meta, rows, cuts, optionsOf(options))),
      { numRuns: 15 },
    );
  });
});

// ------------------------------------------------------------ identity and work

function soakState(units: number): { state: TraceState; meta: TraceSessionSummary; rows: TraceRow[] } {
  const { meta, rows } = soakShapedRows({ units, runs: 8, reemits: 2 });
  return { state: accumulateAll(createTraceState(meta), rows), meta, rows };
}

/** A drip batch like the Live tick's: one unit re-emitted, a new edit and its unit, a message. */
function dripRows(after: readonly TraceRow[], unit: string, next: number): TraceRow[] {
  const b = new TraceBuilder();
  for (const row of after) b.rows.push(row);
  const unitRow = [...after].reverse().find((row) => row.type === "change_unit" && (row.payload as { id?: string }).id === unit);
  if (unitRow === undefined) throw new Error(`no unit ${unit}`);
  b.raw("change_unit", { ...(unitRow.payload as object), status: "validated" });
  b.agent({ type: "file_changed", path: `src/new${next}.ts`, callId: `edit_new${next}` });
  b.fact({ type: "git_hunk", file: `src/new${next}.ts`, added: 1, removed: 0, isFormattingOnly: false, isConfigOnly: false, isLockfile: false }, `fact_new${next}`);
  b.unit({ id: `cu_new${next}`, files: [`src/new${next}.ts`], evidence: [`fact_new${next}`], agentCallIds: [`edit_new${next}`] });
  b.agent({ type: "agent_message", role: "assistant", text: "Still working" });
  return b.rows.slice(after.length);
}

describe("incremental finalize: identity and work", () => {
  it("keeps every object an append does not change", () => {
    const { state, rows } = soakState(40);
    const before = finalize(state, { live: true, nowMs: NOW });
    const unchanged = finalize(state, { live: true, nowMs: NOW });
    expect(unchanged.steps).toBe(before.steps);
    expect(unchanged.chapters).toBe(before.chapters);
    expect(unchanged.findings).toBe(before.findings);
    expect(unchanged.entities).toBe(before.entities);

    const drip = dripRows(rows, "cu_7", 1);
    accumulateAll(state, drip);
    const after = finalize(state, { live: true, nowMs: NOW });
    const touched = new Set(["unit:cu_7", "unit:cu_new1"]);
    after.chapters.forEach((chapter, index) => {
      if (touched.has(chapter.id)) expect(chapter).not.toBe(before.chapters[index]);
      else expect(chapter).toBe(before.chapters[index]);
    });
    // Old steps keep their objects unless a new chapter joined them (the shared runs).
    const newChapterSteps = new Set(after.chapters.find((chapter) => chapter.id === "unit:cu_new1")?.stepIds);
    before.steps.forEach((step, index) => {
      if (newChapterSteps.has(step.id)) return;
      expect(after.steps[index]).toBe(step);
    });
    before.entities.forEach((entity, index) => expect(after.entities[index]).toBe(entity));
  });

  it("an append re-derives O(appended rows + chapters they reach), not O(session)", () => {
    const work = (units: number) => {
      const { state, rows } = soakState(units);
      finalize(state, { live: true, nowMs: NOW });
      accumulateAll(state, dripRows(rows, "cu_7", 1));
      finalize(state, { live: true, nowMs: NOW + 1_000 });
      return lastFinalizeWork(state as FoldState);
    };
    const small = work(100);
    const large = work(1_000);
    // The drip re-emits cu_7 and adds cu_new1: two chapters, two new steps (the edit its hunk
    // joins, the message), one new entity. cu_new1 cites no shared run, so no other chapter or step
    // is touched, however long the session.
    expect(large).toEqual(small);
    expect(large).toEqual({ steps: 2, stepFields: 2, chapters: 2, validationOnly: 2, entities: 1 });
  });
});
