import { describe, expect, it } from "vitest";

import type { Level, TraceSession } from "../model/index.js";
import {
  buildCanvasSession,
  canvasScale,
  foldCanvasPrefix,
  oauthCanvasRows,
  oauthCanvasSession,
  oauthReplaySession,
} from "../test-support/canvas-arbitraries.js";
import { canvasXMap, collectItems, layoutCanvas, type CanvasLayout } from "./canvas-layout.js";
import { buildTraceIndex } from "./trace-index.js";

function fresh(session: TraceSession, level: Level = "chapter", prev?: CanvasLayout): CanvasLayout {
  return layoutCanvas(session, buildTraceIndex(session), canvasScale(session), level, prev);
}

/** Frame name → slot origin, named as in the spec §7.5 table. */
function tableOf(layout: CanvasLayout): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const frame of layout.frames) {
    const name =
      frame.kind === "noise" && frame.members.length > 1
        ? `noise×${frame.members.length}`
        : frame.kind === "story"
          ? frame.item
          : frame.selId.replace(/^unit:/, "");
    out[name] = [frame.slot.x, frame.slot.y];
  }
  return out;
}

// Spec §7.5 "Expected oauth layout at Chapter level".
const OAUTH_TABLE: Record<string, [number, number]> = {
  intent: [0, 0],
  plan: [264, 0],
  "oauth-dependency": [264, 150],
  "oauth-identity-layer": [264, 300],
  "oauth-migration": [264, 450],
  "noise×2": [264, 600],
  decision: [528, 0],
  "oauth-account-linking-decision": [528, 150],
  "oauth-linking-test-failure": [528, 300],
  claim: [792, 0],
};

// Spec §7.5 table "Time x" column: start second → time x (the x the item's start maps to before any push).
const OAUTH_TIME_X: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [8, 64],
  [10, 280],
  [15, 320],
  [17, 336],
  [21, 368],
  [22, 376],
  [25, 400],
  [30, 568],
  [33, 592],
  [43, 672],
];

function slots(layout: CanvasLayout): Map<string, string> {
  return new Map(layout.frames.map((frame) => [frame.key, JSON.stringify(frame.slot)]));
}

