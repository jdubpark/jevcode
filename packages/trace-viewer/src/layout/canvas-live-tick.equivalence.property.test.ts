import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { accumulateAll, createTraceState, finalize } from "../model/fold.js";
import type { Level, TraceSession } from "../model/index.js";
import { arbCanvasSession } from "../test-support/canvas-arbitraries.js";
import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { buildFrameContext, frameRunning, frameTone, ownSteps } from "../ui/views/canvas/frame-label.js";
import { LEVEL_SPECS } from "./canvas-levels.js";
import { collectItems, layoutCanvas } from "./canvas-layout.js";
import { homeFrameKey, routeEdges, type RouteInput } from "./canvas-routes.js";
import { buildTimeScale, timeScaleInputOf } from "./time-scale.js";
import { anchoredFindings, stepTone } from "./tone.js";
import { buildTraceIndex } from "./trace-index.js";

// The Canvas live-tick optimizations (set lookups instead of per-link step listing, pair dedup while routing) must
// equal the straightforward definitions. The references below are written from the spec rules, not from the code.

const levels = fc.constantFrom<Level>("session", "chapter", "step");

interface SharedRunShape {
  runs: readonly { failed: boolean }[];
  units: readonly { noise: boolean; cites: readonly boolean[] }[];
  openCommand: boolean;
}

const arbSharedRunShape: fc.Arbitrary<SharedRunShape> = fc.record({
  runs: fc.array(fc.record({ failed: fc.boolean() }), { minLength: 1, maxLength: 4 }),
  units: fc.array(fc.record({ noise: fc.boolean(), cites: fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }) }), {
    minLength: 2,
    maxLength: 8,
  }),
  openCommand: fc.boolean(),
});

/** Units that cite shared test runs: a run is validation-only in every chapter but the one that owns its outcome. */
function sharedRunSession(shape: SharedRunShape): TraceSession {
  const b = new TraceBuilder();
  b.agent({ type: "agent_started", prompt: "p" });
  const validations: string[] = [];
  const results: string[] = [];
  shape.runs.forEach(({ failed }, r) => {
    b.agent({ type: "command_started", command: "pnpm test" });
    b.agent({ type: "command_completed", command: "pnpm test", exitCode: failed ? 1 : 0, stdout: "", stderr: "" });
    const failures = failed ? [{ file: "tests/a.test.ts", testName: "links", message: "expected null to be 7" }] : [];
    b.fact({ type: "test_result", runner: "vitest", command: "pnpm test", passed: 4, failed: failed ? 1 : 0, skipped: 0, failures }, `fact_tr_${r}`);
    b.validation({ id: `val_${r}`, kind: "test", command: "pnpm test", status: failed ? "failed" : "passed", passed: 4, failed: failed ? 1 : 0, skipped: 0 });
    validations.push(`val_${r}`);
    results.push(`fact_tr_${r}`);
  });
  shape.units.forEach(({ noise, cites }, i) => {
    const file = `src/m${i}.ts`;
    b.fact({ type: "git_hunk", file, added: 2, removed: 1, isFormattingOnly: noise, isConfigOnly: false, isLockfile: false }, `fact_${i}`);
    const pick = <T>(list: readonly T[]): T[] => list.filter((_, r) => cites[r] ?? false);
    b.unit({ id: `cu_${i}`, files: [file], evidence: [`fact_${i}`, ...pick(results)], validationResults: pick(validations) });
  });
  if (shape.openCommand) b.agent({ type: "command_started", command: "pnpm dev" });
  const rows = b.rows;
  const state = accumulateAll(createTraceState(testMeta({ lastEventSeq: rows.length, state: "running" })), rows);
  return finalize(state, { live: true, nowMs: 0 });
}

const arbSession = fc.oneof(arbCanvasSession({ maxSeeds: 25 }), arbSharedRunShape.map(sharedRunSession));

function layoutOf(session: TraceSession, level: Level) {
  const index = buildTraceIndex(session);
  return { index, layout: layoutCanvas(session, index, buildTimeScale(timeScaleInputOf(session)), level) };
}

