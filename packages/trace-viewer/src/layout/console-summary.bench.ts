import { bench, describe } from "vitest";

import type { StoryModel } from "../model/index.js";
import type { ConsoleRow, ConsoleRowsState } from "./console-rows.js";
import { mergeSummaryRows } from "./console-summary.js";

// Spec §11 Console append (p95 ≤ 150 ms end to end): merging summaries must stay a small part of a rebuild.
const rows: ConsoleRow[] = Array.from({ length: 10_000 }, (_, i) => ({
  kind: "message",
  key: `m${2 * i + 2}`,
  stepId: `step:${2 * i + 2}`,
  text: "x",
}));
const byStep = new Map<string, number>(rows.map((_row, index) => [`step:${2 * index + 2}`, index]));
const base: ConsoleRowsState = { rows, byStep };
const stories: StoryModel[] = Array.from({ length: 500 }, (_, i) => ({
  seq: 40 * i + 1,
  basisSeq: 40 * i,
  provenance: "model",
  sentences: [{ text: "The agent made progress.", citations: [{ kind: "step", id: "step:2" }] }],
}));

describe("Console summary rows", () => {
  bench("merge 500 stories into 10,000 step rows", () => {
    mergeSummaryRows(base, stories);
  });
});
