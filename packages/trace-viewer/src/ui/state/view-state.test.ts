import { describe, expect, it } from "vitest";

import { brushSeqRange, buildTraceIndex, isKeyExpanded, type TraceIndex } from "../../layout/trace-index.js";
import { buildSession, OAUTH_CLAIM_TEXT, oauthLikeSession, type StepSeed } from "../../test-support/session-builder.js";
import { initialViewState, locationOf, reduce, selectNewCount, type ViewAction, type ViewState } from "./view-state.js";

const oauth = oauthLikeSession();
const index = buildTraceIndex(oauth);
const claim = oauth.steps.find((s) => s.text === OAUTH_CLAIM_TEXT);
const test = oauth.steps.find((s) => s.kind === "test");
if (claim === undefined || test === undefined) throw new Error("oauth-like session is missing its claim or test");

const run = (state: ViewState, actions: readonly ViewAction[], idx: TraceIndex = index): ViewState =>
  actions.reduce((s, a) => reduce(s, a, idx), state);
const applied = (idx: TraceIndex, extra: Partial<Extract<ViewAction, { type: "session/applied" }>> = {}): ViewAction => ({
  type: "session/applied", loadedThroughSeq: idx.loadedThroughSeq, terminal: false, loadComplete: true,
  initialSelection: null, chapterSpineRows: 20, ...extra,
});

describe("initial state and defaults on open (spec §7.8)", () => {
  it("Review opens on the initial selection with a session brush", () => {
    const s = run(initialViewState({ live: false }), [applied(index, { terminal: true, initialSelection: claim.id })]);
    expect(s).toMatchObject({ selection: claim.id, playhead: { kind: "selection" }, brush: { kind: "session" }, loaded: true, terminal: true, follow: false });
  });

  it("Review uses the chapter holding the selection when the Chapter spine exceeds 150 rows", () => {
    const s = run(initialViewState({ live: false }), [applied(index, { initialSelection: test.id, chapterSpineRows: 151 })]);
    expect(s.brush).toEqual({ kind: "chapter", anchorSeq: Number(index.chapterKey("unit:u-linking-test")?.slice(3)) });
  });

  it("Live opens without a selection and with the playhead at the edge", () => {
    const s = run(initialViewState({ live: true }), [applied(index, { initialSelection: claim.id })]);
    expect(s).toMatchObject({ selection: null, playhead: { kind: "live" }, follow: true, lastSeenSeq: oauth.loadedThroughSeq });
  });

  it("returns the same object when nothing changes", () => {
    const s = initialViewState({ live: false });
    expect(reduce(s, { type: "tool/set", tool: "select" }, index)).toBe(s);
    expect(reduce(s, { type: "view/switch", view: "hybrid" }, index)).toBe(s);
  });
});

