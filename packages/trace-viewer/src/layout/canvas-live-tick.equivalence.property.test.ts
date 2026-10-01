import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { TraceRow, TraceSessionSummary } from "@jevcode/contracts";

import { accumulateAll, createTraceState, finalize } from "../model/fold.js";
import type { Level, TraceSession } from "../model/index.js";
import { arbTraceSession } from "../test-support/arbitraries.js";
import { arbCanvasSession, oauthCanvasSession } from "../test-support/canvas-arbitraries.js";
import { FIXTURE_NAMES, loadFixtureTrace } from "../test-support/fixture-rows.js";
import { arbDenseRowSession, arbRowSession, soakShapedRows } from "../test-support/row-arbitraries.js";
import { arbEdit, editSession } from "../test-support/session-edits.js";
import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import {
  buildFrameContext,
  buildFrameMarks,
  frameFlag,
  frameMarksWork,
  frameRunning,
  frameTone,
  ownSteps,
  type FrameMarks,
} from "../ui/views/canvas/frame-label.js";
import { LEVEL_SPECS } from "./canvas-levels.js";
import { canvasLayoutWork, collectItems, layoutCanvas, type CanvasLayout } from "./canvas-layout.js";
import { homeFrameKey, routeEdges, type RouteInput } from "./canvas-routes.js";
import { buildTimeScale, timeScaleInputOf } from "./time-scale.js";
import { anchoredFindings, stepTone } from "./tone.js";
import { buildTraceIndex, type TraceIndex } from "./trace-index.js";

// The Canvas live-tick optimizations (set lookups instead of per-link step listing, pair dedup while routing) must
// equal the straightforward definitions. The references below are written from the spec rules, not from the code.

const levels = fc.constantFrom<Level>("session", "chapter", "step");

interface SharedRunShape {
  runs: readonly { failed: boolean }[];
  units: readonly { noise: boolean; tests: boolean; cites: readonly boolean[] }[];
  openCommand: boolean;
}

