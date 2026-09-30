import { describe, expect, it } from "vitest";

import type { Level, TraceSession } from "../model/index.js";
import { buildCanvasSession, canvasScale, oauthCanvasSession } from "../test-support/canvas-arbitraries.js";
import type { CanvasSeed } from "../test-support/canvas-arbitraries.js";
import { layoutCanvas, type CanvasFrame, type CanvasLayout } from "./canvas-layout.js";
import { LEVEL_SPECS } from "./canvas-levels.js";
import { directPath, homeFrameKey, laneY, samplePath, type CanvasEdge, type RouteInput } from "./canvas-routes.js";
import { buildTraceIndex } from "./trace-index.js";

// Expected geometry: spec §7.5 "Expected oauth layout" paragraph and the §7.5 edge table.

function fresh(session: TraceSession, level: Level = "chapter"): CanvasLayout {
  return layoutCanvas(session, buildTraceIndex(session), canvasScale(session), level);
}

function frameOf(layout: CanvasLayout, predicate: (frame: CanvasFrame) => boolean): CanvasFrame {
  const frame = layout.frames.find(predicate);
  if (frame === undefined) throw new Error("frame not found");
  return frame;
}

function edge(layout: CanvasLayout, kind: CanvasEdge["kind"], from: string, to: string): CanvasEdge {
  const found = layout.edges.find((candidate) => candidate.kind === kind && candidate.from === from && candidate.to === to);
  if (found === undefined) throw new Error(`no ${kind} edge ${from} → ${to}`);
  return found;
}

function xRange(d: string | null): [number, number] {
  const xs = samplePath(d ?? "").map((point) => point.x);
  return [Math.min(...xs), Math.max(...xs)];
}

describe("routeEdges on oauth at Chapter level", () => {
  const layout = fresh(oauthCanvasSession());
  const decision = frameOf(layout, (frame) => frame.item === "decision");
  const claim = frameOf(layout, (frame) => frame.item === "claim");
  const identity = frameOf(layout, (frame) => frame.selId === "unit:oauth-identity-layer");
  const linking = frameOf(layout, (frame) => frame.selId === "unit:oauth-account-linking-decision");
  const linkingTest = frameOf(layout, (frame) => frame.selId === "unit:oauth-linking-test-failure");

  it("runs the trunk at y 124 from column 0 to column 3", () => {
    const trunk = layout.edges.find((candidate) => candidate.kind === "trunk");
    expect(laneY(LEVEL_SPECS.chapter, 0)).toBe(124);
    expect(trunk?.d?.startsWith("M112 124H904")).toBe(true);
    expect(trunk).toMatchObject({ shape: "comb", lane: 0, rest: true, tone: "neutral" });
    expect(layout.junctions).toEqual(expect.arrayContaining([{ x: 376, y: 124 }, { x: 640, y: 124 }]));
  });

  it("draws Decision → Linking policy stacked", () => {
    expect(edge(layout, "decides", decision.key, linking.key)).toMatchObject({ shape: "stacked", rest: true });
  });

  it("draws Identity → Decision as an adjacent S-curve in gutter 488–528", () => {
    const decides = edge(layout, "decides", decision.key, identity.key);
    expect(decides).toMatchObject({ shape: "adjacent", rest: true, tone: "neutral" });
    const [lo, hi] = xRange(decides.d);
    expect(lo).toBeGreaterThanOrEqual(488);
    expect(hi).toBeLessThanOrEqual(528);
  });

  it("draws Claim ≠ Linking test as the only red edge, adjacent in gutter 752–792 with the badge at (772, 224)", () => {
    const contradicts = edge(layout, "contradicts", claim.key, linkingTest.key);
    expect(contradicts).toMatchObject({ shape: "adjacent", tone: "bad", rest: true, badge: { x: 772, y: 224 } });
    expect(contradicts.findingId?.startsWith("finding:claim_contradicted@")).toBe(true);
    const [lo, hi] = xRange(contradicts.d);
    expect(lo).toBeGreaterThanOrEqual(752);
    expect(hi).toBeLessThanOrEqual(792);
    expect(layout.edges.filter((candidate) => candidate.tone === "bad")).toEqual([contradicts]);
    expect(layout.stats.hiddenEdges).toBe(0);
  });

  it("finds each step's home frame: loose, then story, then the tests chapter, then the lowest anchor", () => {
    const session = oauthCanvasSession();
    const input: RouteInput = {
      session,
      frames: layout.frames,
      frameByKey: layout.frameByKey,
      columns: layout.columns,
      spec: LEVEL_SPECS.chapter,
    };
    const testStep = session.steps.find((step) => step.command?.command === "pnpm test");
    const googleEdit = session.steps.find((step) => step.edit?.path === "src/auth/google.ts");
    expect(testStep === undefined ? undefined : homeFrameKey(testStep.id, input)).toBe(linkingTest.key);
    expect(homeFrameKey(claim.selId as `step:${number}`, input)).toBe(claim.key);
    // google.ts belongs to Identity layer (anchor 13) and Account linking (anchor 16): the lower anchor wins.
    expect(googleEdit === undefined ? undefined : homeFrameKey(googleEdit.id, input)).toBe(identity.key);
  });
});