describe("selection, playhead and brush", () => {
  it("select resets Raw to Summary but keeps Evidence, and bumps focusRev", () => {
    let s = run(initialViewState({ live: false }), [{ type: "inspector/tab", tab: "raw" }, { type: "select", id: test.id, by: "hybrid" }]);
    expect(s).toMatchObject({ inspectorTab: "summary", focusRev: 1, focusBy: "hybrid", playheadOrigin: "overview" });
    s = run(s, [{ type: "inspector/tab", tab: "evidence" }, { type: "select", id: claim.id, by: "shell", origin: "spine" }]);
    expect(s).toMatchObject({ inspectorTab: "evidence", playheadOrigin: "spine" });
  });

  it("a selection outside a chapter brush slides the brush to its chapter", () => {
    const identity = oauth.steps.find((s) => s.target === "src/auth/identity.ts");
    const s = run(initialViewState({ live: false }), [
      { type: "select", id: test.id, by: "shell" },
      { type: "brush/chapter" },
      { type: "select", id: identity?.id ?? claim.id, by: "shell" },
    ]);
    const range = brushSeqRange(s.brush, index);
    expect(range.fromSeq).toBeLessThanOrEqual(identity?.firstSeq ?? 0);
    expect(range.toSeq).toBeGreaterThanOrEqual(identity?.firstSeq ?? 0);
  });

  it("a brush write keeps the brush, clears a selection outside it and clamps the playhead", () => {
    const s = run(initialViewState({ live: false }), [
      { type: "select", id: claim.id, by: "shell" },
      { type: "brush/set", brush: { kind: "range", fromSeq: 1, toSeq: 5 }, by: "hybrid" },
    ]);
    expect(s).toMatchObject({ brush: { kind: "range", fromSeq: 1, toSeq: 5 }, selection: null, playhead: { kind: "free", seq: 5 } });
  });

  it("playhead steps move by one step and switch Live to Review", () => {
    const s = run(initialViewState({ live: true }), [applied(index), { type: "playhead/step", dir: -1 }]);
    const last = oauth.steps.at(-1);
    const prev = oauth.steps.at(-2);
    expect(last?.firstSeq).toBe(index.loadedThroughSeq);
    expect(s).toMatchObject({ follow: false, playhead: { kind: "free", seq: prev?.firstSeq }, playheadOrigin: "keys" });
  });

  it("selecting the tail keeps Live; selecting anything else switches to Review", () => {
    const tail = index.tailStepId;
    const live = run(initialViewState({ live: true }), [applied(index)]);
    expect(reduce(live, { type: "select", id: tail ?? claim.id, by: "hybrid" }, index)).toMatchObject({ follow: true, playhead: { kind: "live" } });
    expect(reduce(live, { type: "select", id: test.id, by: "hybrid" }, index)).toMatchObject({ follow: false, playhead: { kind: "selection" } });
  });

  it("n wraps through findings in seq order", () => {
    const s0 = run(initialViewState({ live: false }), [{ type: "select", id: claim.id, by: "shell" }]);
    const s1 = reduce(s0, { type: "nav", target: "finding", dir: 1 }, index);
    expect(s1.selection).toBe(test.id);
    const s2 = reduce(s1, { type: "nav", target: "finding", dir: 1 }, index);
    expect(s2.selection).toBe(claim.id);
  });

  it("J moves to the next chapter by anchor; ] and [ move between turns", () => {
    const s = run(initialViewState({ live: false }), [{ type: "select", id: "unit:u-identity", by: "shell" }, { type: "nav", target: "chapter", dir: 1 }]);
    const identityKey = Number(index.chapterKey("unit:u-identity")?.slice(3));
    const nextKey = Number(index.chapterKey(s.selection as `unit:${string}`)?.slice(3));
    expect(nextKey).toBeGreaterThan(identityKey);
    const two = buildSession({
      turns: [{ trigger: "initial", prompt: "a" }, { trigger: "steer", prompt: "b" }],
      steps: [{ kind: "instruction", tMs: 0 }, { kind: "message", tMs: 1 }, { kind: "instruction", tMs: 2, turn: 1 }, { kind: "message", tMs: 3, turn: 1 }],
    });
    const idx = buildTraceIndex(two);
    const t = run(initialViewState({ live: false }), [{ type: "select", id: "step:2", by: "shell" }, { type: "nav", target: "turn", dir: 1 }], idx);
    expect(t.selection).toBe("step:3");
    expect(reduce(t, { type: "nav", target: "turn", dir: -1 }, idx).selection).toBe("step:1");
  });
});

