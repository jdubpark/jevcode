import type { StoryModel } from "../model/index.js";
import { consoleRowStepIds, type ConsoleRow, type ConsoleRowsState } from "./console-rows.js";

// Spec §3.2: a "◆ Summary" block per story refresh. A block sits where its story row arrived: after every
// step that started before that row (lane 07 alignment note "summary block position"). Stories are in seq
// order (fold-explainer.ts), so a two-pointer merge places them, and a live story row always lands after the
// rows already shown, so appends never insert above them (no jump while the reader is scrolled back).

type SummaryRow = Extract<ConsoleRow, { kind: "summary" }>;

/** One row object per story, so a memoized row view keeps its render across merges (ConsoleRowView's sameRowProps). */
const SUMMARY_ROWS = new WeakMap<StoryModel, SummaryRow>();

export function summaryRowKey(story: StoryModel): string {
  return `summary:${story.seq}`;
}

/**
 * The seq a row hangs off: its first step's firstSeq (StepId is step:<firstSeq>); null for summary rows. Every kind names
 * its steps through consoleRowStepIds (lane 02b), including the `guardrails` fold, which has `stepIds`, not `stepId`.
 */
export function rowAnchorSeq(row: ConsoleRow): number | null {
  const first = consoleRowStepIds(row)[0];
  return first === undefined ? null : Number(first.slice("step:".length));
}

function summaryRow(story: StoryModel): SummaryRow {
  let row = SUMMARY_ROWS.get(story);
  if (row === undefined) {
    row = { kind: "summary", key: summaryRowKey(story), sentences: story.sentences, provenance: story.provenance };
    SUMMARY_ROWS.set(story, row);
  }
  return row;
}

export function mergeSummaryRows(base: ConsoleRowsState, stories: readonly StoryModel[]): ConsoleRowsState {
  if (stories.length === 0) return base;
  const rows: ConsoleRow[] = [];
  const position: number[] = [];
  let next = 0;
  let anchor = 0;
  for (const row of base.rows) {
    anchor = rowAnchorSeq(row) ?? anchor;
    for (let story = stories[next]; story !== undefined && story.seq < anchor; story = stories[next]) {
      rows.push(summaryRow(story));
      next += 1;
    }
    position.push(rows.length);
    rows.push(row);
  }
  for (let story = stories[next]; story !== undefined; story = stories[next]) {
    rows.push(summaryRow(story));
    next += 1;
  }
  const byStep = new Map<string, number>();
  for (const [key, index] of base.byStep) byStep.set(key, position[index] ?? index);
  return { rows, byStep, base, stories };
}