describe("route stability under append (spec §7.5 lane reservation)", () => {
  // Decisions, validations and flagged claims interleaved so decides/validates/contradicts edges compete for
  // the same rails and channel lanes. Each drip step appends one seed and lays out with the previous layout.
  const seeds: CanvasSeed[] = [
    { atMs: 1_000, kind: "loose" },
    { atMs: 1_500, kind: "decision" },
    { atMs: 2_000, kind: "chapter" },
    { atMs: 3_000, kind: "chapter" },
    { atMs: 4_000, kind: "chapter", decides: true, validates: true },
    { atMs: 5_000, kind: "chapter" },
    { atMs: 6_000, kind: "chapter", validates: true },
    { atMs: 7_000, kind: "chapter" },
    { atMs: 8_000, kind: "chapter", decides: true },
    { atMs: 9_000, kind: "chapter" },
    { atMs: 9_500, kind: "claim", flagged: true },
    { atMs: 10_000, kind: "chapter", validates: true },
    { atMs: 11_000, kind: "chapter", decides: true },
    { atMs: 12_000, kind: "chapter" },
    { atMs: 12_500, kind: "claim", flagged: true },
    { atMs: 13_000, kind: "chapter", validates: true },
    { atMs: 14_000, kind: "chapter" },
    { atMs: 15_500, kind: "claim", flagged: true },
  ];

  it.each<Level>(["chapter", "step"])("keeps every earlier edge id, shape, lane and d at %s level", (level) => {
    let prev: CanvasLayout | undefined;
    let earlier = new Map<string, { shape: string; lane: number | null; d: string | null; ends: [string, string] }>();
    let appendedContradicts = 0;
    for (let count = 1; count <= seeds.length; count += 1) {
      const session = buildCanvasSession(seeds.slice(0, count));
      const layout = layoutCanvas(session, buildTraceIndex(session), canvasScale(session), level, prev);
      // The trunk comb grows with each turn by design; only routed connectors must stay put.
      const routed = layout.edges.filter((candidate) => candidate.kind !== "trunk");
      const now = new Map(routed.map((candidate) => [candidate.id, candidate]));
      for (const [id, before] of earlier) {
        const after = now.get(id);
        // A frame key can be re-minted when a later row re-classifies an item (claim:12 becomes step:12);
        // an edge may then legitimately change id, but never while both of its frames still exist.
        if (after === undefined) {
          const [from, to] = before.ends;
          expect(layout.frameByKey.has(from) && layout.frameByKey.has(to), `${id} vanished at seed ${count}`).toBe(false);
          continue;
        }
        expect({ shape: after.shape, lane: after.lane, d: after.d }, `${id} moved at seed ${count}`).toEqual({
          shape: before.shape,
          lane: before.lane,
          d: before.d,
        });
      }
      if (seeds[count - 1]?.kind === "claim") {
        appendedContradicts += [...now.values()].filter((candidate) => candidate.kind === "contradicts" && !earlier.has(candidate.id)).length;
      }
      earlier = new Map(routed.map((candidate) => [candidate.id, { shape: candidate.shape, lane: candidate.lane, d: candidate.d, ends: [candidate.from, candidate.to] as [string, string] }]));
      prev = layout;
    }
    expect(appendedContradicts).toBeGreaterThan(0);
    expect(earlier.size).toBeGreaterThan(0);
  });

  it("routes validates through a channel lane above the reserved ones", () => {
    const session = buildCanvasSession(seeds);
    const layout = layoutCanvas(session, buildTraceIndex(session), canvasScale(session), "chapter");
    const validates = layout.edges.filter((candidate) => candidate.kind === "validates" && candidate.shape === "channel" && candidate.d !== null);
    expect(validates.length).toBeGreaterThan(0);
    for (const candidate of validates) {
      expect(candidate.d).not.toBeNull();
      expect(candidate.lane).toBeGreaterThanOrEqual(2);
      expect(candidate.tone).toBe("neutral");
      expect(candidate.rest).toBe(false);
    }
  });

  it("leaves a card through its side port when other frames stand between it and the channel", () => {
    const session = buildCanvasSession(seeds);
    const layout = layoutCanvas(session, buildTraceIndex(session), canvasScale(session), "chapter");
    const sideExits = layout.edges.filter((candidate) => {
      if (candidate.shape !== "channel" || candidate.d === null) return false;
      const points = samplePath(candidate.d);
      const ends = [points[0], points[points.length - 1]];
      return [candidate.from, candidate.to].some((key) => {
        const frame = layout.frameByKey.get(key);
        if (frame === undefined) return false;
        const { x, y, w, h } = frame.card;
        return ends.some((end) => end !== undefined && (end.x === x + w || end.x === x) && end.y === y + h / 2);
      });
    });
    expect(sideExits.length).toBeGreaterThan(0);
  });

  it("uses reserved lanes only for contradicts", () => {
    const session = buildCanvasSession(seeds);
    const layout = layoutCanvas(session, buildTraceIndex(session), canvasScale(session), "chapter");
    for (const candidate of layout.edges) {
      if (candidate.kind === "trunk" || candidate.lane === null) continue;
      if (candidate.shape === "channel") expect(candidate.lane === 1).toBe(candidate.kind === "contradicts");
      if (candidate.shape === "rail") expect(candidate.lane === 0).toBe(candidate.kind === "contradicts");
    }
  });
});

