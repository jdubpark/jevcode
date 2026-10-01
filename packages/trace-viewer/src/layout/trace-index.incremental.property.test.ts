import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { TraceRow, TraceSessionSummary } from "@jevcode/contracts";

import { accumulateAll, createTraceState, finalize } from "../model/fold.js";
import type { TraceSession, UnitStableId } from "../model/index.js";
import { arbTraceSession } from "../test-support/arbitraries.js";
import { FIXTURE_NAMES, loadFixtureTrace } from "../test-support/fixture-rows.js";
import { arbEdit, editSession } from "../test-support/session-edits.js";
import { arbDenseRowSession, arbRowSession, soakShapedRows } from "../test-support/row-arbitraries.js";
import { TraceBuilder } from "../test-support/trace-builder.js";
import { buildTraceIndex, traceIndexChanges, traceIndexWork, type TraceIndex } from "./trace-index.js";

// buildTraceIndex(session, previous) starts from the previous build and recomputes only the entries that changed
// objects reach. It must equal a fresh build after every commit: on fold sessions (where finalize keeps unchanged
// objects, spec §6.4), and on hand-edited sessions whose joins need not agree (a step listing a chapter that does
// not list it back, dangling ids), where only the session's own fields may be trusted.

const NOW = Date.parse("2026-09-18T09:30:00.000Z");

/** Everything a consumer can read from an index, over the ids and seqs the sessions mention. */
function observe(index: TraceIndex, session: TraceSession, extraIds: readonly string[]) {
  const ids = [...new Set([...session.steps.map((s) => s.id), ...session.chapters.map((c) => c.id), ...extraIds])];
  const chapterIds = [...new Set([...session.chapters.map((c) => c.id), ...extraIds.filter((id) => id.startsWith("unit:"))])];
  const top = Math.max(session.loadedThroughSeq, ...session.steps.map((s) => s.lastSeq), 0) + 2;
  const seqs = Array.from({ length: top + 1 }, (_, seq) => seq);
  const anchors = [...new Set([...seqs, ...chapterIds.map((id) => index.chapterAnchor(id as UnitStableId) ?? -1)])];
  return {
    sessionId: index.sessionId,
    loadedThroughSeq: index.loadedThroughSeq,
    stepFirstSeqs: [...index.stepFirstSeqs],
    tailStepId: index.tailStepId,
    findingsBySeq: index.findingsBySeq.map((f) => f.id),
    findingsById: [...index.findingsById.keys()],
    entries: ids.map((id) => [id, index.entry(id) ?? null]),
    keys: chapterIds.map((id) => [id, index.chapterKey(id as UnitStableId) ?? null, index.chapterAnchor(id as UnitStableId) ?? null]),
    byAnchor: anchors.map((a) => [a, index.chapterByAnchor(a) ?? null, [...index.chaptersByAnchor(a)]]),
    atSeq: seqs.map((seq) => [
      seq, index.chapterAtSeq(seq)?.id ?? null, index.turnAtSeq(seq)?.index ?? null,
      index.stepIndexAtOrBefore(seq), index.stepIndexAtOrAfter(seq),
    ]),
  };
}

/** Builds each session from the previous index, checking it against a fresh build every time. */
function checkChain(sessions: readonly TraceSession[]): void {
  let previous: TraceIndex | undefined;
  let seenIds: string[] = [];
  for (const session of sessions) {
    const next = buildTraceIndex(session, previous);
    const fresh = buildTraceIndex(session);
    seenIds = [...new Set([...seenIds, ...session.steps.map((s) => s.id), ...session.chapters.map((c) => c.id)])];
    expect(observe(next, session, seenIds)).toStrictEqual(observe(fresh, session, seenIds));
    previous = next;
  }
}

function foldChain(meta: TraceSessionSummary, rows: readonly TraceRow[], cuts: readonly number[], live: boolean): TraceSession[] {
  const points = [...new Set(cuts.map((cut) => cut % Math.max(1, rows.length)))].sort((a, b) => a - b);
  const state = createTraceState(meta);
  const out: TraceSession[] = [];
  let start = 0;
  for (const point of [...points, rows.length]) {
    if (point <= start && point !== rows.length) continue;
    accumulateAll(state, rows.slice(start, point));
    start = point;
    out.push(finalize(state, { live, nowMs: NOW + out.length * 1_000 }));
  }
  return out;
}

const cutsArb = fc.uniqueArray(fc.nat(), { maxLength: 10 });

