import { describe, expect, it } from "vitest";

import { buildSession, OAUTH_CLAIM_TEXT, oauthLikeSession, type StepSeed } from "../test-support/session-builder.js";
import {
  brushSeqRange, buildTraceIndex, effectivePlayheadSeq, emptyTraceIndex, isKeyExpanded, isStepExpanded,
} from "./trace-index.js";

const oauth = oauthLikeSession();
const index = buildTraceIndex(oauth);
const stepBy = (pred: (s: (typeof oauth.steps)[number]) => boolean) => {
  const step = oauth.steps.find(pred);
  if (step === undefined) throw new Error("step not found");
  return step;
};

describe("TraceIndex", () => {
  it("binary-searches steps by firstSeq", () => {
    const first = oauth.steps[0];
    const second = oauth.steps[1];
    expect(index.stepIndexAtOrBefore(0)).toBe(-1);
    expect(index.stepIndexAtOrBefore(first?.firstSeq ?? 0)).toBe(0);
    expect(index.stepIndexAtOrAfter((first?.firstSeq ?? 0) + 1)).toBe(1);
    expect(index.stepIndexAtOrBefore((second?.firstSeq ?? 0) - 1)).toBe(0);
    expect(index.stepIndexAtOrAfter(10_000)).toBe(oauth.steps.length);
    expect(index.tailStepId).toBe(oauth.steps.at(-1)?.id);
  });

  it("keys a chapter by its anchor seq and parents a step to its lowest-anchor chapter", () => {
    const testFile = stepBy((s) => s.target === "tests/auth/oauth.test.ts");
    const test = stepBy((s) => s.kind === "test");
    expect(index.chapterKey("unit:u-linking-test")).toBe(`ch:${testFile.firstSeq}`);
    expect(index.chapterByAnchor(testFile.firstSeq)).toBe("unit:u-linking-test");
    expect(index.entry(test.id)?.parent).toBe("unit:u-linking-test");
    expect(index.entry("unit:u-linking-test")).toMatchObject({ kind: "chapter", firstSeq: testFile.firstSeq, lastSeq: test.lastSeq, t0: 33_000 });
  });

  it("chapterAtSeq picks the latest anchor among chapters whose span holds the seq", () => {
    const service = stepBy((s) => s.target === "src/auth/service.ts" && s.kind === "edit");
    expect(index.chapterAtSeq(service.firstSeq)?.id).toBe("unit:u-identity");
  });

  it("orders findings by seq and resolves the effective playhead", () => {
    expect(index.findingsBySeq.map((f) => f.ruleId)).toEqual(["failing_tests", "claim_contradicted"]);
    const claim = stepBy((s) => s.text === OAUTH_CLAIM_TEXT);
    expect(effectivePlayheadSeq({ kind: "selection" }, claim.id, index)).toBe(claim.firstSeq);
    expect(effectivePlayheadSeq({ kind: "live" }, claim.id, index)).toBe(oauth.loadedThroughSeq);
    expect(effectivePlayheadSeq({ kind: "free", seq: 7 }, null, index)).toBe(7);
    expect(effectivePlayheadSeq({ kind: "selection" }, null, index)).toBe(oauth.loadedThroughSeq);
  });

  it("a live range brush ends at loadedThroughSeq; a session brush spans everything", () => {
    expect(brushSeqRange({ kind: "range", fromSeq: 5, toSeq: "live" }, index)).toEqual({ fromSeq: 5, toSeq: oauth.loadedThroughSeq });
    expect(brushSeqRange({ kind: "session" }, index)).toEqual({ fromSeq: 1, toSeq: oauth.loadedThroughSeq });
    expect(brushSeqRange({ kind: "range", fromSeq: 30, toSeq: 12 }, index)).toEqual({ fromSeq: 12, toSeq: 12 });
  });

  it("a chapter brush resolves by anchorSeq after the unit id changes", () => {
    const steps: StepSeed[] = [
      { kind: "instruction", tMs: 0, text: "go" },
      { kind: "edit", tMs: 1_000, target: "a.ts", chapter: "u1" },
      { kind: "edit", tMs: 2_000, target: "b.ts", chapter: "u1" },
    ];
    const before = buildTraceIndex(buildSession({ steps, chapters: [{ id: "u1", title: "A" }] }));
    const renamed = steps.map((s) => (s.chapter === "u1" ? { ...s, chapter: "u2" } : s));
    const after = buildTraceIndex(buildSession({ steps: renamed, chapters: [{ id: "u2", title: "A" }] }));
    const key = before.chapterKey("unit:u1");
    expect(key).toBe(after.chapterKey("unit:u2"));
    const anchorSeq = Number(key?.slice(3));
    expect(after.chapterByAnchor(anchorSeq)).toBe("unit:u2");
    expect(brushSeqRange({ kind: "chapter", anchorSeq }, after)).toEqual(brushSeqRange({ kind: "chapter", anchorSeq }, before));
    expect(brushSeqRange({ kind: "chapter", anchorSeq }, after)).toEqual({ fromSeq: 2, toSeq: 3 });
  });

  it("chapters that share an anchor are ordered by id, and a chapter brush spans all of them", () => {
    // A decision linked to both units is each unit's earliest step, so both anchor at seq 1 (spec §7.5).
    const session = buildSession({
      steps: [
        { kind: "decision", tMs: 0, chapter: "b", alsoChapters: ["a"] },
        { kind: "edit", tMs: 1_000, target: "a.ts", chapter: "a" },
        { kind: "edit", tMs: 2_000, target: "a2.ts", chapter: "a" },
        { kind: "message", tMs: 3_000 },
        { kind: "edit", tMs: 4_000, target: "b.ts", chapter: "b" },
      ],
      chapters: [{ id: "b", title: "B" }, { id: "a", title: "A" }, { id: "old", title: "Old", current: false }],
    });
    const idx = buildTraceIndex({ ...session, chapters: [...session.chapters].reverse() });
    expect(idx.chapterKey("unit:a")).toBe("ch:1");
    expect(idx.chapterKey("unit:b")).toBe("ch:1");
    expect(idx.chaptersByAnchor(1)).toEqual(["unit:a", "unit:b"]);
    expect(idx.chapterByAnchor(1)).toBe("unit:a");
    expect(idx.chaptersByAnchor(2)).toEqual([]);
    expect(brushSeqRange({ kind: "chapter", anchorSeq: 1 }, idx)).toEqual({ fromSeq: 1, toSeq: 5 });
    expect(emptyTraceIndex("s").chaptersByAnchor(1)).toEqual([]);
  });

  it("a chapter brush with no chapter falls back to its turn", () => {
    const session = buildSession({
      turns: [{ trigger: "initial", prompt: "one" }, { trigger: "steer", prompt: "two" }],
      steps: [
        { kind: "instruction", tMs: 0, turn: 0 },
        { kind: "command", tMs: 1_000, turn: 0, target: "a" },
        { kind: "instruction", tMs: 5_000, turn: 1 },
        { kind: "command", tMs: 6_000, turn: 1, target: "b", rows: 2 },
      ],
    });
    const idx = buildTraceIndex(session);
    expect(brushSeqRange({ kind: "chapter", anchorSeq: 3 }, idx)).toEqual({ fromSeq: 3, toSeq: 5 });
    expect(idx.turnAtSeq(4)?.index).toBe(1);
  });

  it("auto-expands a critical finding's row until the reader collapses it", () => {
    const claim = stepBy((s) => s.text === OAUTH_CLAIM_TEXT);
    const findingId = claim.findingIds[0];
    expect(findingId).toBeDefined();
    const none = new Set<string>();
    expect(isStepExpanded(claim, index.findingsById, none, none)).toBe(true);
    expect(isStepExpanded(claim, index.findingsById, none, new Set([findingId ?? ""]))).toBe(false);
    expect(isStepExpanded(claim, index.findingsById, new Set([claim.id]), new Set([findingId ?? ""]))).toBe(true);
    expect(isKeyExpanded(claim.id, index, none, none)).toBe(true);
    expect(isKeyExpanded("unit:u-identity", index, none, none)).toBe(false);
    expect(isKeyExpanded("unit:u-identity", index, new Set(["unit:u-identity"]), none)).toBe(true);
  });

  it("the empty index answers safely", () => {
    const empty = emptyTraceIndex("s");
    expect(empty.session).toBeNull();
    expect(empty.tailStepId).toBeNull();
    expect(empty.stepIndexAtOrBefore(10)).toBe(-1);
    expect(brushSeqRange({ kind: "session" }, empty)).toEqual({ fromSeq: 1, toSeq: 1 });
  });
});
