import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { OverviewSnapshot, TraceRow, TraceSessionSummary } from "@jevcode/contracts";

import { accumulateAll, createTraceState, finalize } from "../model/fold.js";
import { buildOverviewModel, type TraceSession } from "../model/index.js";
import { arbTraceSession } from "../test-support/arbitraries.js";
import { overviewSnapshot } from "../test-support/overview-builder.js";
import { arbDenseRowSession, arbRowSession, OVERVIEW_ROWS, soakShapedRows } from "../test-support/row-arbitraries.js";
import { arbEdit, editSession } from "../test-support/session-edits.js";
import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { buildBrief, type BriefModel } from "./brief.js";
import { componentDetails, type ComponentDetails } from "./map-details.js";
import { buildTraceIndex, type TraceIndex } from "./trace-index.js";

// buildBrief and componentDetails keep each part from the previous call while what that part reads is the same object
// (finalize keeps unchanged steps, chapters, entities, overview and whys; spec §6.4). After any chain of commits, each
// result must deep-equal a fresh build: the same builder on a structured clone of the session, which shares no object
// with the chain, so no cache can answer it. The chains' results are compared only after the whole chain ran, so a later
// commit that changed an earlier result would fail too.

const NOW = Date.parse("2026-09-18T09:30:00.000Z");

/** Snapshots whose components hold the arbitraries' files, so component joins, changes and decisions are not empty. */
const COVERING: readonly OverviewSnapshot[] = [
  overviewSnapshot({
    components: [{ rootPath: "src", role: "domain", files: ["src/a.ts", "src/b.ts"] }, { rootPath: "tests", role: "tooling" }, { rootPath: ".", name: "root" }],
    edges: [{ from: "tests", to: "src", count: 3 }],
    narrative: { provenance: "model", sentences: [{ text: "Source and tests.", citations: [{ kind: "file", id: "src/a.ts" }] }] },
  }),
  overviewSnapshot({
    components: [
      { rootPath: "src", role: "domain", files: ["src/a.ts", "src/b.ts"], purpose: "The app.", provenance: "model" },
      { rootPath: "tests", role: "tooling" },
      { rootPath: ".", name: "root" },
    ],
    edges: [{ from: "tests", to: "src", count: 3 }],
  }),
  // A rescan moves src/b.ts to tests (a listed file wins) and adds the catch-all.
  overviewSnapshot({
    components: [
      { rootPath: "src", role: "domain", files: ["src/a.ts"], version: 1 },
      { rootPath: "tests", role: "tooling", files: ["tests/a.test.ts", "src/b.ts"] },
      { rootPath: "(other)", name: "other" },
    ],
    edges: [{ from: "tests", to: "src", count: 1 }, { from: "src", to: "tests", count: 2 }],
  }),
];

/** The arbitraries' overview rows with covering snapshots in their place (invalid overview rows stay as they are). */
function covering(rows: readonly TraceRow[]): TraceRow[] {
  const shapes = OVERVIEW_ROWS.map((snapshot) => JSON.stringify(snapshot));
  return rows.map((row) => {
    if (row.type !== "overview_snapshot") return row;
    const at = shapes.indexOf(JSON.stringify(row.payload));
    return at < 0 ? row : { ...row, payload: COVERING[at] ?? row.payload };
  });
}

interface Commit { session: TraceSession; index: TraceIndex }

/**
 * Commits at the cuts, plus a commit of its own for every explainer and overview row (one that changes only the
 * explainer or the overview). After a commit, `extras` may add one that moves only the clock (a running step's
 * duration, so the steps list changes) or one that changes nothing (a new session with the same parts).
 */
function foldCommits(
  meta: TraceSessionSummary, rows: readonly TraceRow[], cuts: readonly number[], extras: readonly number[], live: boolean,
): Commit[] {
  const alone = rows.flatMap((row, at) => (row.type === "explainer" || row.type === "overview_snapshot" ? [at, at + 1] : []));
  const points = [...new Set([...cuts.map((cut) => cut % Math.max(1, rows.length)), ...alone])]
    .filter((point) => point > 0 && point < rows.length)
    .sort((a, b) => a - b);
  const state = createTraceState(meta);
  const out: Commit[] = [];
  let index: TraceIndex | undefined;
  let nowMs = NOW;
  const commit = (): void => {
    const session = finalize(state, { live, nowMs });
    index = buildTraceIndex(session, index);
    out.push({ session, index });
  };
  let start = 0;
  for (const point of [...points, rows.length]) {
    accumulateAll(state, rows.slice(start, point));
    start = point;
    nowMs += 1_000;
    commit();
    const extra = extras[out.length % Math.max(1, extras.length)] ?? 0;
    if (extra === 1) {
      nowMs += 1_000;
      commit();
    } else if (extra === 2) {
      commit();
    }
  }
  return out;
}