describe("expansion, esc and live bookkeeping", () => {
  it("a collapsed critical finding stays collapsed across session/applied", () => {
    const findingId = claim.findingIds[0] ?? "";
    let s = run(initialViewState({ live: false }), [applied(index, { initialSelection: claim.id })]);
    expect(isKeyExpanded(claim.id, index, s.expanded, s.collapsed)).toBe(true);
    s = reduce(s, { type: "expand/toggle", key: claim.id }, index);
    expect(s.collapsed.has(findingId)).toBe(true);
    // A live append of three filtered rows: same steps and findings, higher loadedThroughSeq.
    const grown = oauth.loadedThroughSeq + 3;
    const longer = buildTraceIndex({ ...oauth, loadedThroughSeq: grown, meta: { ...oauth.meta, lastEventSeq: grown } });
    s = reduce(s, applied(longer), longer);
    expect(s.collapsed.has(findingId)).toBe(true);
    expect(isKeyExpanded(claim.id, longer, s.expanded, s.collapsed)).toBe(false);
  });

  it("regrouped selection follows the anchor seq", () => {
    const steps: StepSeed[] = [
      { kind: "instruction", tMs: 0 },
      { kind: "edit", tMs: 1_000, target: "a.ts", chapter: "u1" },
      { kind: "edit", tMs: 2_000, target: "b.ts", chapter: "u1" },
    ];
    const before = buildTraceIndex(buildSession({ steps, chapters: [{ id: "u1", title: "Identity layer" }] }));
    const after = buildTraceIndex(buildSession({
      steps: steps.map((s) => (s.chapter === "u1" ? { ...s, chapter: "u2" } : s)),
      chapters: [{ id: "u2", title: "Identity layer" }],
    }));
    let s = run(initialViewState({ live: false }), [
      { type: "select", id: "unit:u1", by: "canvas" },
      { type: "expand/set", key: "unit:u1", expanded: true },
      { type: "brush/chapter" },
    ], before);
    const brushBefore = brushSeqRange(s.brush, before);
    s = reduce(s, applied(after), after);
    expect(s.selection).toBe("unit:u2");
    expect(s.selectionNote).toEqual({ from: "unit:u1", to: "unit:u2" });
    expect(s.expanded.has("unit:u2")).toBe(true);
    expect(s.expanded.has("unit:u1")).toBe(false);
    expect(brushSeqRange(s.brush, after)).toEqual(brushBefore);
  });

  it("esc unwinds search, hand tool, expansion, parent, then clears", () => {
    let s = run(initialViewState({ live: false }), [
      { type: "select", id: test.id, by: "shell" },
      { type: "expand/set", key: test.id, expanded: true },
      { type: "tool/set", tool: "hand" },
      { type: "search/set", query: "pnpm", matchIds: [test.id] },
    ]);
    s = reduce(s, { type: "esc" }, index);
    expect(s.search).toBeNull();
    s = reduce(s, { type: "esc" }, index);
    expect(s.tool).toBe("select");
    s = reduce(s, { type: "esc" }, index);
    expect(isKeyExpanded(test.id, index, s.expanded, s.collapsed)).toBe(false);
    s = reduce(s, { type: "esc" }, index);
    expect(s.selection).toBe("unit:u-linking-test");
    s = reduce(s, { type: "esc" }, index);
    expect(s.selection).toBeNull();
    const cameraBefore = s.cameras;
    expect(reduce(s, { type: "esc" }, index).cameras).toBe(cameraBefore);
  });

  it("a terminal apply disables Live once and camera/sync never bumps focusRev", () => {
    let s = run(initialViewState({ live: true }), [applied(index)]);
    s = reduce(s, applied(index, { terminal: true }), index);
    expect(s).toMatchObject({ terminal: true, follow: false, playhead: { kind: "free", seq: index.loadedThroughSeq } });
    expect(reduce(s, { type: "follow/set", follow: true }, index)).toBe(s);
    const rev = s.focusRev;
    s = reduce(s, { type: "camera/sync", view: "canvas", camera: { mode: "uniform", tx: 1, ty: 2, k: 1 } }, index);
    expect(s.focusRev).toBe(rev);
    expect(s.cameras.canvas).toEqual({ mode: "uniform", tx: 1, ty: 2, k: 1, syncedRev: rev });
  });

  it("switching views there and back is the identity; lastSeenSeq and N new", () => {
    const s = run(initialViewState({ live: false }), [applied(index, { initialSelection: claim.id })]);
    expect(run(s, [{ type: "view/switch", view: "canvas" }, { type: "view/switch", view: "hybrid" }])).toEqual(s);
    expect(selectNewCount(s, index)).toBe(oauth.steps.length);
    const seen = reduce(s, { type: "seen", seq: 20 }, index);
    expect(reduce(seen, { type: "seen", seq: 5 }, index).lastSeenSeq).toBe(20);
    expect(selectNewCount(seen, index)).toBe(oauth.steps.filter((st) => st.firstSeq > 20).length);
    expect(locationOf(s, "sess-oauth-0001")).toMatchObject({ v: 1, sessionId: "sess-oauth-0001", view: "hybrid", selected: claim.id, brush: { kind: "session" } });
  });
});
