import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { TraceSession } from "../../model/index.js";
import { brushSeqRange, buildTraceIndex, effectivePlayheadSeq, type Brush } from "../../layout/trace-index.js";
import { arbTraceSession } from "../../test-support/arbitraries.js";
import { initialViewState, reduce, type ViewAction, type ViewState } from "./view-state.js";

function arbAction(session: TraceSession): fc.Arbitrary<ViewAction> {
  const stepIds = session.steps.map((s) => s.id);
  const unitIds = session.chapters.map((c) => c.id);
  const ids = [...stepIds, ...unitIds];
  const seqs = session.steps.map((s) => s.firstSeq);
  const findingIds = session.findings.map((f) => f.id);
  const by = fc.constantFrom("canvas" as const, "hybrid" as const, "shell" as const);
  const seq = fc.constantFrom(...seqs);
  const brush: fc.Arbitrary<Brush> = fc.oneof(
    fc.constant({ kind: "session" as const }),
    fc.tuple(seq, seq, fc.boolean()).map(([a, b, live]) => ({ kind: "range" as const, fromSeq: Math.min(a, b), toSeq: live ? ("live" as const) : Math.max(a, b) })),
    seq.map((anchorSeq) => ({ kind: "chapter" as const, anchorSeq })),
  );
  return fc.oneof(
    fc.record({ type: fc.constant("select" as const), id: fc.option(fc.constantFrom(...ids), { nil: null }), by }),
    fc.record({ type: fc.constant("nav" as const), target: fc.constantFrom("chapter" as const, "turn" as const, "finding" as const), dir: fc.constantFrom(1 as const, -1 as const) }),
    fc.constant({ type: "nav/first" as const }),
    fc.constant({ type: "nav/last" as const }),
    fc.record({ type: fc.constant("view/switch" as const), view: fc.constantFrom("canvas" as const, "hybrid" as const) }),
    fc.record({ type: fc.constant("level/set" as const), level: fc.constantFrom("session" as const, "chapter" as const, "step" as const), by }),
    fc.record({ type: fc.constant("follow/set" as const), follow: fc.boolean() }),
    fc.record({
      type: fc.constant("playhead/set" as const),
      playhead: fc.oneof(fc.constant({ kind: "live" as const }), fc.constant({ kind: "selection" as const }), seq.map((s) => ({ kind: "free" as const, seq: s }))),
      origin: fc.constantFrom("spine" as const, "overview" as const, "keys" as const, "live" as const),
    }),
    fc.record({ type: fc.constant("playhead/step" as const), dir: fc.constantFrom(1 as const, -1 as const) }),
    fc.record({ type: fc.constant("brush/set" as const), brush, by: fc.constantFrom("canvas" as const, "hybrid" as const) }),
    fc.record({ type: fc.constant("brush/edge" as const), edge: fc.constantFrom("from" as const, "to" as const) }),
    fc.constant({ type: "brush/chapter" as const }),
    fc.record({ type: fc.constant("expand/toggle" as const), key: fc.constantFrom(...ids, ...(findingIds.length > 0 ? findingIds : ["finding:none"])) }),
    fc.record({ type: fc.constant("inspector/tab" as const), tab: fc.constantFrom("summary" as const, "evidence" as const, "raw" as const) }),
    fc.record({ type: fc.constant("tool/set" as const), tool: fc.constantFrom("select" as const, "hand" as const) }),
    fc.record({ type: fc.constant("gesture" as const), gesture: fc.constantFrom(null, "pan" as const, "zoom" as const, "brush" as const, "playhead" as const) }),
    fc.record({ type: fc.constant("camera/sync" as const), view: fc.constant("canvas" as const), camera: fc.constant({ mode: "uniform" as const, tx: 3, ty: 4, k: 1 }) }),
    fc.record({ type: fc.constant("search/set" as const), query: fc.constantFrom("", "pnpm"), matchIds: fc.subarray(ids) }),
    fc.record({ type: fc.constant("search/next" as const), dir: fc.constantFrom(1 as const, -1 as const) }),
    fc.constant({ type: "esc" as const }),
    fc.record({ type: fc.constant("seen" as const), seq }),
    fc.record({
      type: fc.constant("session/applied" as const),
      loadedThroughSeq: fc.constant(session.loadedThroughSeq),
      terminal: fc.boolean(),
      loadComplete: fc.boolean(),
      initialSelection: fc.option(fc.constantFrom(...stepIds), { nil: null }),
      chapterSpineRows: fc.integer({ min: 0, max: 300 }),
    }),
  );
}

const scenario = arbTraceSession({ maxSteps: 30, maxChapters: 4, maxTurns: 3 }).chain((session) =>
  fc.tuple(fc.constant(session), fc.boolean(), fc.array(arbAction(session), { minLength: 1, maxLength: 40 })));

function intersects(state: ViewState, index: ReturnType<typeof buildTraceIndex>): boolean {
  if (state.selection === null) return true;
  const entry = index.entry(state.selection);
  if (entry === undefined) return true;
  const r = brushSeqRange(state.brush, index);
  return entry.lastSeq >= r.fromSeq && entry.firstSeq <= r.toSeq;
}

describe("reduce invariants (UI index §2.3)", () => {
  it("holds selection ∩ brush, playhead ∈ brush, monotone lastSeenSeq and collapsed, and rev rules", () => {
    fc.assert(fc.property(scenario, ([session, live, actions]) => {
      const index = buildTraceIndex(session);
      let state = initialViewState({ live });
      for (const action of actions) {
        const next = reduce(state, action, index);
        expect(intersects(next, index)).toBe(true);
        const r = brushSeqRange(next.brush, index);
        const p = effectivePlayheadSeq(next.playhead, next.selection, index);
        expect(p).toBeGreaterThanOrEqual(r.fromSeq);
        expect(p).toBeLessThanOrEqual(r.toSeq);
        expect(next.lastSeenSeq).toBeGreaterThanOrEqual(state.lastSeenSeq);
        for (const id of state.collapsed) expect(next.collapsed.has(id)).toBe(true);
        if (action.type === "camera/sync") expect(next.focusRev).toBe(state.focusRev);
        if (action.type === "select" && action.id !== state.selection && state.inspectorTab === "raw" && next.selection !== state.selection) {
          expect(next.inspectorTab).toBe("summary");
        }
        if (state.follow && ((action.type === "playhead/set" && action.origin !== "live") || action.type === "playhead/step" || action.type === "brush/set")) {
          expect(next.follow).toBe(false);
        }
        const other = next.view === "canvas" ? "hybrid" : "canvas";
        const back = reduce(reduce(next, { type: "view/switch", view: other }, index), { type: "view/switch", view: next.view }, index);
        expect({ ...back, cameras: next.cameras }).toEqual(next);
        state = next;
      }
    }), { numRuns: 200 });
  });
});