describe("layoutCanvas on oauth", () => {
  it("matches the spec §7.5 table from a fresh layout", () => {
    const layout = fresh(oauthCanvasSession());
    expect(tableOf(layout)).toEqual(OAUTH_TABLE);
    expect(layout.bounds).toEqual({ x: 0, y: 0, w: 1016, h: 658 });
    expect(layout.columns.map((column) => column.x)).toEqual([0, 264, 528, 792]);
    expect(layout.stats).toMatchObject({ late: 0, holes: 0, rMaxExceeded: 0 });
  });

  it("places every item at the spec §7.5 time x", () => {
    const layout = fresh(oauthCanvasSession());
    for (const [seconds, timeX] of OAUTH_TIME_X) {
      const bp = layout.time.bps.find((candidate) => candidate.t === seconds * 1_000);
      expect(bp?.xIn, `time x at ${seconds} s`).toBe(timeX);
    }
  });

  it("keeps every placed key's slot under a one-row drip of oauth", () => {
    const { meta, rows } = oauthCanvasRows();
    let prev: CanvasLayout | undefined;
    for (let count = 1; count <= rows.length; count += 1) {
      const session = foldCanvasPrefix(meta, rows, count);
      const next = layoutCanvas(session, buildTraceIndex(session), canvasScale(session), "chapter", prev);
      if (prev !== undefined) {
        const before = slots(prev);
        for (const [key, slot] of slots(next)) {
          if (before.has(key)) expect(slot, `${key} after row ${count}`).toBe(before.get(key));
        }
      }
      prev = next;
    }
    if (prev === undefined) throw new Error("oauth has no rows");
    // Units arrive after their facts (as in replay), so chapters are placed late: each lands in
    // the time column the fresh table gives it, below whatever arrived there first.
    const table = fresh(oauthCanvasSession());
    for (const frame of table.frames) {
      const dripped = prev.frames.find((candidate) => candidate.selId === frame.selId && candidate.kind === frame.kind);
      expect(dripped?.col, frame.selId).toBe(frame.col);
    }
  });

  it("places the same table when unit rows arrive inline", () => {
    const { meta, rows } = oauthCanvasRows({ unitsInline: true });
    const session = foldCanvasPrefix(meta, rows, rows.length);
    expect(tableOf(fresh(session))).toEqual(OAUTH_TABLE);
  });

  it("places the replay shape (one shared failed run in every chapter) in the same table, noise stacked", () => {
    // Lane review I-3: the shared `pnpm test` run carries the failing_tests and claim findings and joins all seven
    // chapters; it is validation-only in six, so it must not promote the two noise chapters to full frames.
    const session = oauthReplaySession();
    const shared = session.steps.find((step) => step.kind === "test");
    const noise = session.chapters.filter((chapter) => chapter.noise).map((chapter) => chapter.id);
    expect(noise).toHaveLength(2);
    for (const chapter of session.chapters) {
      if (noise.includes(chapter.id)) expect(chapter.validationOnlyStepIds).toContain(shared?.id);
    }
    expect(tableOf(fresh(session))).toEqual({
      intent: [0, 0],
      plan: [264, 0],
      cu_78093dbe9212089d: [264, 150],
      cu_ad1b5c606f13935e: [264, 300],
      cu_f0eafbe575775ee9: [264, 450],
      "noise×2": [264, 600],
      decision: [528, 0],
      cu_8e8b942b01d1ad59: [528, 150],
      cu_a2589fe62ff19ebf: [528, 300],
      claim: [792, 0],
    });
    const stack = fresh(session).frames.find((frame) => frame.kind === "noise");
    expect(stack?.memberSelIds.toSorted()).toEqual(noise.toSorted());
  });

  it("fits in two columns at Session level", () => {
    const layout = fresh(oauthCanvasSession(), "session");
    expect(layout.columns).toHaveLength(2);
    expect(layout.bounds).toEqual({ x: 0, y: 0, w: 360, h: 324 });
  });
});

describe("layoutCanvas stickiness", () => {
  const seeds = [
    { atMs: 8_000, kind: "plan" as const },
    { atMs: 10_000, kind: "chapter" as const },
    { atMs: 15_000, kind: "chapter" as const },
    { atMs: 21_000, kind: "noise" as const },
    { atMs: 22_000, kind: "noise" as const },
  ];

  it("a unit whose id changes keeps its key, rect and selection", () => {
    const before = buildCanvasSession(seeds);
    const first = fresh(before);
    const target = before.chapters[0];
    if (target === undefined) throw new Error("no chapter");
    const renamed: TraceSession = structuredClone(before);
    const chapter = renamed.chapters[0];
    const step = renamed.steps.find((candidate) => candidate.id === target.stepIds[0]);
    if (chapter === undefined || step === undefined) throw new Error("no chapter");
    chapter.id = "unit:c3-v2";
    chapter.changeUnitId = "c3-v2";
    step.chapterIds = ["unit:c3-v2"];
    const next = fresh(renamed, "chapter", first);
    const key = "ch:3";
    expect(next.frameByKey.get(key)?.selId).toBe("unit:c3-v2");
    expect(next.frameByKey.get(key)?.slot).toEqual(first.frameByKey.get(key)?.slot);
    expect(next.readingOrder.indexOf("unit:c3-v2")).toBe(first.readingOrder.indexOf("unit:c3"));
  });

  it("a chapter that becomes noise renders in its own slot", () => {
    const before = buildCanvasSession(seeds);
    const first = fresh(before);
    const flipped: TraceSession = structuredClone(before);
    const chapter = flipped.chapters[0];
    if (chapter === undefined) throw new Error("no chapter");
    chapter.noise = true;
    const next = fresh(flipped, "chapter", first);
    expect(next.frameByKey.get("ch:3")).toMatchObject({ kind: "noise", members: ["ch:3"] });
    expect(next.frameByKey.get("ch:3")?.slot).toEqual(first.frameByKey.get("ch:3")?.slot);
    expect(next.stats.holes).toBe(0);
  });

  it("a noise item that becomes a chapter lands at the bottom of its column", () => {
    const before = buildCanvasSession(seeds);
    const first = fresh(before);
    const stack = first.frames.find((frame) => frame.kind === "noise");
    if (stack === undefined) throw new Error("no stack");
    const flipped: TraceSession = structuredClone(before);
    const noise = flipped.chapters.find((chapter) => chapter.noise);
    if (noise === undefined) throw new Error("no noise chapter");
    noise.noise = false;
    const next = fresh(flipped, "chapter", first);
    const moved = next.frames.find((frame) => frame.selId === noise.id && frame.kind === "chapter");
    expect(moved?.late).toBe(true);
    expect(moved?.col).toBe(stack.col);
    expect(moved?.slot.y).toBe(stack.slot.y + stack.slot.h + 16);
    expect(next.frameByKey.get(stack.key)?.slot).toEqual(stack.slot);
    expect(next.frameByKey.get(stack.key)?.members).toHaveLength(1);
  });

  it("re-running on the same session changes nothing", () => {
    const session = buildCanvasSession(seeds);
    const first = fresh(session);
    expect(fresh(session, "chapter", first)).toEqual(first);
  });
});