/** The component a commit's Inspector shows: a pick held for three commits; one in eight is no longer in the map. */
function componentOf(session: TraceSession, picks: readonly number[], at: number): string | null {
  const overview = session.overview;
  if (overview === null) return null;
  const pick = picks.length === 0 ? 0 : (picks[Math.floor(at / 3) % picks.length] ?? 0);
  if (pick % 8 === 7) return "cmp_000000000000";
  const components = overview.snapshot.components;
  return components.length === 0 ? null : (components[pick % components.length]?.id ?? null);
}

/**
 * Builds the chain's Brief and component details (each skipped on some commits, as when the panel shows the other one),
 * then checks every result against a fresh build.
 */
function checkChain(commits: readonly Commit[], picks: readonly number[], skips: readonly boolean[]): void {
  const skip = (at: number): boolean => skips.length > 0 && (skips[at % skips.length] ?? false);
  const briefs: (BriefModel | undefined)[] = [];
  const details: ({ id: string; value: ComponentDetails | null } | undefined)[] = [];
  commits.forEach(({ session, index }, at) => {
    if (!skip(at)) briefs[at] = buildBrief(session, index);
    const id = componentOf(session, picks, at);
    if (id !== null && session.overview !== null && !skip(at + 1)) details[at] = { id, value: componentDetails(session.overview, id, session) };
  });
  commits.forEach(({ session }, at) => {
    const fresh = structuredClone(session);
    const brief = briefs[at];
    if (brief !== undefined) expect(brief).toStrictEqual(buildBrief(fresh, buildTraceIndex(fresh)));
    const detail = details[at];
    if (detail !== undefined && fresh.overview !== null) expect(detail.value).toStrictEqual(componentDetails(fresh.overview, detail.id, fresh));
  });
}

const cutsArb = fc.uniqueArray(fc.nat(), { maxLength: 12 });
const extrasArb = fc.array(fc.constantFrom(0, 0, 1, 2), { maxLength: 8 });
const picksArb = fc.array(fc.nat(), { maxLength: 6 });
const skipsArb = fc.array(fc.boolean(), { maxLength: 7 });
const RUNS = Number(process.env["BRIEF_RUNS"] ?? 200);

describe("buildBrief and componentDetails from the previous commit equal a fresh build", () => {
  it("random rows (explainer and overview rows committed alone, clock-only and empty commits)", () => {
    fc.assert(
      fc.property(arbRowSession(), cutsArb, extrasArb, fc.boolean(), picksArb, skipsArb, ({ meta, rows }, cuts, extras, live, picks, skips) =>
        checkChain(foldCommits(meta, covering(rows), cuts, extras, live), picks, skips)),
      { numRuns: RUNS },
    );
  }, 600_000);

  it("random rows over dense id pools", () => {
    fc.assert(
      fc.property(arbDenseRowSession(), cutsArb, extrasArb, picksArb, skipsArb, ({ meta, rows }, cuts, extras, picks, skips) =>
        checkChain(foldCommits(meta, covering(rows), cuts, extras, true), picks, skips)),
      { numRuns: Math.ceil(RUNS / 2) },
    );
  }, 600_000);

  it("soak-shaped rows (runs every unit cites) under a covering overview: random splits", () => {
    const soak = soakShapedRows({ units: 40, runs: 5, reemits: 2 });
    const b = new TraceBuilder();
    b.overview(COVERING[0] ?? OVERVIEW_ROWS[0]);
    const rows = [...b.rows, ...soak.rows.map((row) => ({ ...row, seq: row.seq + 1 }))];
    const meta = testMeta({ lastEventSeq: rows.length });
    fc.assert(
      fc.property(cutsArb, extrasArb, picksArb, skipsArb, (cuts, extras, picks, skips) =>
        checkChain(foldCommits(meta, rows, cuts, extras, true), picks, skips)),
      { numRuns: 15 },
    );
  }, 600_000);

  it("hand-edited sessions: steps and chapters moved, dropped and added, findings re-pinned", () => {
    const overview = buildOverviewModel(COVERING[0] ?? OVERVIEW_ROWS[0], 1);
    fc.assert(
      fc.property(
        arbTraceSession({ maxSteps: 14, maxChapters: 5 }),
        fc.array(fc.array(arbEdit, { maxLength: 6 }), { minLength: 1, maxLength: 6 }),
        fc.boolean(),
        picksArb,
        skipsArb,
        (session, rounds, withOverview, picks, skips) => {
          const first = withOverview ? { ...session, overview } : session;
          const sessions = [first];
          for (const edits of rounds) sessions.push(editSession(sessions[sessions.length - 1] ?? first, edits));
          let index: TraceIndex | undefined;
          const commits = sessions.map((s) => {
            index = buildTraceIndex(s, index);
            return { session: s, index };
          });
          checkChain(commits, picks, skips);
        },
      ),
      { numRuns: RUNS * 2 },
    );
  }, 600_000);
});

