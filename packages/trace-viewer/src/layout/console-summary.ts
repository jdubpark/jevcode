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

/**
 * byStep of a merged state: the base row of a step, moved by the summary rows above it. A view over the base map and the
 * row positions, so a live commit does not copy a 10,000-entry map (the Console reads it only through get); iterating
 * builds the map once.
 */
class ShiftedByStep implements ReadonlyMap<string, number> {
  private map: Map<string, number> | null = null;

  constructor(
    private readonly base: ReadonlyMap<string, number>,
    private readonly position: readonly number[],
  ) {}

  get size(): number {
    return this.base.size;
  }

  get(key: string): number | undefined {
    const at = this.base.get(key);
    return at === undefined ? undefined : (this.position[at] ?? at);
  }

  has(key: string): boolean {
    return this.base.has(key);
  }

  forEach(callback: (value: number, key: string, map: ReadonlyMap<string, number>) => void, thisArg?: unknown): void {
    this.materialized().forEach((value, key) => callback.call(thisArg, value, key, this));
  }

  entries(): MapIterator<[string, number]> {
    return this.materialized().entries();
  }

  keys(): MapIterator<string> {
    return this.base.keys();
  }

  values(): MapIterator<number> {
    return this.materialized().values();
  }

  [Symbol.iterator](): MapIterator<[string, number]> {
    return this.materialized().entries();
  }

  private materialized(): Map<string, number> {
    if (this.map === null) {
      this.map = new Map();
      for (const [key, at] of this.base) this.map.set(key, this.position[at] ?? at);
    }
    return this.map;
  }
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
  return { rows, byStep: new ShiftedByStep(base.byStep, position), base, stories };
}
