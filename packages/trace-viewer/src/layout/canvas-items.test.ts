import { describe, expect, it } from "vitest";

import type { TraceSession } from "../model/index.js";
import { buildCanvasSession } from "../test-support/canvas-arbitraries.js";
import { RESUME_DEFAULT_PROMPT, collectItems, type CanvasItem } from "./canvas-layout.js";
import { buildTraceIndex } from "./trace-index.js";

// Expected items follow spec §7.5 "Items".

function items(session: TraceSession): CanvasItem[] {
  return collectItems(session, buildTraceIndex(session));
}

describe("collectItems", () => {
  it("emits intent, plan, chapters, decision and claim in time order with stable keys", () => {
    const session = buildCanvasSession([
      { atMs: 0, kind: "prompt" },
      { atMs: 8_000, kind: "plan" },
      { atMs: 10_000, kind: "chapter" },
      { atMs: 25_000, kind: "decision" },
      { atMs: 43_000, kind: "claim" },
    ]);
    expect(items(session).map((item) => [item.kind, item.band, item.key, item.selId, item.start])).toEqual([
      ["intent", "story", "turn:1", "step:1", 0],
      ["plan", "story", "plan:2", "step:2", 8_000],
      ["chapter", "work", "ch:3", "unit:c3", 10_000],
      ["decision", "story", "decision:dec-4", "step:4", 25_000],
      ["claim", "story", "claim:5", "step:5", 43_000],
    ]);
  });

  it("adds no story item for a resume turn that only says 'Continue the task.'", () => {
    const session = buildCanvasSession([
      { atMs: 0, kind: "prompt" },
      { atMs: 1_000, kind: "chapter" },
      { atMs: 5_000, kind: "prompt", trigger: "resume", prompt: RESUME_DEFAULT_PROMPT },
      { atMs: 6_000, kind: "chapter" },
      { atMs: 9_000, kind: "prompt", trigger: "steer", prompt: "Use the other API" },
    ]);
    expect(items(session).map((item) => [item.kind, item.turn])).toEqual([
      ["intent", 0],
      ["chapter", 0],
      ["chapter", 1],
      ["instruction", 2],
    ]);
  });

  it("keeps a flagged noise chapter as a chapter and a clean one as noise", () => {
    const session = buildCanvasSession([
      { atMs: 1_000, kind: "noise", flagged: true },
      { atMs: 2_000, kind: "noise" },
    ]);
    expect(items(session).map((item) => item.kind)).toEqual(["intent", "chapter", "noise"]);
  });

  it("keeps a noise chapter as noise when its step only cites a finding anchored elsewhere", () => {
    const base = buildCanvasSession([
      { atMs: 1_000, kind: "noise" },
      { atMs: 3_000, kind: "loose" },
    ]);
    const session: TraceSession = structuredClone(base);
    const [noiseStep, looseStep] = [session.steps[1], session.steps[2]];
    const finding = session.findings[0];
    if (noiseStep === undefined || looseStep === undefined || finding === undefined) throw new Error("fixture changed");
    expect(finding.anchorStepId).toBe(looseStep.id);
    noiseStep.findingIds.push(finding.id);
    expect(items(session).map((item) => item.kind)).toEqual(["intent", "noise", "loose"]);
  });

  it("makes a warning finding step with no chapter a loose item", () => {
    const session = buildCanvasSession([
      { atMs: 2_000, kind: "work" },
      { atMs: 3_000, kind: "loose" },
    ]);
    expect(items(session).map((item) => [item.kind, item.band, item.key, item.selId])).toEqual([
      ["intent", "story", "turn:1", "step:1"],
      ["loose", "work", "step:3", "step:3"],
    ]);
  });

  it("skips superseded chapters and treats a step whose only chapter is superseded as loose", () => {
    const base = buildCanvasSession([{ atMs: 1_000, kind: "chapter", flagged: true }]);
    const session: TraceSession = {
      ...base,
      chapters: base.chapters.map((chapter) => ({ ...chapter, current: false })),
    };
    expect(items(session).map((item) => [item.kind, item.key])).toEqual([
      ["intent", "turn:1"],
      ["loose", "step:2"],
    ]);
  });

  it("disambiguates chapters that share an anchor seq, ranked by selection id", () => {
    const base = buildCanvasSession([{ atMs: 1_000, kind: "chapter" }]);
    const first = base.chapters[0];
    if (first === undefined) throw new Error("builder made no chapter");
    const twin = { ...first, id: "unit:zz" as const, changeUnitId: "zz" };
    const session: TraceSession = { ...base, chapters: [twin, first] };
    expect(items(session).filter((item) => item.band === "work").map((item) => [item.key, item.selId])).toEqual([
      ["ch:2", "unit:c2"],
      ["ch:2.1", "unit:zz"],
    ]);
  });

  it("reads a decision-opened turn as one decision item and no instruction item", () => {
    const base = buildCanvasSession([
      { atMs: 0, kind: "prompt" },
      { atMs: 5_000, kind: "prompt", trigger: "steer" },
      { atMs: 6_000, kind: "decision" },
    ]);
    // The decision step (seq 3) opened turn 1; the instruction step (seq 2) is only listed in stepIds.
    const session: TraceSession = {
      ...base,
      turns: base.turns.map((turn) => (turn.index === 1 ? { ...turn, startSeq: 3, tMs: 6_000 } : turn)),
    };
    expect(items(session).map((item) => [item.kind, item.selId])).toEqual([
      ["intent", "step:1"],
      ["decision", "step:3"],
    ]);
  });

  it("takes a turn's instruction from the step holding startSeq, at that step's time", () => {
    const base = buildCanvasSession([
      { atMs: 0, kind: "prompt" },
      { atMs: 1_000, kind: "work" },
      { atMs: 5_000, kind: "prompt", trigger: "steer", prompt: "Queued steer" },
      { atMs: 6_000, kind: "work" },
    ]);
    // Turn 1 starts at seq 3 (the queued instruction) but lists only step 4 and a turn tMs before it.
    const session: TraceSession = {
      ...base,
      turns: base.turns.map((turn) =>
        turn.index === 1 ? { ...turn, tMs: 4_000, stepIds: ["step:4" as const] } : turn,
      ),
    };
    const found = items(session).find((item) => item.kind === "instruction");
    expect(found).toMatchObject({ key: "turn:3", selId: "step:3", start: 5_000, anchorSeq: 3, turn: 1 });
  });

  it("does not depend on the order of chapters, steps and findings", () => {
    const session = buildCanvasSession([
      { atMs: 1_000, kind: "chapter" },
      { atMs: 2_000, kind: "loose" },
      { atMs: 3_000, kind: "decision" },
      { atMs: 4_000, kind: "noise" },
      { atMs: 5_000, kind: "claim", flagged: true },
    ]);
    const index = buildTraceIndex(session);
    const shuffled: TraceSession = {
      ...session,
      chapters: [...session.chapters].reverse(),
      steps: [...session.steps].reverse(),
      findings: [...session.findings].reverse(),
    };
    expect(collectItems(shuffled, index)).toEqual(collectItems(session, index));
  });
});
