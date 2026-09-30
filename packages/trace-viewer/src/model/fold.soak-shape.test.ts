import { describe, expect, it } from "vitest";

import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { accumulateAll, createTraceState, finalize } from "./fold.js";

// Soak-shaped timing guard (C2 fix wave, integration item 7). The soak bundle has a few shared test runs that every
// change unit cites (31 runs across 4,861 chapters). A per-chapter scan of a shared run's chapters is O(chapters²) per
// run: M part 1 shipped one in buildChapters and finalize went from 0.18 s to 14 s without any test noticing, because
// the 75k synthetic bench cites no shared validation. This shape (5,000 units × 8 shared runs) finalizes in well under
// the budget when every pass is linear, and takes several times the budget with that regression restored.

const UNITS = 5_000;
const RUNS = 8;
/** Median finalize budget: about 90 ms today on an M3 Max, about 2.5 s with the buildChapters regression restored. */
const FINALIZE_BUDGET_MS = 500;

function soakShapedRows() {
  const b = new TraceBuilder();
  b.agent({ type: "agent_started", prompt: "p" });
  const validations: string[] = [];
  const results: string[] = [];
  for (let r = 0; r < RUNS; r += 1) {
    b.agent({ type: "command_started", command: "pnpm test" });
    b.agent({ type: "command_completed", command: "pnpm test", exitCode: r === RUNS - 1 ? 0 : 1, stdout: "", stderr: "" });
    const failed = r === RUNS - 1 ? 0 : 1;
    const failures = failed === 0 ? [] : [{ file: "tests/a.test.ts", testName: "links", message: "expected null to be 7" }];
    b.fact({ type: "test_result", runner: "vitest", command: "pnpm test", passed: 40, failed, skipped: 0, failures }, `fact_tr_${r}`);
    b.validation({ id: `val_${r}`, kind: "test", command: "pnpm test", status: failed === 0 ? "passed" : "failed", passed: 40, failed, skipped: 0 });
    validations.push(`val_${r}`);
    results.push(`fact_tr_${r}`);
  }
  for (let i = 0; i < UNITS; i += 1) {
    const file = `src/m${i}.ts`;
    b.fact({ type: "git_hunk", file, added: 2, removed: 1, isFormattingOnly: false, isConfigOnly: false, isLockfile: false }, `fact_${i}`);
    b.unit({ id: `cu_${i}`, files: [file], evidence: [`fact_${i}`, ...results], validationResults: validations });
  }
  return b.rows;
}

describe("fold on a soak-shaped session (shared validations)", () => {
  it(`finalizes ${UNITS} units that all cite ${RUNS} shared runs within ${FINALIZE_BUDGET_MS} ms`, () => {
    const rows = soakShapedRows();
    const meta = testMeta({ lastEventSeq: rows.length });
    const state = accumulateAll(createTraceState(meta), rows);
    const times: number[] = [];
    let chapters = 0;
    for (let i = 0; i < 3; i += 1) {
      const start = performance.now();
      const session = finalize(state, { live: false });
      times.push(performance.now() - start);
      chapters = session.chapters.length;
    }
    expect(chapters).toBe(UNITS);
    const median = [...times].sort((a, b) => a - b)[1] ?? Number.POSITIVE_INFINITY;
    expect(median, `finalize runs ${times.map((t) => t.toFixed(0)).join(", ")} ms`).toBeLessThan(FINALIZE_BUDGET_MS);
  }, 60_000);
});