describe("turns and breaks", () => {
  it("a steer after 14 idle minutes yields one separator labelled with turn and idle time", () => {
    const session = buildCanvasSession([
      { atMs: 1_000, kind: "chapter" },
      { atMs: 1_500 + 14 * 60_000, kind: "prompt", trigger: "steer", prompt: "Use the other API" },
      { atMs: 1_500 + 14 * 60_000 + 2_000, kind: "chapter" },
    ]);
    const layout = fresh(session);
    expect(layout.separators).toHaveLength(1);
    expect(layout.separators[0]).toMatchObject({ kind: "turn", turn: 1, label: "Turn 2 · steer · after 14 min" });
  });

  it("a 5-minute test command alone makes no break", () => {
    const session = buildCanvasSession([
      { atMs: 1_000, kind: "chapter" },
      { atMs: 2_000, kind: "work", durationMs: 300_000 },
      { atMs: 302_500, kind: "chapter" },
    ]);
    expect(fresh(session).separators).toEqual([]);
  });

  it("an idle gap of five minutes with no work opens a break", () => {
    const session = buildCanvasSession([
      { atMs: 1_000, kind: "chapter" },
      { atMs: 302_500, kind: "chapter" },
    ]);
    expect(fresh(session).separators).toEqual([expect.objectContaining({ kind: "break", label: "⫽ 5 min" })]);
  });

  it("lays out a session with no chapters from story and loose frames", () => {
    const session = buildCanvasSession([
      { atMs: 2_000, kind: "loose" },
      { atMs: 9_000, kind: "loose" },
      { atMs: 12_000, kind: "claim", flagged: true },
    ]);
    const layout = fresh(session);
    expect(layout.frames.map((frame) => frame.kind)).toEqual(["story", "loose", "loose", "story"]);
    expect(layout.stats.holes).toBe(0);
  });
});

describe("canvasXMap", () => {
  it("is monotone and inverts at every item start", () => {
    const session = oauthCanvasSession();
    const scale = canvasScale(session);
    const layout = fresh(session);
    const map = canvasXMap(layout, scale);
    let previous = -Infinity;
    for (let t = 0; t <= 45_000; t += 250) {
      const x = map.xOf(t);
      expect(x).toBeGreaterThanOrEqual(previous);
      previous = x;
    }
    for (const item of collectItems(session, buildTraceIndex(session))) {
      expect(Math.abs(map.tOf(map.xOf(item.start)) - item.start)).toBeLessThan(1e-3);
    }
    expect(map.xOf(43_000)).toBe(792);
  });
});