const arbSharedRunShape: fc.Arbitrary<SharedRunShape> = fc.record({
  runs: fc.array(fc.record({ failed: fc.boolean() }), { minLength: 1, maxLength: 4 }),
  // Up to 20 units, so a shared run can sit in more chapters than a short list scan covers (canvas-routes homes).
  units: fc.array(
    fc.record({ noise: fc.boolean(), tests: fc.boolean(), cites: fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }) }),
    { minLength: 2, maxLength: 20 },
  ),
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
  shape.units.forEach(({ noise, tests, cites }, i) => {
    const file = `src/m${i}.ts`;
    b.fact({ type: "git_hunk", file, added: 2, removed: 1, isFormattingOnly: noise, isConfigOnly: false, isLockfile: false }, `fact_${i}`);
    const pick = <T>(list: readonly T[]): T[] => list.filter((_, r) => cites[r] ?? false);
    b.unit({
      id: `cu_${i}`,
      files: [file],
      evidence: [`fact_${i}`, ...pick(results)],
      validationResults: pick(validations),
      category: tests ? "tests" : "implementation",
    });
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
        { noise: false, tests: false, cites: [true, true] },
        { noise: true, tests: false, cites: [true, true] },
        { noise: true, tests: true, cites: [true, false] },
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

// ------------------------------------------------------------ incremental == fresh after every commit

const NOW = Date.parse("2026-09-18T09:30:00.000Z");

function foldChain(meta: TraceSessionSummary, rows: readonly TraceRow[], cuts: readonly number[], live: boolean): TraceSession[] {
  const points = [...new Set(cuts.map((cut) => cut % Math.max(1, rows.length)))].sort((a, b) => a - b);
  const state = createTraceState(meta);
  const out: TraceSession[] = [];
  let start = 0;
  for (const point of [...points, rows.length]) {
    if (point <= start && point !== rows.length) continue;
    accumulateAll(state, rows.slice(start, point));
    start = point;
    out.push(finalize(state, { live, nowMs: NOW + out.length * 1_000 }));
  }
  return out;
}

/** The marks by their reference definitions (frameTone, frameRunning, frameFlag), frame by frame. */
function referenceMarks(layout: CanvasLayout, session: TraceSession) {
  const ctx = buildFrameContext(session);
  return {
    critical: new Set(layout.frames.filter((frame) => frameTone(frame, ctx) === "bad").map((frame) => frame.key)),
    running: new Set(layout.frames.filter((frame) => frameRunning(frame, ctx)).map((frame) => frame.key)),
    flags: new Map(layout.frames.map((frame) => [frame.key, frameFlag(frame, ctx)] as const)),
  };
}

function plain(marks: FrameMarks) {
  return { critical: marks.critical, running: marks.running, flags: marks.flags };
}

/**
 * Lays out each session chained through the previous commit (index, layout, marks), as the Canvas does on a Live
 * commit, and checks every step against the fresh build: the index and marks without a previous build, the layout
 * through a copy of the previous layout that carries none of its caches.
 */
function checkCanvasChain(sessions: readonly TraceSession[], level: Level): void {
  let index: TraceIndex | undefined;
  let layout: CanvasLayout | undefined;
  let marks: FrameMarks | undefined;
  for (const session of sessions) {
    index = buildTraceIndex(session, index);
    const scale = buildTimeScale(timeScaleInputOf(session));
    const next = layoutCanvas(session, index, scale, level, layout);
    const fresh = layoutCanvas(session, buildTraceIndex(session), scale, level, layout === undefined ? undefined : { ...layout });
    expect(next).toEqual(fresh);
    const ctx = buildFrameContext(session);
    const nextMarks = buildFrameMarks(next, ctx, marks);
    expect(plain(nextMarks)).toEqual(plain(buildFrameMarks(next, ctx)));
    expect(plain(nextMarks)).toEqual(referenceMarks(next, session));
    layout = next;
    marks = nextMarks;
  }
}

const cutsArb = fc.uniqueArray(fc.nat(), { maxLength: 8 });

describe("Canvas derivations built from the previous commit equal fresh ones after every commit", () => {
  it("random rows, live or not", () => {
    fc.assert(
      fc.property(arbRowSession(), cutsArb, fc.boolean(), levels, ({ meta, rows }, cuts, live, level) => {
        checkCanvasChain(foldChain(meta, rows, cuts, live), level);
      }),
      { numRuns: Number(process.env["CANVAS_CHAIN_RUNS"] ?? 150) },
    );
  }, 600_000);

  it("dense id pools, live or not", () => {
    fc.assert(
      fc.property(arbDenseRowSession(), cutsArb, fc.boolean(), levels, ({ meta, rows }, cuts, live, level) => {
        checkCanvasChain(foldChain(meta, rows, cuts, live), level);
      }),
      { numRuns: Number(process.env["CANVAS_CHAIN_RUNS"] ?? 150) },
    );
  }, 600_000);

  it("row by row", () => {
    fc.assert(
      fc.property(arbRowSession({ maxOps: 20 }), levels, ({ meta, rows }, level) => {
        checkCanvasChain(foldChain(meta, rows, rows.map((_, i) => i + 1), true), level);
      }),
      { numRuns: 30 },
    );
  }, 600_000);

  it.each(FIXTURE_NAMES)("%s: every prefix at Chapter level, random splits at every level", (name) => {
    const trace = loadFixtureTrace(name);
    checkCanvasChain(foldChain(trace.meta, trace.rows, trace.rows.map((_, i) => i + 1), true), "chapter");
    fc.assert(
      fc.property(cutsArb, levels, (cuts, level) => checkCanvasChain(foldChain(trace.meta, trace.rows, cuts, true), level)),
      { numRuns: 10 },
    );
  }, 600_000);

  it("soak-shaped rows (runs every unit cites): random splits", () => {
    const { meta, rows } = soakShapedRows({ units: 40, runs: 5, reemits: 2 });
    fc.assert(
      fc.property(cutsArb, levels, (cuts, level) => checkCanvasChain(foldChain(meta, rows, cuts, true), level)),
      { numRuns: 10 },
    );
  }, 600_000);

  it("hand-edited sessions (flipped findings, moved steps, disagreeing joins): chains of copy-on-write edits", () => {
    fc.assert(
      fc.property(
        arbTraceSession({ maxSteps: 14, maxChapters: 5 }),
        fc.array(fc.array(arbEdit, { maxLength: 6 }), { minLength: 1, maxLength: 5 }),
        levels,
        (session, rounds, level) => {
          const chain = [session];
          for (const edits of rounds) chain.push(editSession(chain[chain.length - 1] ?? session, edits));
          checkCanvasChain(chain, level);
        },
      ),
      { numRuns: 300 },
    );
  }, 600_000);

  it("shared test runs under edits (categories, anchors, drops): homes kept from the previous commit stay the lowest", () => {
    fc.assert(
      fc.property(
        arbSharedRunShape.map(sharedRunSession),
        fc.array(fc.array(arbEdit, { maxLength: 4 }), { minLength: 1, maxLength: 5 }),
        levels,
        (session, rounds, level) => {
          const chain = [session];
          for (const edits of rounds) chain.push(editSession(chain[chain.length - 1] ?? session, edits));
          checkCanvasChain(chain, level);
        },
      ),
      { numRuns: 300 },
    );
  }, 600_000);

  it("a chapter that does not list a shared run never becomes its home, however low its anchor moves", () => {
    const units = Array.from({ length: 20 }, (_, i) => ({ noise: false, tests: i % 3 === 0, cites: [i < 18, true, false, false] }));
    const session = sharedRunSession({ runs: [{ failed: true }, { failed: false }], units, openCommand: false });
    const run = session.steps.find((step) => step.chapterIds.length > 16);
    if (run === undefined) throw new Error("no widely shared run");
    const outsider = session.chapters.findIndex((chapter) => chapter.current && !chapter.stepIds.includes(run.id));
    expect(outsider).toBeGreaterThanOrEqual(0);
    const moved = editSession(session, [{ op: "chapterFacts", at: outsider, seq: 0 }]);
    for (const level of ["session", "chapter", "step"] as const) checkCanvasChain([session, moved], level);
  });

  it("a kept noise chapter follows its own step's anchored finding (stack or not) in both directions", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "command_started", command: "pnpm test" });
    b.agent({ type: "command_completed", command: "pnpm test", exitCode: 1, stdout: "", stderr: "" });
    const failures = [{ file: "a", testName: "t", message: "m" }];
    b.fact({ type: "test_result", runner: "vitest", command: "pnpm test", passed: 4, failed: 1, skipped: 0, failures }, "fact_tr_0");
    b.validation({ id: "val_0", kind: "test", command: "pnpm test", status: "failed", passed: 4, failed: 1, skipped: 0 });
    b.agent({ type: "file_changed", path: "src/m0.ts", callId: "edit_0" });
    b.fact({ type: "git_hunk", file: "src/m0.ts", added: 2, removed: 1, isFormattingOnly: false, isConfigOnly: false, isLockfile: false }, "fact_0");
    b.unit({ id: "cu_0", files: ["src/m0.ts"], evidence: ["fact_0", "fact_tr_0"], agentCallIds: ["edit_0"], validationResults: ["val_0"] });
    const rows = b.rows;
    const folded = finalize(accumulateAll(createTraceState(testMeta({ lastEventSeq: rows.length, state: "running" })), rows), { live: true, nowMs: 0 });
    // One noise chapter whose own test run anchors the failing-tests finding; the chapter names no finding itself.
    const chapter = folded.chapters[0];
    const run = folded.steps.find((step) => step.findingIds.length > 0);
    if (chapter === undefined || run === undefined) throw new Error("shape");
    const noisy = { ...chapter, noise: true, findingIds: [] };
    const flagged: TraceSession = { ...folded, chapters: [noisy] };
    const quiet: TraceSession = {
      ...flagged,
      steps: folded.steps.map((step) => (step === run ? { ...run, findingIds: [] } : step)),
      findings: [],
    };
    expect(collectItems(flagged, buildTraceIndex(flagged)).find((item) => item.selId === noisy.id)?.kind).toBe("chapter");
    expect(collectItems(quiet, buildTraceIndex(quiet)).find((item) => item.selId === noisy.id)?.kind).toBe("noise");
    for (const level of ["session", "chapter", "step"] as const) {
      checkCanvasChain([flagged, quiet], level);
      checkCanvasChain([quiet, flagged], level);
    }
  });

  it("a claim's ≠ flag follows its finding even when the claim step object is kept", () => {
    // A warning, so moving it flips no step bad and only the claim's own findings tell.
    const original = oauthCanvasSession();
    const critical = original.findings.find((f) => f.ruleId === "claim_contradicted");
    if (critical === undefined) throw new Error("no contradiction");
    const finding = { ...critical, severity: "warning" as const };
    const session = { ...original, findings: original.findings.map((f) => (f === critical ? finding : f)) };
    const { layout } = layoutOf(session, "chapter");
    const marks = buildFrameMarks(layout, buildFrameContext(session));
    expect([...marks.flags.values()]).toContain("neq");
    // The finding re-anchors on one of its evidence steps; the claim step still lists it (as a citing finding).
    const moved = { ...finding, anchorStepId: finding.evidenceStepIds?.[0] ?? finding.anchorStepId };
    const next = { ...session, findings: session.findings.map((f) => (f === finding ? moved : f)) };
    const ctx = buildFrameContext(next);
    expect(plain(buildFrameMarks(layout, ctx, marks))).toEqual(plain(buildFrameMarks(layout, ctx)));
  });

  it("marks built from any earlier marks, even another session's, equal fresh marks", () => {
    fc.assert(
      fc.property(arbCanvasSession({ maxSeeds: 12 }), arbCanvasSession({ maxSeeds: 12 }), levels, (a, b, level) => {
        const first = layoutOf(a, level);
        const second = layoutOf(b, level);
        const earlier = buildFrameMarks(first.layout, buildFrameContext(a));
        const ctx = buildFrameContext(b);
        expect(plain(buildFrameMarks(second.layout, ctx, earlier))).toEqual(plain(buildFrameMarks(second.layout, ctx)));
      }),
      { numRuns: 100 },
    );
  });
});

