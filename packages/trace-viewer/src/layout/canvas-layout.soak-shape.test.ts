import { describe, expect, it } from "vitest";

import { accumulateAll, createTraceState, finalize } from "../model/fold.js";
import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { collectItems, layoutCanvas } from "./canvas-layout.js";
import { LEVEL_SPECS, stepFinder } from "./canvas-levels.js";
import { routeEdges, type RouteInput } from "./canvas-routes.js";
import { buildTraceIndex } from "./trace-index.js";
import { buildFrameContext, criticalFrameKeys, frameTone } from "../ui/views/canvas/frame-label.js";
import { buildTimeScale, timeScaleInputOf } from "./time-scale.js";

// Soak-shaped timing guard for the Canvas live tick (M5 risk from the M4b exit). The soak bundle's 4,861 change units
// each cite the same 31 shared test runs, so its chapters hold ~160k chapter-step links while the layout has ~135
// frames. Every live commit re-lays out the whole session (the fold rebuilds it), so the layout must spend a few map
// lookups per link: before this guard, collectItems re-derived each chapter's anchor and ran stepOf and anchoredFindings
// per link, and routing walked each shared run's 4,861 chapters with several lookups each, for ~75 ms on this shape
// (~120 ms on soak). With per-link work kept to set and map lookups it takes ~12 ms on an M3 Max. The regression guard
// counts chapterAnchor and stepOf calls, which scale with chapters and frames, not with chapter-step links; wall time
// is only a loose sanity bound.

const UNITS = 5_000;
const RUNS = 31;
/** Loose sanity bound for one sticky layout after a 20-row append (~12 ms on an M3 Max); call counts are the guard. */
const SANITY_BUDGET_MS = 1_000;

function soakShapedRows() {
  const b = new TraceBuilder();
  b.agent({ type: "agent_started", prompt: "p" });
  const validations: string[] = [];
  const results: string[] = [];
  for (let r = 0; r < RUNS; r += 1) {
    // Every third run fails, so failed-test findings are anchored at shared runs every chapter cites.
    const failed = r % 3 === 0 ? 1 : 0;
    b.agent({ type: "command_started", command: "pnpm test" });
    b.agent({ type: "command_completed", command: "pnpm test", exitCode: failed, stdout: "", stderr: "" });
    const failures = failed === 0 ? [] : [{ file: "tests/a.test.ts", testName: "links", message: "expected null to be 7" }];
    b.fact({ type: "test_result", runner: "vitest", command: "pnpm test", passed: 40, failed, skipped: 0, failures }, `fact_tr_${r}`);
    b.validation({ id: `val_${r}`, kind: "test", command: "pnpm test", status: failed === 0 ? "passed" : "failed", passed: 40, failed, skipped: 0 });
    validations.push(`val_${r}`);
    results.push(`fact_tr_${r}`);
  }
  for (let i = 0; i < UNITS; i += 1) {
    const file = `src/m${i}.ts`;
    // Formatting-only edits make noise chapters, which stack (soak: 4,800 of 4,861); every 100th is a full chapter.
    const noise = i % 100 !== 0;
    b.fact({ type: "git_hunk", file, added: 2, removed: 1, isFormattingOnly: noise, isConfigOnly: false, isLockfile: false }, `fact_${i}`);
    b.unit({ id: `cu_${i}`, files: [file], evidence: [`fact_${i}`, ...results], validationResults: validations });
  }
  return b.rows;
}

describe("layoutCanvas on a soak-shaped session (shared validations)", () => {
  it(`keeps chapterAnchor and stepOf work per chapter and frame, not per chapter-step link, for ${UNITS} units citing ${RUNS} shared runs`, () => {
    const rows = soakShapedRows();
    const meta = testMeta({ lastEventSeq: rows.length, state: "running" });
    const state = accumulateAll(createTraceState(meta), rows.slice(0, -20));
    const before = finalize(state, { live: true, nowMs: 0 });
    const prev = layoutCanvas(before, buildTraceIndex(before), buildTimeScale(timeScaleInputOf(before)), "chapter");
    accumulateAll(state, rows.slice(-20));
    const session = finalize(state, { live: true, nowMs: 0 });
    const index = buildTraceIndex(session);
    const scale = buildTimeScale(timeScaleInputOf(session));
    const links = session.chapters.reduce((sum, chapter) => sum + chapter.stepIds.length, 0);
    expect(links).toBe(UNITS * (RUNS + 1));
    const chapters = session.chapters.length;

    let anchorCalls = 0;
    const counted = { ...index, chapterAnchor: (id: Parameters<typeof index.chapterAnchor>[0]) => (anchorCalls += 1, index.chapterAnchor(id)) };
    const start = performance.now();
    const layout = layoutCanvas(session, counted, scale, "chapter", prev);
    const elapsed = performance.now() - start;
    expect(layout.frames.length).toBeLessThan(200);
    expect(elapsed, "sanity bound only; call counts are the guard").toBeLessThan(SANITY_BUDGET_MS);

    // collectItems: one anchor lookup per current chapter; stepOf only for story steps, the anchoring shortlist and
    // flagged-candidate links, never once per chapter-step link (160k here).
    let stepCalls = 0;
    const finder = stepFinder(session.steps);
    const items = collectItems(session, counted, (id) => (stepCalls += 1, finder(id)));
    expect(items.length).toBeGreaterThan(0);
    expect(anchorCalls, "chapterAnchor calls over layout + collectItems").toBeLessThanOrEqual(3 * chapters);
    expect(stepCalls, `stepOf calls in collectItems (${links} links)`).toBeLessThanOrEqual(2 * chapters);

    // Routing: the validates pass runs over every chapter's shared runs; homeKey resolves each step once.
    let routeStepCalls = 0;
    let routeAnchorCalls = 0;
    const input: RouteInput = {
      session,
      frames: layout.frames,
      frameByKey: new Map(layout.frames.map((frame) => [frame.key, frame])),
      columns: layout.columns,
      spec: LEVEL_SPECS[layout.level],
      stepOf: (id) => (routeStepCalls += 1, finder(id)),
      chapterAnchor: (id) => (routeAnchorCalls += 1, index.chapterAnchor(id)),
    };
    const routed = routeEdges(input);
    expect(routeStepCalls, `stepOf calls while routing (${links} links)`).toBeLessThanOrEqual(2 * chapters);
    expect(routeAnchorCalls, "chapterAnchor calls while routing").toBeLessThanOrEqual(chapters);

    // The result is right, not just cheap: the failed runs are shared, so only the chapters that own them are red.
    const ctx = buildFrameContext(session);
    const critical = criticalFrameKeys(layout, ctx);
    expect(critical.size).toBeGreaterThan(0);
    expect(critical.size).toBeLessThanOrEqual(Math.ceil(RUNS / 3));
    expect(critical).toEqual(new Set(layout.frames.filter((frame) => frameTone(frame, ctx) === "bad").map((frame) => frame.key)));
    const validates = routed.edges.filter((edge) => edge.kind === "validates");
    expect(validates.length).toBeGreaterThan(0);
    expect(validates.length).toBeLessThanOrEqual(layout.frames.length * RUNS);
    expect(new Set(validates.map((edge) => edge.id)).size).toBe(validates.length);
  }, 60_000);
});
