import { describe, expect, it } from "vitest";

import type { Level, TraceSession } from "../model/index.js";
import { buildCanvasSession, canvasScale, oauthCanvasSession } from "../test-support/canvas-arbitraries.js";
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

  it("gives contradicts lanes 1 and 2 and then falls back to a direct bezier drawn at rest", () => {
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
      ["channel", 2, true],
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