// ------------------------------------------------------------ work

/** Soak-shaped session, then one Live drip: a unit re-emitted and a new message. */
function soakDrip(units: number) {
  const { meta, rows } = soakShapedRows({ units, runs: 6, reemits: 1 });
  const state = accumulateAll(createTraceState(meta), rows);
  const before = finalize(state, { live: true, nowMs: NOW });
  const unitRow = [...rows].reverse().find((row) => row.type === "change_unit");
  if (unitRow === undefined) throw new Error("no unit");
  const b = new TraceBuilder();
  for (const row of rows) b.rows.push(row);
  b.raw("change_unit", { ...(unitRow.payload as object), status: "validated" });
  b.agent({ type: "agent_message", role: "assistant", text: "Still working" });
  accumulateAll(state, b.rows.slice(rows.length));
  const after = finalize(state, { live: true, nowMs: NOW });
  const index = buildTraceIndex(before);
  const scale = buildTimeScale(timeScaleInputOf(before));
  const layoutBefore = layoutCanvas(before, index, scale, "chapter");
  const nextIndex = buildTraceIndex(after, index);
  const layoutAfter = layoutCanvas(after, nextIndex, buildTimeScale(timeScaleInputOf(after)), "chapter", layoutBefore);
  return { before, after, layoutBefore, layoutAfter };
}

