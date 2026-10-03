import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { NarrativeSentence, TraceRow } from "@jevcode/contracts";

import { sentence } from "../test-support/explainer-fixtures.js";
import { SESSION_ID, TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { accumulateAll, createTraceState, finalize, foldRows } from "./fold.js";
import { emptyExplainer, type ExplainerModel, type TraceSession } from "./types.js";

const S1 = sentence("The agent added the limiter.", { kind: "step", id: "step:1" });
const S2 = sentence("Tests fail in the redis client.", { kind: "component", id: "cmp_000000000001" });
const S3 = sentence("You chose to fail open.", { kind: "decision", id: "d1" });
const SENTENCES: readonly NarrativeSentence[] = [S1, S2, S3];

function fold(b: TraceBuilder, live = false): TraceSession {
  return foldRows(testMeta(), b.rows, { live });
}

function started(): TraceBuilder {
  const b = new TraceBuilder();
  b.agent({ type: "agent_started", prompt: "Add a rate limiter" });
  return b;
}

describe("explainer fold", () => {
  it("is empty without explainer rows", () => {
    expect(fold(started()).explainer).toEqual(emptyExplainer());
  });

  it("keeps the story with the greatest basisSeq and ignores a later row with an older basis", () => {
    const b = started();
    const first = b.explainer({ kind: "story", sentences: [S1], basisSeq: 1 });
    const second = b.explainer({ kind: "story", sentences: [S2], basisSeq: 2 });
    b.explainer({ kind: "story", sentences: [S3], basisSeq: 1 });
    const explainer = fold(b).explainer;
    expect(explainer.story).toEqual({ sentences: [S2], basisSeq: 2, seq: second, provenance: "model" });
    expect(explainer.stories.map((story) => story.seq)).toEqual([first, second]);
  });

  it("adds a story to the summary history only when its sentences change", () => {
    const b = started();
    const first = b.explainer({ kind: "story", sentences: [S1], basisSeq: 1 });
    const same = b.explainer({ kind: "story", sentences: [S1], basisSeq: 3 });
    const explainer = fold(b).explainer;
    expect(explainer.stories.map((story) => story.seq)).toEqual([first]);
    expect(explainer.story?.seq).toBe(same);
  });

  it("folds a story's provenance and reads a row without the field as model text", () => {
    const b = started();
    const rule = b.explainer({ kind: "story", sentences: [S1], basisSeq: 1, provenance: "rule" });
    const legacy = b.explainer({ kind: "story", sentences: [S2], basisSeq: 2 });
    const explainer = fold(b).explainer;
    expect(explainer.stories.map((story) => [story.seq, story.provenance])).toEqual([
      [rule, "rule"],
      [legacy, "model"],
    ]);
  });

  it("keeps the latest why per decision", () => {
    const b = started();
    b.explainer({ kind: "decision_why", decisionId: "d1", sentence: S1 });
    b.explainer({ kind: "decision_why", decisionId: "d2", sentence: S2 });
    b.explainer({ kind: "decision_why", decisionId: "d1", sentence: S3 });
    const why = fold(b).explainer.decisionWhy;
    expect([...why.entries()]).toEqual([["d1", S3], ["d2", S2]]);
  });

  it("replaces highlights by basisSeq", () => {
    const b = started();
    b.explainer({ kind: "highlights", basisSeq: 4, components: [{ id: "cmp_000000000001", state: "changed", unitIds: ["u1"] }] });
    const latest = b.explainer({ kind: "highlights", basisSeq: 6, components: [{ id: "cmp_000000000002", state: "failing", unitIds: [] }] });
    b.explainer({ kind: "highlights", basisSeq: 5, components: [] });
    const highlights = fold(b).explainer.highlights;
    expect(highlights?.seq).toBe(latest);
    expect([...(highlights?.byComponent ?? new Map()).entries()]).toEqual([["cmp_000000000002", { state: "failing", states: ["failing"], unitIds: [] }]]);
  });

  it("carries every state of a component, in canonical order, and reads a row without states as [state]", () => {
    const b = started();
    b.explainer({
      kind: "highlights",
      basisSeq: 4,
      components: [
        { id: "cmp_000000000001", state: "decision", states: ["decision", "new"], unitIds: [] },
        { id: "cmp_000000000002", state: "changed", unitIds: [] },
      ],
    });
    const byComponent = fold(b).explainer.highlights?.byComponent;
    expect(byComponent?.get("cmp_000000000001")?.states).toEqual(["new", "decision"]);
    expect(byComponent?.get("cmp_000000000002")?.states).toEqual(["changed"]);
  });

  it("records an invalid explainer row and a row of another session as gaps and folds neither", () => {
    const b = started();
    const bad = b.raw("explainer", { sessionId: SESSION_ID, kind: "story", sentences: [], basisSeq: 1 });
    const other = b.raw("explainer", { sessionId: "sess-other", kind: "story", sentences: [S1], basisSeq: 1 });
    const session = fold(b);
    expect(session.explainer.story).toBeNull();
    expect(session.gaps.filter((gap) => gap.kind === "invalid_row").map((gap) => gap.atSeq)).toEqual([bad, other]);
    expect(session.hidden.byType.explainer).toBeUndefined();
  });

  it("keeps the same stories array until a story row adds a refresh, so the Console's merge can skip", () => {
    const b = started();
    b.explainer({ kind: "story", sentences: [S1], basisSeq: 1 });
    const state = createTraceState(testMeta());
    accumulateAll(state, b.rows);
    const first = finalize(state, { live: true }).explainer;
    b.explainer({ kind: "decision_why", decisionId: "d1", sentence: S3 });
    b.explainer({ kind: "highlights", basisSeq: 2, components: [{ id: "cmp_000000000001", state: "new", unitIds: [] }] });
    b.explainer({ kind: "story", sentences: [S1], basisSeq: 3 });
    accumulateAll(state, b.rows.slice(-3));
    const second = finalize(state, { live: true }).explainer;
    expect(second).not.toBe(first);
    expect(second.stories).toBe(first.stories);
    b.explainer({ kind: "story", sentences: [S2], basisSeq: 4 });
    accumulateAll(state, b.rows.slice(-1));
    const third = finalize(state, { live: true }).explainer;
    expect(third.stories).not.toBe(first.stories);
    expect(third.stories.map((story) => story.sentences)).toEqual([[S1], [S2]]);
    expect(first.stories.map((story) => story.sentences)).toEqual([[S1]]);
  });

  it("never changes a returned session's explainer and reuses it until an explainer row arrives", () => {
    const b = started();
    b.explainer({ kind: "story", sentences: [S1], basisSeq: 1 });
    const state = createTraceState(testMeta());
    accumulateAll(state, b.rows);
    const first = finalize(state, { live: true });
    const copy = structuredClone(first);
    b.agent({ type: "agent_message", role: "assistant", text: "Working on the redis client." });
    accumulateAll(state, b.rows.slice(-1));
    const second = finalize(state, { live: true });
    expect(second.explainer).toBe(first.explainer);
    b.explainer({ kind: "story", sentences: [S2], basisSeq: 3 });
    accumulateAll(state, b.rows.slice(-1));
    const third = finalize(state, { live: true });
    expect(third.explainer).not.toBe(first.explainer);
    expect(third.explainer.story?.sentences).toEqual([S2]);
    expect(first).toStrictEqual(copy);
  });
});

describe("decision tradeoffs", () => {
  it("carries option tradeoffs from the decision row and omits empty ones", () => {
    const b = started();
    b.decision({
      id: "d1",
      options: [
        { id: "open", label: "Fail open", description: "", tradeoffs: [{ dimension: "availability", consequence: "API stays up." }] },
        { id: "closed", label: "Fail closed", description: "", tradeoffs: [] },
      ],
    });
    const step = fold(b).steps.find((candidate) => candidate.decision !== undefined);
    expect(step?.decision?.options).toEqual([
      { id: "open", label: "Fail open", chosen: false, tradeoffs: [{ dimension: "availability", consequence: "API stays up." }] },
      { id: "closed", label: "Fail closed", chosen: false },
    ]);
  });

  it("drops an option's tradeoffs when a later row gives an explicit empty list", () => {
    const b = started();
    b.decision({ id: "d1", options: [{ id: "open", label: "Fail open", description: "", tradeoffs: [{ dimension: "availability", consequence: "Up." }] }] });
    b.decision({ id: "d1", options: [{ id: "open", label: "Fail open", description: "", tradeoffs: [] }] });
    const step = fold(b).steps.find((candidate) => candidate.decision !== undefined);
    expect(step?.decision?.options).toEqual([{ id: "open", label: "Fail open", chosen: false }]);
  });

  it("keeps an option's tradeoffs when a later row of the decision omits them, as the runtime's answered row does", () => {
    const b = started();
    const withTradeoffs = [
      { id: "open", label: "Fail open", description: "", tradeoffs: [{ dimension: "availability", consequence: "API stays up." }] },
      { id: "closed", label: "Fail closed", description: "", tradeoffs: [{ dimension: "abuse", consequence: "Limits hold." }] },
    ];
    b.decision({ id: "d1", options: withTradeoffs });
    b.decision({
      id: "d1",
      status: "answered",
      options: [
        { id: "open", label: "Fail open", description: "" },
        { id: "closed", label: "Fail closed", description: "", tradeoffs: [{ dimension: "abuse", consequence: "Limits always hold." }] },
      ],
      answer: { decisionId: "d1", decision: { policy: "open" }, evidence: [] },
    });
    const step = fold(b).steps.find((candidate) => candidate.decision !== undefined);
    expect(step?.decision?.options).toEqual([
      { id: "open", label: "Fail open", chosen: true, tradeoffs: [{ dimension: "availability", consequence: "API stays up." }] },
      { id: "closed", label: "Fail closed", chosen: false, tradeoffs: [{ dimension: "abuse", consequence: "Limits always hold." }] },
    ]);
  });
});

type Op =
  | { kind: "story"; back: number; pick: number }
  | { kind: "decision_why"; id: "d1" | "d2"; pick: number }
  | { kind: "highlights"; back: number; state: "new" | "changed" | "decision" | "failing"; also: boolean; unit: "u1" | "u2" }
  | { kind: "agent" };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("story" as const), back: fc.nat(6), pick: fc.nat(2) }),
  fc.record({ kind: fc.constant("decision_why" as const), id: fc.constantFrom("d1" as const, "d2" as const), pick: fc.nat(2) }),
  fc.record({
    kind: fc.constant("highlights" as const),
    back: fc.nat(6),
    state: fc.constantFrom("new" as const, "changed" as const, "decision" as const, "failing" as const),
    also: fc.boolean(),
    unit: fc.constantFrom("u1" as const, "u2" as const),
  }),
  fc.constant<Op>({ kind: "agent" }),
);