describe("routeEdges rules", () => {
  it("draws only trunk and contradicts at rest at Session level", () => {
    const layout = fresh(oauthCanvasSession(), "session");
    const atRest = new Set(layout.edges.filter((candidate) => candidate.rest).map((candidate) => candidate.kind));
    expect([...atRest].sort()).toEqual(["contradicts", "trunk"]);
  });

  it("routes a decision to a chapter with frames between them through the left rail", () => {
    const layout = fresh(
      buildCanvasSession([
        { atMs: 1_000, kind: "decision" },
        { atMs: 2_000, kind: "chapter" },
        { atMs: 3_000, kind: "chapter" },
        { atMs: 4_000, kind: "chapter", decides: true },
      ]),
    );
    const rail = layout.edges.find((candidate) => candidate.kind === "decides");
    expect(rail).toMatchObject({ shape: "rail", lane: 1, rest: true });
    const column = layout.columns[1];
    const [lo, hi] = xRange(rail?.d ?? null);
    expect(lo).toBeLessThan(column?.x ?? 0);
    expect(hi).toBeLessThanOrEqual((column?.x ?? 0) + 1);
  });

  it("gives contradicts reserved channel lane 1 and then falls back to a direct bezier drawn at rest", () => {
    const layout = fresh(
      buildCanvasSession([
        { atMs: 1_000, kind: "loose" },
        { atMs: 2_000, kind: "chapter" },
        { atMs: 3_000, kind: "chapter" },
        { atMs: 4_000, kind: "chapter" },
        { atMs: 5_000, kind: "chapter" },
        { atMs: 6_000, kind: "chapter" },
        { atMs: 7_000, kind: "chapter" },
        { atMs: 8_000, kind: "chapter" },
        { atMs: 9_000, kind: "chapter" },
        { atMs: 9_500, kind: "claim", flagged: true },
        { atMs: 10_000, kind: "chapter" },
        { atMs: 11_000, kind: "chapter" },
        { atMs: 12_000, kind: "chapter" },
        { atMs: 12_500, kind: "claim", flagged: true },
        { atMs: 13_000, kind: "chapter" },
        { atMs: 14_000, kind: "chapter" },
        { atMs: 15_000, kind: "chapter" },
        { atMs: 15_500, kind: "claim", flagged: true },
      ]),
    );
    const contradicts = layout.edges.filter((candidate) => candidate.kind === "contradicts");
    expect(contradicts.map((candidate) => [candidate.shape, candidate.lane, candidate.rest])).toEqual([
      ["channel", 1, true],
      ["direct", null, true],
      ["direct", null, true],
    ]);
    expect(contradicts.every((candidate) => candidate.d !== null)).toBe(true);
  });

  it("directPath runs between facing card edges", () => {
    expect(directPath({ x: 0, y: 0, w: 100, h: 40 }, { x: 200, y: 100, w: 100, h: 40 })).toBe(
      "M100 20C150 20 150 120 200 120",
    );
    expect(directPath({ x: 0, y: 0, w: 100, h: 40 }, { x: 0, y: 100, w: 100, h: 40 })).toBe(
      "M50 40C50 70 50 70 50 100",
    );
  });
});