describe("Canvas marks from the previous commit: work", () => {
  it("a drip that flips no step re-derives only the frames it changed, however long the session", () => {
    const work = (units: number) => {
      const { before, after, layoutBefore, layoutAfter } = soakDrip(units);
      const marks = buildFrameMarks(layoutBefore, buildFrameContext(before));
      return frameMarksWork(buildFrameMarks(layoutAfter, buildFrameContext(after), marks));
    };
    const small = work(60);
    const large = work(240);
    expect(large?.frames).toBeGreaterThan(small?.frames ?? 0);
    // The re-emitted unit's frame and the frame the new message joins; no link scan without a flip.
    expect(large?.derived).toBe(small?.derived);
    expect(large?.derived).toBeLessThanOrEqual(3);
    expect(large?.links).toBe(0);
  });

  it("a drip routes from the previous layout's homes and validation sources, however long the session", () => {
    const work = (units: number) => {
      const { layoutBefore, layoutAfter } = soakDrip(units);
      return { before: canvasLayoutWork(layoutBefore)?.route, after: canvasLayoutWork(layoutAfter)?.route };
    };
    const small = work(60);
    const large = work(240);
    // A fresh layout reads every shared run's chapter list and every chapter's validations: O(units · runs).
    expect(large.before?.homeLinks).toBeGreaterThan(3 * (small.before?.homeLinks ?? 0));
    expect(large.before?.validationLinks).toBeGreaterThan(3 * (small.before?.validationLinks ?? 0));
    // The drip re-emits one unit: only its frame's validations are re-read, and each shared run's kept home is
    // checked against the few placed chapters that changed.
    expect(large.after).toEqual(small.after);
    expect(large.after?.validationLinks).toBeLessThanOrEqual(6);
    expect(large.after?.homeLinks).toBeLessThan(60);
  });

  it("a drip that changes no anchoring keeps every other chapter's noise flag without reading its steps", () => {
    const links = (units: number) => canvasLayoutWork(soakDrip(units).layoutAfter)?.items.flagLinks;
    // Only the re-emitted unit is a new object: its own links (its edit, its evidence and the shared runs) are read.
    expect(links(240)).toBe(links(60));
    expect(links(240)).toBeLessThanOrEqual(10);
  });

  it("the same layout and context re-derive nothing", () => {
    const { after, layoutAfter } = soakDrip(30);
    const ctx = buildFrameContext(after);
    const marks = buildFrameMarks(layoutAfter, ctx);
    expect(frameMarksWork(marks)?.derived).toBe(layoutAfter.frames.length);
    expect(frameMarksWork(buildFrameMarks(layoutAfter, ctx, marks))).toEqual({ frames: layoutAfter.frames.length, derived: 0, links: 0 });
  });
});