function build(ops: readonly Op[]): TraceRow[] {
  const b = started();
  for (const op of ops) {
    const basis = (back: number) => Math.max(0, b.rows.length - back);
    if (op.kind === "agent") b.agent({ type: "agent_message", role: "assistant", text: "step" });
    else if (op.kind === "story") b.explainer({ kind: "story", sentences: [SENTENCES[op.pick] ?? S1], basisSeq: basis(op.back) });
    else if (op.kind === "decision_why") b.explainer({ kind: "decision_why", decisionId: op.id, sentence: SENTENCES[op.pick] ?? S1 });
    else b.explainer({ kind: "highlights", basisSeq: basis(op.back), components: [{ id: "cmp_000000000001", state: op.state, ...(op.also ? { states: [op.state, "new" as const] } : {}), unitIds: [op.unit] }] });
  }
  return b.rows;
}

interface Payload { kind: string; basisSeq?: number; sentences?: NarrativeSentence[]; decisionId?: string; sentence?: NarrativeSentence }

function payloads(rows: readonly TraceRow[]): { seq: number; p: Payload }[] {
  return rows.filter((row) => row.type === "explainer").map((row) => ({ seq: row.seq, p: row.payload as Payload }));
}

/** The row with the greatest (basisSeq, seq), the spec's "latest" under replace semantics. */
function latest(rows: { seq: number; p: Payload }[]): { seq: number; p: Payload } | undefined {
  return rows.reduce<{ seq: number; p: Payload } | undefined>(
    (best, row) => (best === undefined || (row.p.basisSeq ?? 0) > (best.p.basisSeq ?? 0) || ((row.p.basisSeq ?? 0) === (best.p.basisSeq ?? 0) && row.seq > best.seq) ? row : best),
    undefined,
  );
}