describe("Canvas live-tick optimizations equal their reference definitions", () => {
  it("shared-run generator yields validation-only steps, failed tone and a running step", () => {
    const session = sharedRunSession({
      runs: [{ failed: true }, { failed: false }],
      units: [
        { noise: false, cites: [true, true] },
        { noise: true, cites: [true, true] },
        { noise: true, cites: [true, false] },
      ],
      openCommand: true,
    });
    expect(session.chapters.some((chapter) => (chapter.validationOnlyStepIds ?? []).length > 0)).toBe(true);
    expect(session.steps.some((step) => step.endTMs === null)).toBe(true);
    const { layout } = layoutOf(session, "chapter");
    const ctx = buildFrameContext(session);
    expect(layout.frames.some((frame) => frameTone(frame, ctx) === "bad")).toBe(true);
  });

  it("frameTone and frameRunning equal ownSteps(...).some(...)", () => {
    fc.assert(
      fc.property(arbSession, levels, (session, level) => {
        const { layout } = layoutOf(session, level);
        const ctx = buildFrameContext(session);
        for (const frame of layout.frames) {
          const own = ownSteps(frame, ctx);
          const bad = own.some((step) => stepTone(step, ctx.findingsById) === "bad");
          const running = own.some((step) => step.endTMs === null);
          expect(frameTone(frame, ctx), frame.key).toBe(bad ? "bad" : "neutral");
          expect(frameRunning(frame, ctx), frame.key).toBe(running);
        }
      }),
      { numRuns: 150 },
    );
  });

  it("a noise chapter stays in its stack unless a finding names it or an own step anchors one (spec 7.5)", () => {
    fc.assert(
      fc.property(arbSession, (session) => {
        const { index } = layoutOf(session, "chapter");
        const byId = new Map(session.findings.map((finding) => [finding.id, finding]));
        const stepById = new Map(session.steps.map((step) => [step.id, step]));
        const kindOf = new Map(collectItems(session, index).map((item) => [item.selId, item.kind] as const));
        for (const chapter of session.chapters) {
          if (!chapter.current) continue;
          const validationOnly = new Set(chapter.validationOnlyStepIds ?? []);
          const flagged =
            chapter.findingIds.length > 0 ||
            chapter.stepIds.some((id) => {
              const step = stepById.get(id);
              return step !== undefined && !validationOnly.has(id) && anchoredFindings(step, byId).length > 0;
            });
          expect(kindOf.get(chapter.id), chapter.id).toBe(chapter.noise && !flagged ? "noise" : "chapter");
        }
      }),
      { numRuns: 150 },
    );
  });

  it("validates edges equal the undeduplicated pair list deduplicated afterwards, in age order", () => {
    fc.assert(
      fc.property(arbSession, levels, (session, level) => {
        const { layout } = layoutOf(session, level);
        const frameByKey = new Map(layout.frames.map((frame) => [frame.key, frame]));
        const input: RouteInput = {
          session,
          frames: layout.frames,
          frameByKey,
          columns: layout.columns,
          spec: LEVEL_SPECS[layout.level],
        };
        const frameOf = new Map<string, (typeof layout.frames)[number]>();
        layout.frames.forEach((frame) => {
          for (const selId of frame.memberSelIds) if (!frameOf.has(selId)) frameOf.set(selId, frame);
        });
        // Reference: every (chapter frame, validation step home) pair, no dedup, then unique by id and sorted by age
        // (newest endpoint by frame order, as routeEdges does without an `order` input), then from, then to.
        const pairs: { id: string; from: string; to: string }[] = [];
        for (const chapter of session.chapters) {
          const from = frameOf.get(chapter.id);
          if (from === undefined) continue;
          for (const stepId of chapter.validationStepIds) {
            const to = homeFrameKey(stepId, input);
            if (to !== undefined && to !== from.key) pairs.push({ id: `validates:${from.key}>${to}`, from: from.key, to });
          }
        }
        const unique = new Map(pairs.map((pair) => [pair.id, pair] as const));
        const at = (key: string): number => layout.frames.findIndex((frame) => frame.key === key);
        const expected = [...unique.values()]
          .sort((a, b) => Math.max(at(a.from), at(a.to)) - Math.max(at(b.from), at(b.to)) || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) || (a.to < b.to ? -1 : a.to > b.to ? 1 : 0))
          .map((pair) => pair.id);
        const actual = routeEdges(input).edges.filter((edge) => edge.kind === "validates").map((edge) => edge.id);
        expect(actual).toEqual(expected);
      }),
      { numRuns: 150 },
    );
  });
});
