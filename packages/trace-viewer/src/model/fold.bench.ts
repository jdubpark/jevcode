import { bench, describe } from "vitest";

import { SYNTHETIC_META, syntheticRows } from "../test-support/synthetic-rows.js";
import { accumulate, accumulateAll, createTraceState, finalize, foldRows } from "./fold.js";

// Budgets (R8; a benchmark, not a CI gate): a full fold of 75k rows <= 500 ms and one appended
// row <= 2 ms. Read the "mean" column (ms) of `pnpm --filter @jevcode/trace-viewer bench`.

const ROWS = syntheticRows(75_000);
const META = { ...SYNTHETIC_META, lastEventSeq: ROWS.length };
const EXTRA = syntheticRows(ROWS.length + 5_000).slice(ROWS.length);

describe("trace fold budgets", () => {
  bench(
    "fold 75k rows",
    () => {
      foldRows(META, ROWS, { live: false });
    },
    { iterations: 5, warmupIterations: 1 },
  );

  let state = accumulateAll(createTraceState(META), ROWS);
  let appended = 0;
  bench(
    "append 1 row",
    () => {
      const row = EXTRA[appended];
      appended += 1;
      if (row !== undefined) accumulate(state, row);
    },
    {
      iterations: 1_000,
      time: 0,
      setup: () => {
        state = accumulateAll(createTraceState(META), ROWS);
        appended = 0;
      },
    },
  );

  bench(
    "finalize 75k rows (one live poll)",
    () => {
      finalize(state, { live: true });
    },
    {
      iterations: 5,
      warmupIterations: 1,
      setup: () => {
        state = accumulateAll(createTraceState(META), ROWS);
      },
    },
  );
});
