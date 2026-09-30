import { describe, expect, it } from "vitest";

import type { TraceSession } from "../model/index.js";
import { foldRows } from "../model/fold.js";
import { buildSession, largeSession, OAUTH_CLAIM_TEXT, oauthLikeSession } from "../test-support/session-builder.js";
import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { buildOverviewIndex } from "./overview-index.js";
import { K_MAX, layoutOverview, MAX_OVERLAY_NODES, overviewPreset } from "./overview-layout.js";
import { buildTimeScale, timeScaleInputOf } from "./time-scale.js";
import { buildTraceIndex } from "./trace-index.js";
import { fitRange } from "./viewport.js";

const WIDTH = 1_000;
const LIMITS = { minK: 1e-9, maxK: K_MAX };

function prepare(session: TraceSession) {
  const index = buildTraceIndex(session);
  const scale = buildTimeScale(timeScaleInputOf(session));
  const overview = buildOverviewIndex(session, index, scale);
  const fit = fitRange(0, overview.endU, WIDTH, { padFraction: 0.02, limits: LIMITS });
  return { index, scale, overview, fit };
}

const oauth = oauthLikeSession();
const o = prepare(oauth);
const claim = oauth.steps.find((s) => s.text === OAUTH_CLAIM_TEXT);
const test = oauth.steps.find((s) => s.kind === "test");

describe("overview layout on the oauth-like session", () => {
  it("Chapter level pins the instruction, the decision fork, the claim quote, the failed test and one link", () => {
    const layout = layoutOverview({ overview: o.overview, camera: o.fit, widthPx: WIDTH, level: "chapter" });
    const pinned = layout.pins.flatMap((p) => p.stepIndexes.map((i) => oauth.steps[i]?.id));
    const expected = [
      oauth.steps.find((s) => s.kind === "instruction")?.id,
      oauth.steps.find((s) => s.kind === "decision")?.id,
      test?.id,
      claim?.id,
    ];
    expect([...pinned].sort()).toEqual([...expected].sort());
    const claimPin = layout.pins.find((p) => p.stepIndexes.some((i) => oauth.steps[i]?.id === claim?.id));
    const testPin = layout.pins.find((p) => p.stepIndexes.some((i) => oauth.steps[i]?.id === test?.id));
    expect(claimPin).toMatchObject({ lane: "agent", kind: "critical_finding", critical: true, cluster: false });
    expect(testPin?.lane).toBe("tests");
    expect(layout.links).toHaveLength(1);
    expect(layout.links[0]).toMatchObject({ fromPin: claimPin?.key, toPin: testPin?.key });
  });

  it("Session level omits noise; Chapter level draws one bar per noise run; problem ticks always survive", () => {
    const session = layoutOverview({ overview: o.overview, camera: o.fit, widthPx: WIDTH, level: "session" });
    expect(session.marks.filter((m) => m.op === "noise")).toHaveLength(0);
    const problems = session.marks.filter((m) => m.op === "problem").map((m) => m.lane).sort();
    expect(problems).toEqual(["agent", "tests"]);
    const chapter = layoutOverview({ overview: o.overview, camera: o.fit, widthPx: WIDTH, level: "chapter" });
    expect(chapter.marks.filter((m) => m.op === "noise" && m.lane === "edits")).toHaveLength(2);
    expect(chapter.marks.filter((m) => m.op === "noise" && m.lane === "agent")).toHaveLength(2);
    const step = layoutOverview({ overview: o.overview, camera: o.fit, widthPx: WIDTH, level: "step" });
    expect(step.marks.filter((m) => m.op === "noise")).toHaveLength(0);
    expect(step.marks.filter((m) => m.op === "ring" && m.lane === "edits")).toHaveLength(3);
  });

  it("echoes the test run as a plain bar on the Commands lane without a pin", () => {
    const layout = layoutOverview({ overview: o.overview, camera: o.fit, widthPx: WIDTH, level: "chapter" });
    expect(layout.marks.some((m) => m.op === "bar" && m.lane === "commands")).toBe(true);
    expect(layout.pins.some((p) => p.lane === "commands")).toBe(false);
  });

  it("presets: Session fits everything; Chapter fits the playhead chapter with 20 s minimum; Step caps k", () => {
    const base = { overview: o.overview, index: o.index, scale: o.scale, widthPx: WIDTH, playheadSeq: test?.firstSeq ?? 1, live: false };
    const s = overviewPreset({ ...base, level: "session" });
    expect(s.brush).toEqual({ kind: "session" });
    expect(s.camera.k).toBeCloseTo(o.fit.k, 12);
    const c = overviewPreset({ ...base, level: "chapter" });
    expect(c.brush).toEqual({ kind: "chapter", anchorSeq: Number(o.index.chapterKey("unit:u-linking-test")?.slice(3)) });
    expect(c.camera.k).toBeCloseTo(WIDTH / (20_000 * 1.16), 9);
    const st = overviewPreset({ ...base, level: "step" });
    expect(st.camera.k).toBeLessThanOrEqual(K_MAX);
    expect((o.scale.toU(test?.tMs ?? 0) - st.camera.u0) * st.camera.k).toBeCloseTo(WIDTH / 2, 6);
    expect(st.brush.kind).toBe("range");
    const live = overviewPreset({ ...base, level: "session", live: true });
    expect(live.camera.k).toBeLessThan(s.camera.k);
  });
});