function checkAgainstRows(explainer: ExplainerModel, rows: readonly TraceRow[]): void {
  const all = payloads(rows);
  const stories = all.filter((row) => row.p.kind === "story");
  const best = latest(stories);
  expect(explainer.story?.seq ?? null).toBe(best?.seq ?? null);
  // History: increasing seq, non-decreasing basisSeq, neighbours differ, the last one says what the story says.
  const history = explainer.stories;
  for (let i = 1; i < history.length; i += 1) {
    expect(history[i]!.seq).toBeGreaterThan(history[i - 1]!.seq);
    expect(history[i]!.basisSeq).toBeGreaterThanOrEqual(history[i - 1]!.basisSeq);
    expect(history[i]!.sentences).not.toEqual(history[i - 1]!.sentences);
  }
  expect(history.at(-1)?.sentences ?? null).toEqual(explainer.story?.sentences ?? null);
  const whys = all.filter((row) => row.p.kind === "decision_why");
  const lastWhy = new Map<string, NarrativeSentence>();
  for (const row of whys) lastWhy.set(row.p.decisionId ?? "", row.p.sentence as NarrativeSentence);
  expect(new Map(explainer.decisionWhy)).toEqual(lastWhy);
  expect(explainer.highlights?.seq ?? null).toBe(latest(all.filter((row) => row.p.kind === "highlights"))?.seq ?? null);
}

describe("explainer fold properties", () => {
  it("matches the replace semantics, and any batch split finalizes to the fresh fold without changing returned sessions", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 30 }), fc.uniqueArray(fc.nat(40), { maxLength: 6 }), fc.boolean(), (ops, cuts, live) => {
        const rows = build(ops);
        const meta = testMeta();
        const fresh = foldRows(meta, rows, { live });
        checkAgainstRows(fresh.explainer, rows);
        const state = createTraceState(meta);
        const points = [...new Set(cuts.map((cut) => cut % Math.max(1, rows.length)))].sort((a, b) => a - b);
        const returned: { session: TraceSession; copy: TraceSession }[] = [];
        let start = 0;
        for (const point of [...points, rows.length]) {
          if (point <= start && point !== rows.length) continue;
          accumulateAll(state, rows.slice(start, point));
          const session = finalize(state, { live });
          expect(session.explainer).toStrictEqual(foldRows(meta, rows.slice(0, point), { live }).explainer);
          returned.push({ session, copy: structuredClone(session) });
          start = point;
        }
        for (const { session, copy } of returned) expect(session).toStrictEqual(copy);
      }),
      { numRuns: 300 },
    );
  });
});