describe("buildTraceIndex from the previous index equals a fresh build", () => {
  it("random rows: after every commit, live or not", () => {
    fc.assert(
      fc.property(arbRowSession(), cutsArb, fc.boolean(), ({ meta, rows }, cuts, live) => {
        checkChain(foldChain(meta, rows, cuts, live));
      }),
      { numRuns: Number(process.env["INDEX_RUNS"] ?? 300) },
    );
  }, 600_000);

  it("dense id pools: after every commit, live or not", () => {
    fc.assert(
      fc.property(arbDenseRowSession(), cutsArb, fc.boolean(), ({ meta, rows }, cuts, live) => {
        checkChain(foldChain(meta, rows, cuts, live));
      }),
      { numRuns: Number(process.env["INDEX_RUNS"] ?? 300) },
    );
  }, 600_000);

  it("row by row", () => {
    fc.assert(
      fc.property(arbRowSession({ maxOps: 25 }), ({ meta, rows }) => {
        checkChain(foldChain(meta, rows, rows.map((_, index) => index + 1), true));
      }),
      { numRuns: 60 },
    );
  });

  it.each(FIXTURE_NAMES)("%s: every prefix and random splits", (name) => {
    const trace = loadFixtureTrace(name);
    checkChain(foldChain(trace.meta, trace.rows, trace.rows.map((_, index) => index + 1), true));
    fc.assert(fc.property(cutsArb, fc.boolean(), (cuts, live) => checkChain(foldChain(trace.meta, trace.rows, cuts, live))), { numRuns: 20 });
  });

  it("soak-shaped rows (runs every unit cites): random splits", () => {
    const { meta, rows } = soakShapedRows({ units: 60, runs: 6, reemits: 3 });
    fc.assert(fc.property(cutsArb, fc.boolean(), (cuts, live) => checkChain(foldChain(meta, rows, cuts, live))), { numRuns: 15 });
  });

  it("hand-edited sessions whose joins disagree: chains of copy-on-write edits", () => {
    fc.assert(
      fc.property(
        arbTraceSession({ maxSteps: 14, maxChapters: 5 }),
        fc.array(fc.array(arbEdit, { maxLength: 6 }), { minLength: 1, maxLength: 5 }),
        (session, rounds) => {
          const chain = [session];
          for (const edits of rounds) chain.push(editSession(chain[chain.length - 1] ?? session, edits));
          checkChain(chain);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("a repeated id that replaces a removed one falls back to a fresh build (review m1)", () => {
    const { meta, rows } = soakShapedRows({ units: 6, runs: 2, reemits: 1 });
    const [session] = foldChain(meta, rows, [], true);
    if (session === undefined || session.steps.length < 2 || session.chapters.length < 2) throw new Error("session");
    // [..., A, B] -> [..., A, A]: every id the new list holds was there before, yet B is gone.
    const steps = [...session.steps.slice(0, -1), session.steps[session.steps.length - 2] ?? session.steps[0]];
    const chapters = [...session.chapters.slice(0, -1), session.chapters[session.chapters.length - 2] ?? session.chapters[0]];
    checkChain([session, { ...session, steps: steps.filter((s) => s !== undefined) }]);
    checkChain([session, { ...session, chapters: chapters.filter((c) => c !== undefined) }]);
  });

  it("a repeated id after a swap counts each earlier id once: [A, B, C] -> [B, A, A] (review 3 m1)", () => {
    const { meta, rows } = soakShapedRows({ units: 6, runs: 2, reemits: 1 });
    const [session] = foldChain(meta, rows, [], true);
    if (session === undefined || session.steps.length < 4 || session.chapters.length < 4) throw new Error("session");
    const swap = <T,>(list: readonly T[]): T[] => {
      const [a, b] = list.slice(-3) as [T, T, T];
      return [...list.slice(0, -3), b, a, a];
    };
    checkChain([session, { ...session, steps: swap(session.steps) }]);
    checkChain([session, { ...session, chapters: swap(session.chapters) }]);
  });

  it("an index seeds one later build; a second build from it, or another session id, is fresh and still equal", () => {
    const { meta, rows } = soakShapedRows({ units: 12, runs: 3, reemits: 1 });
    const [a, b, c] = foldChain(meta, rows, [rows.length - 40, rows.length - 20], true);
    if (a === undefined || b === undefined || c === undefined) throw new Error("chain");
    const first = buildTraceIndex(a);
    const second = buildTraceIndex(b, first);
    expect(traceIndexWork(second)?.full).toBe(false);
    const again = buildTraceIndex(c, first);
    expect(traceIndexWork(again)?.full).toBe(true);
    expect(observe(again, c, [])).toStrictEqual(observe(buildTraceIndex(c), c, []));
    const other = buildTraceIndex({ ...c, meta: { ...c.meta, sessionId: "sess-other" } }, second);
    expect(traceIndexWork(other)?.full).toBe(true);
    expect(buildTraceIndex(b, second)).toBe(second);
  });
});

// ------------------------------------------------------------ identity and work

/** A drip like the Live tick's: one unit re-emitted, a new edit with its unit, a message. */
function dripRows(after: readonly TraceRow[], unit: string, next: number, citeRuns: boolean): TraceRow[] {
  const b = new TraceBuilder();
  for (const row of after) b.rows.push(row);
  const unitRow = [...after].reverse().find((row) => row.type === "change_unit" && (row.payload as { id?: string }).id === unit);
  if (unitRow === undefined) throw new Error(`no unit ${unit}`);
  b.raw("change_unit", { ...(unitRow.payload as object), status: "validated" });
  b.agent({ type: "file_changed", path: `src/new${next}.ts`, callId: `edit_new${next}` });
  b.fact({ type: "git_hunk", file: `src/new${next}.ts`, added: 1, removed: 0, isFormattingOnly: false, isConfigOnly: false, isLockfile: false }, `fact_new${next}`);
  const cited = (unitRow.payload as { validationResults?: string[] }).validationResults ?? [];
  b.unit({
    id: `cu_new${next}`, files: [`src/new${next}.ts`], evidence: [`fact_new${next}`], agentCallIds: [`edit_new${next}`],
    ...(citeRuns ? { validationResults: cited } : {}),
  });
  b.agent({ type: "agent_message", role: "assistant", text: "Still working" });
  return b.rows.slice(after.length);
}

function soakTick(units: number, citeRuns: boolean) {
  const { meta, rows } = soakShapedRows({ units, runs: 8, reemits: 2 });
  const state = accumulateAll(createTraceState(meta), rows);
  const before = finalize(state, { live: true, nowMs: NOW });
  const index = buildTraceIndex(before);
  accumulateAll(state, dripRows(rows, "cu_7", 1, citeRuns));
  const after = finalize(state, { live: true, nowMs: NOW });
  const next = buildTraceIndex(after, index);
  return { before, after, index, next };
}

describe("buildTraceIndex from the previous index: identity and work", () => {
  it("keeps the entry object of every step and chapter a drip does not reach", () => {
    const { before, after, index, next } = soakTick(40, false);
    let kept = 0;
    for (const step of before.steps) {
      if (after.steps.includes(step)) {
        expect(next.entry(step.id)).toBe(index.entry(step.id));
        kept += 1;
      }
    }
    for (const chapter of before.chapters) if (after.chapters.includes(chapter)) expect(next.entry(chapter.id)).toBe(index.entry(chapter.id));
    expect(kept).toBeGreaterThan(before.steps.length - 5);
  });

  it("a drip recomputes O(changed objects) entries and links, not O(session)", () => {
    const work = (units: number) => traceIndexWork(soakTick(units, false).next);
    const small = work(100);
    const large = work(1_000);
    // The drip changes two chapters (cu_7 re-emitted, cu_new1 added) and two steps (the new edit and message);
    // the second chapter's steps and anchors are new, so every other entry is kept however long the session.
    expect(large).toEqual(small);
    expect(large).toMatchObject({ full: false, chapterEntries: 2 });
    expect(large?.stepEntries).toBeLessThanOrEqual(4);
    expect(large?.links).toBeLessThan(40);
  });

  it("a new chapter that cites every shared run re-reads only those runs' chapter lists", () => {
    const small = traceIndexWork(soakTick(100, true).next);
    const large = traceIndexWork(soakTick(1_000, true).next);
    // Each shared run gains the new chapter, so its step entry is recomputed over all its chapters (O(units));
    // no other step or chapter is.
    expect(large?.stepEntries).toBe(small?.stepEntries);
    expect(large?.chapterEntries).toBe(small?.chapterEntries);
    expect(large?.chapterEntries).toBe(2);
  });

  it("a Live chain keeps at most one predecessor reachable (review I2)", () => {
    const { meta, rows } = soakShapedRows({ units: 12, runs: 3, reemits: 1 });
    const [s1, s2, s3] = foldChain(meta, rows, [rows.length - 40, rows.length - 20], true);
    if (s1 === undefined || s2 === undefined || s3 === undefined) throw new Error("chain");
    const a = buildTraceIndex(s1);
    const b = buildTraceIndex(s2, a);
    expect(traceIndexChanges(b)?.from).toBe(a);
    const c = buildTraceIndex(s3, b);
    // c reports its changes from b; b no longer reports (and so no longer holds) a, or every Live commit's index and
    // session would stay reachable from the newest one.
    expect(traceIndexChanges(c)?.from).toBe(b);
    expect(traceIndexChanges(b)).toBeUndefined();
  });
});