describe("overview layout edge cases", () => {
  it("turns stand in for chapters", () => {
    const session = buildSession({
      turns: [{ trigger: "initial", prompt: "a" }, { trigger: "steer", prompt: "b" }],
      steps: [
        { kind: "instruction", tMs: 0 },
        { kind: "command", tMs: 1_000, target: "pnpm test", status: "unknown", command: { exitCode: -1 } },
        { kind: "instruction", tMs: 5_000, turn: 1 },
        { kind: "command", tMs: 6_000, turn: 1, target: "pnpm lint", rows: 2 },
      ],
      approximateJoins: true,
    });
    const p = prepare(session);
    expect(p.overview.bands.map((b) => b.key)).toEqual(["turn:0", "turn:1"]);
    const layout = layoutOverview({ overview: p.overview, camera: p.fit, widthPx: WIDTH, level: "chapter" });
    expect(layout.bands.map((b) => b.key)).toEqual(["turn:0", "turn:1"]);
    expect(layout.turnLines).toEqual([{ x: expect.any(Number), label: "T2 · steer" }]);
    const preset = overviewPreset({ level: "chapter", overview: p.overview, index: p.index, scale: p.scale, widthPx: WIDTH, playheadSeq: 4, live: false });
    expect(preset.brush).toEqual({ kind: "range", fromSeq: 3, toSeq: 5 });
    expect(layout.marks.some((m) => m.op === "problem")).toBe(false);
    expect(layout.pins.map((pin) => oauthKind(session, pin.stepIndexes[0]))).toEqual(["instruction", "instruction"]);
  });

  it("dense dots become heat bars whose height carries the count", () => {
    const session = buildSession({ steps: Array.from({ length: 20 }, (_, i) => ({ kind: "message" as const, tMs: i * 100, text: `m${i}` })) });
    const p = prepare(session);
    const camera = fitRange(0, 200_000, WIDTH, { padFraction: 0.02, limits: LIMITS });
    const layout = layoutOverview({ overview: p.overview, camera, widthPx: WIDTH, level: "chapter" });
    const heat = layout.marks.filter((m): m is Extract<typeof m, { op: "heat" }> => m.op === "heat");
    expect(heat.reduce((sum, m) => sum + m.count, 0)).toBe(20);
    expect(layout.marks.some((m) => m.op === "dot")).toBe(false);
    for (const m of heat) expect(m.h).toBe(m.count >= 10 ? 8 : m.count >= 4 ? 6 : m.count >= 2 ? 4 : 2);
  });

  it("keeps the overlay under 150 nodes at Session level on a 5k-step session", () => {
    const p = prepare(largeSession());
    const layout = layoutOverview({ overview: p.overview, camera: p.fit, widthPx: 1_200, level: "session" });
    const labeled = layout.bands.filter((b) => b.tier !== null).length;
    expect(layout.pins.length + labeled + layout.turnLines.length + layout.links.length).toBeLessThanOrEqual(MAX_OVERLAY_NODES);
    expect(layout.strip.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(5_000);
  });
});

function oauthKind(session: TraceSession, index: number | undefined): string | undefined {
  return index === undefined ? undefined : session.steps[index]?.kind;
}

describe("chapter band footprints (orchestrator ruling M6)", () => {
  it("leave out a test step a chapter reaches only through a shared validation", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p", ts: TraceBuilder.at(0) });
    for (const [file, second] of [["src/a.ts", 2], ["src/b.ts", 4]] as const) {
      b.fact({ type: "git_hunk", file, added: 3, removed: 0, isFormattingOnly: false, isConfigOnly: false, isLockfile: false, ts: TraceBuilder.at(second) }, `fact_${file}`);
    }
    b.agent({ type: "command_started", command: "pnpm test", ts: TraceBuilder.at(30) });
    b.agent({ type: "command_completed", command: "pnpm test", exitCode: 0, stdout: "", stderr: "", ts: TraceBuilder.at(35) });
    b.fact({ type: "test_result", runner: "vitest", command: "pnpm test", passed: 3, failed: 0, skipped: 0, failures: [], ts: TraceBuilder.at(35) }, "fact_tr");
    b.validation({ id: "val_1", kind: "test", command: "pnpm test", status: "passed", passed: 3, failed: 0, skipped: 0 });
    // Like every oauth unit, both cite the run's test_result fact as well as the validation.
    b.unit({ id: "cu_a", files: ["src/a.ts"], title: "Changed 1 file: src/a.ts", evidence: ["fact_src/a.ts", "fact_tr"], validationResults: ["val_1"] });
    b.unit({ id: "cu_b", files: ["src/b.ts"], title: "Changed 1 file: src/b.ts", evidence: ["fact_src/b.ts", "fact_tr"], validationResults: ["val_1"] });
    const session = foldRows(testMeta(), b.rows, { live: false });
    const index = buildTraceIndex(session);
    const scale = buildTimeScale(timeScaleInputOf(session));
    const overview = buildOverviewIndex(session, index, scale);
    const testU = scale.toU(30_000);
    expect(overview.bands).toHaveLength(2);
    for (const band of overview.bands) expect(band.u1).toBeLessThan(testU);
    // Band labels use the chapter's short title (ruling M2).
    expect(overview.bands.map((band) => band.title)).toEqual(["Code · a", "Code · b"]);
  });
});
