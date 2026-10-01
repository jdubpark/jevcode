import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { TraceRow, TraceSessionSummary } from "@jevcode/contracts";

import { accumulateAll, createTraceState, finalize } from "../model/fold.js";
import type { TraceSession } from "../model/index.js";
import { arbTraceSession } from "../test-support/arbitraries.js";
import { FIXTURE_NAMES, loadFixtureTrace } from "../test-support/fixture-rows.js";
import { arbRowSession, soakShapedRows } from "../test-support/row-arbitraries.js";
import { arbEdit, editSession } from "../test-support/session-edits.js";
import { TraceBuilder } from "../test-support/trace-builder.js";
import { bandGroupsOf, buildOverviewIndex, overviewIndexWork, stableBeforeT, type OverviewIndex } from "./overview-index.js";
import { buildTimeScale, timeScaleInputOf, type TimeScale } from "./time-scale.js";
import { buildTraceIndex, type TraceIndex } from "./trace-index.js";

// buildOverviewIndex(session, index, scale, previous) keeps a step's marks and a chapter's band pieces while what they
// read is unchanged, including the scale below the point where it moved. It must equal a fresh build (fresh index,
// fresh overview) after every commit, for live scales that grow at the tail and for arbitrary scale changes.

const NOW = Date.parse("2026-09-18T09:30:00.000Z");

interface Commit { session: TraceSession; liveTMs: number | undefined }

function scaleOf({ session, liveTMs }: Commit): TimeScale {
  return buildTimeScale(timeScaleInputOf(session, liveTMs));
}

/**
 * Builds each commit from the previous index and overview, checking the overview against a fresh build (fresh index,
 * fresh overview) every time. `skip(i)` leaves commit i's overview out (a hidden Hybrid view), so the next overview
 * starts from an index that is not its index's direct parent.
 */
function checkChain(commits: readonly Commit[], skip: (commit: number) => boolean = () => false): void {
  let index: TraceIndex | undefined;
  let overview: OverviewIndex | undefined;
  for (const [i, commit] of commits.entries()) {
    index = buildTraceIndex(commit.session, index);
    if (skip(i) && i < commits.length - 1) continue;
    overview = buildOverviewIndex(commit.session, index, scaleOf(commit), overview);
    const freshIndex = buildTraceIndex(commit.session);
    const fresh = buildOverviewIndex(commit.session, freshIndex, scaleOf(commit));
    expect(overview).toStrictEqual(fresh);
    expect(bandGroupsOf(overview)).toStrictEqual(bandGroupsOf(fresh));
  }
}

/** Live: the scale's end follows a clock that moves by `tick` ms per commit (0: not live). */
function foldCommits(meta: TraceSessionSummary, rows: readonly TraceRow[], cuts: readonly number[], tick: number): Commit[] {
  const points = [...new Set(cuts.map((cut) => cut % Math.max(1, rows.length)))].sort((a, b) => a - b);
  const state = createTraceState(meta);
  const out: Commit[] = [];
  let start = 0;
  for (const point of [...points, rows.length]) {
    if (point <= start && point !== rows.length) continue;
    accumulateAll(state, rows.slice(start, point));
    start = point;
    const session = finalize(state, { live: tick > 0, nowMs: NOW + out.length * 1_000 });
    const lastT = session.steps.at(-1)?.tMs ?? 0;
    out.push({ session, liveTMs: tick > 0 ? lastT + out.length * tick : undefined });
  }
  return out;
}

const cutsArb = fc.uniqueArray(fc.nat(), { maxLength: 10 });
const tickArb = fc.constantFrom(0, 500, 20_000, 400_000);