// ------------------------------------------------------------ what a commit keeps

/** A live session with an overview, units, an answered decision with its why, and a story. */
function liveSession(): { b: TraceBuilder; state: ReturnType<typeof createTraceState>; commit: () => Commit } {
  const b = new TraceBuilder();
  b.agent({ type: "agent_started", prompt: "Work" });
  b.overview(COVERING[0] ?? OVERVIEW_ROWS[0]);
  for (let i = 0; i < 6; i += 1) {
    const path = i % 2 === 0 ? "src/a.ts" : "tests/a.test.ts";
    b.agent({ type: "file_changed", path, callId: `e${i}` });
    b.fact({ type: "git_hunk", file: path, added: 2, removed: 1, isFormattingOnly: false, isConfigOnly: false, isLockfile: false }, `fact_${i}`);
    b.unit({ id: `u${i}`, files: [path], evidence: [`fact_${i}`], agentCallIds: [`e${i}`] });
  }
  b.decision({ id: "d1", status: "open", affectedChangeUnits: ["u0"] });
  b.decision({ id: "d1", status: "answered", affectedChangeUnits: ["u0"], answer: { decisionId: "d1", decision: { q: "a" }, evidence: [] } });
  b.explainer({ kind: "decision_why", decisionId: "d1", sentence: { text: "Why.", citations: [{ kind: "decision", id: "d1" }] } });
  b.explainer({ kind: "story", sentences: [{ text: "Story.", citations: [{ kind: "step", id: "step:1" }] }], basisSeq: b.rows.length });
  const state = accumulateAll(createTraceState(testMeta({ lastEventSeq: b.rows.length })), b.rows);
  let nowMs = NOW;
  let index: TraceIndex | undefined;
  return {
    b,
    state,
    commit: () => {
      nowMs += 1_000;
      const session = finalize(state, { live: true, nowMs });
      index = buildTraceIndex(session, index);
      return { session, index };
    },
  };
}

describe("buildBrief and componentDetails keep what a commit did not change", () => {
  it("a commit with only a story keeps the changes, architecture, decision cards and component details", () => {
    const { b, state, commit } = liveSession();
    const first = commit();
    const brief = buildBrief(first.session, first.index);
    const overview = first.session.overview;
    if (overview === null) throw new Error("no overview");
    const component = overview.snapshot.components[0]?.id ?? "";
    const details = componentDetails(overview, component, first.session);
    expect(brief.decisions).toHaveLength(1);
    expect(details?.decisions).toHaveLength(1);
    const from = b.rows.length;
    b.explainer({ kind: "story", sentences: [{ text: "Later.", citations: [{ kind: "step", id: "step:2" }] }], basisSeq: b.rows.length });
    accumulateAll(state, b.rows.slice(from));
    const next = commit();
    const again = buildBrief(next.session, next.index);
    expect(next.session.explainer).not.toBe(first.session.explainer);
    expect(again.now).not.toEqual(brief.now);
    expect(again.changes).toBe(brief.changes);
    expect(again.architecture).toBe(brief.architecture);
    expect(again.decisions).toBe(brief.decisions);
    expect(componentDetails(overview, component, next.session)).toBe(details);
  });

  it("a commit that adds a message keeps the changes, architecture and decision cards", () => {
    const { b, state, commit } = liveSession();
    const first = commit();
    const brief = buildBrief(first.session, first.index);
    const from = b.rows.length;
    b.agent({ type: "agent_message", role: "assistant", text: "Still working." });
    accumulateAll(state, b.rows.slice(from));
    const next = commit();
    expect(next.session.steps).not.toBe(first.session.steps);
    const again = buildBrief(next.session, next.index);
    expect(again.changes).toBe(brief.changes);
    expect(again.architecture).toBe(brief.architecture);
    expect(again.decisions).toBe(brief.decisions);
  });
});
