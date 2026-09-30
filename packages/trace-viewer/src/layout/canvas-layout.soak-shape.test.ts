import { describe, expect, it } from "vitest";

import { accumulateAll, createTraceState, finalize } from "../model/fold.js";
import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { layoutCanvas } from "./canvas-layout.js";
import { buildTraceIndex } from "./trace-index.js";
import { buildTimeScale, timeScaleInputOf } from "./time-scale.js";

// Soak-shaped timing guard for the Canvas live tick (M5 risk from the M4b exit). The soak bundle's 4,861 change units
// each cite the same 31 shared test runs, so its chapters hold ~160k chapter-step links while the layout has ~135
// frames. Every live commit re-lays out the whole session (the fold rebuilds it), so the layout must spend a few map
// lookups per link: before this guard, collectItems re-derived each chapter's anchor and ran stepOf and anchoredFindings
// per link, and routing walked each shared run's 4,861 chapters with several lookups each, for ~75 ms on this shape
// (~120 ms on soak). With per-link work kept to set and map lookups it takes ~12 ms on an M3 Max.

const UNITS = 5_000;
const RUNS = 31;
/** Median sticky layout budget after a 20-row append. */
const STICKY_BUDGET_MS = 40;

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
  it(`lays out ${UNITS} units that all cite ${RUNS} shared runs within ${STICKY_BUDGET_MS} ms after an append`, () => {
    const rows = soakShapedRows();
    const meta = testMeta({ lastEventSeq: rows.length, state: "running" });
    const state = accumulateAll(createTraceState(meta), rows.slice(0, -20));
    const before = finalize(state, { live: true, nowMs: 0 });
    const prev = layoutCanvas(before, buildTraceIndex(before), buildTimeScale(timeScaleInputOf(before)), "chapter");
    accumulateAll(state, rows.slice(-20));
    const session = finalize(state, { live: true, nowMs: 0 });
    const index = buildTraceIndex(session);
    const scale = buildTimeScale(timeScaleInputOf(session));
    expect(session.chapters.reduce((sum, chapter) => sum + chapter.stepIds.length, 0)).toBe(UNITS * (RUNS + 1));

    const times: number[] = [];
    let frames = 0;
    for (let i = 0; i < 5; i += 1) {
      const start = performance.now();
      frames = layoutCanvas(session, index, scale, "chapter", prev).frames.length;
      times.push(performance.now() - start);
    }
    expect(frames).toBeLessThan(200);
    const median = [...times].sort((a, b) => a - b)[2] ?? Number.POSITIVE_INFINITY;
    expect(median, `sticky layouts ${times.map((t) => t.toFixed(1)).join(", ")} ms`).toBeLessThan(STICKY_BUDGET_MS);
  }, 60_000);
});