describe("buildOverviewIndex from the previous overview equals a fresh build", () => {
  it("random rows: after every commit, some overviews skipped", () => {
    fc.assert(
      fc.property(arbRowSession(), cutsArb, tickArb, fc.array(fc.boolean(), { maxLength: 12 }), ({ meta, rows }, cuts, tick, skips) =>
        checkChain(foldCommits(meta, rows, cuts, tick), (i) => skips[i] ?? false)),
      { numRuns: Number(process.env["INDEX_RUNS"] ?? 250) },
    );
  }, 600_000);

  it.each(FIXTURE_NAMES)("%s: every prefix and random splits", (name) => {
    const trace = loadFixtureTrace(name);
    checkChain(foldCommits(trace.meta, trace.rows, trace.rows.map((_, index) => index + 1), 1_000));
    fc.assert(fc.property(cutsArb, tickArb, (cuts, tick) => checkChain(foldCommits(trace.meta, trace.rows, cuts, tick))), { numRuns: 15 });
  });

  it("soak-shaped rows (runs every unit cites, validation-only footprints): random splits", () => {
    const { meta, rows } = soakShapedRows({ units: 60, runs: 6, reemits: 3 });
    fc.assert(
      fc.property(cutsArb, tickArb, fc.boolean(), (cuts, tick, skipOdd) =>
        checkChain(foldCommits(meta, rows, cuts, tick), (i) => skipOdd && i % 2 === 1)),
      { numRuns: 12 },
    );
  });

  it("hand-edited sessions under arbitrary scale changes", () => {
    fc.assert(
      fc.property(
        arbTraceSession({ maxSteps: 14, maxChapters: 5 }),
        fc.array(fc.record({ edits: fc.array(arbEdit, { maxLength: 6 }), live: fc.option(fc.nat({ max: 3_600_000 }), { nil: undefined }) }), {
          minLength: 1,
          maxLength: 5,
        }),
        (session, rounds) => {
          const commits: Commit[] = [{ session, liveTMs: undefined }];
          for (const { edits, live } of rounds) {
            commits.push({ session: editSession(commits[commits.length - 1]?.session ?? session, edits), liveTMs: live });
          }
          checkChain(commits, (i) => i % 3 === 1);
          checkChain(commits);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe("stableBeforeT", () => {
  it("is where two scales first map a time differently; below it they agree", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat({ max: 600_000 }), fc.nat({ max: 60_000 })), { maxLength: 12 }),
        fc.option(fc.nat({ max: 900_000 }), { nil: undefined }),
        fc.option(fc.nat({ max: 900_000 }), { nil: undefined }),
        fc.boolean(),
        fc.array(fc.nat({ max: 900_000 }), { maxLength: 3 }),
        (spans, liveA, liveB, dropLast, awaiting) => {
          const work = spans.map(([t, d]): readonly [number, number] => [t, t + d]);
          const a = buildTimeScale({ originMs: 0, work, awaitingFrom: [], ...(liveA === undefined ? {} : { liveTMs: liveA }) });
          const b = buildTimeScale({
            originMs: 0, work: dropLast ? work.slice(0, -1) : work, awaitingFrom: awaiting, ...(liveB === undefined ? {} : { liveTMs: liveB }),
          });
          const bound = stableBeforeT(a, b);
          for (let t = -10; t < Math.min(bound, 2_000_000); t += 997) expect(a.toU(t)).toBe(b.toU(t));
          if (bound === Number.POSITIVE_INFINITY) expect(a.endU).toBe(b.endU);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ------------------------------------------------------------ identity and work

function soakTicks(units: number) {
  const { meta, rows } = soakShapedRows({ units, runs: 8, reemits: 2 });
  const state = accumulateAll(createTraceState(meta), rows);
  const first = finalize(state, { live: true, nowMs: NOW });
  const lastT = first.steps.at(-1)?.tMs ?? 0;
  const index = buildTraceIndex(first);
  const overview = buildOverviewIndex(first, index, buildTimeScale(timeScaleInputOf(first, lastT + 1_000)));
  const b = new TraceBuilder();
  for (const row of rows) b.rows.push(row);
  b.agent({ type: "agent_message", role: "assistant", text: "Still working" });
  accumulateAll(state, b.rows.slice(rows.length));
  const second = finalize(state, { live: true, nowMs: NOW + 1_000 });
  const nextIndex = buildTraceIndex(second, index);
  const next = buildOverviewIndex(second, nextIndex, buildTimeScale(timeScaleInputOf(second, lastT + 2_000)), overview);
  return { overview, next };
}

describe("buildOverviewIndex from the previous overview: identity and work", () => {
  it("a tick that adds a message and moves the live end recomputes O(tail), not O(session)", () => {
    const small = soakTicks(100);
    const large = soakTicks(1_000);
    expect(overviewIndexWork(large.next)).toEqual(overviewIndexWork(small.next));
    // The new message and the tail steps the moved end reaches; chapters whose footprint ends in that tail.
    expect(overviewIndexWork(large.next)).toMatchObject({ full: false });
    expect(overviewIndexWork(large.next)?.steps).toBeLessThan(10);
    expect(overviewIndexWork(large.next)?.chapters).toBeLessThan(5);
  });

  it("keeps every mark and band when the scale maps alike, even for steps at its end", () => {
    const { meta, rows } = soakShapedRows({ units: 30, runs: 4, reemits: 1 });
    const state = accumulateAll(createTraceState(meta), rows);
    const first = finalize(state, { live: true, nowMs: NOW });
    const index = buildTraceIndex(first);
    const overview = buildOverviewIndex(first, index, buildTimeScale(timeScaleInputOf(first)));
    // A commit whose scale is a new object with the same segments: nothing is re-derived.
    const again = buildOverviewIndex(first, index, buildTimeScale(timeScaleInputOf(first)), overview);
    expect(overviewIndexWork(again)).toEqual({ steps: 0, chapters: 0, lanes: 0, full: false });
    expect(again.bands).toStrictEqual(overview.bands);
  });

  it("keeps the marks of every lane no changed step is on", () => {
    const { overview, next } = soakTicks(200);
    expect(next.lanes.edits).toBe(overview.lanes.edits);
    expect(next.lanes.tests).toBe(overview.lanes.tests);
    expect(next.lanes.agent).not.toBe(overview.lanes.agent);
  });

  it("an overview seeds one later build; a second build from it is fresh and still equal", () => {
    const { meta, rows } = soakShapedRows({ units: 12, runs: 3, reemits: 1 });
    const [a, b] = foldCommits(meta, rows, [rows.length - 30], 1_000);
    if (a === undefined || b === undefined) throw new Error("chain");
    const indexA = buildTraceIndex(a.session);
    const first = buildOverviewIndex(a.session, indexA, scaleOf(a));
    const indexB = buildTraceIndex(b.session, indexA);
    expect(overviewIndexWork(buildOverviewIndex(b.session, indexB, scaleOf(b), first))?.full).toBe(false);
    const again = buildOverviewIndex(b.session, indexB, scaleOf(b), first);
    expect(overviewIndexWork(again)?.full).toBe(true);
    expect(again).toStrictEqual(buildOverviewIndex(b.session, buildTraceIndex(b.session), scaleOf(b)));
  });
});
