import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { foldRows, type StoryModel } from "../model/index.js";
import { sentence } from "../test-support/explainer-fixtures.js";
import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { buildConsoleRows, consoleNewRowCount, type ConsoleRow, type ConsoleRowsState } from "./console-rows.js";
import { mergeSummaryRows, rowAnchorSeq } from "./console-summary.js";
import { buildTraceIndex } from "./trace-index.js";

function message(seq: number): ConsoleRow {
  return { kind: "message", key: `m${seq}`, stepId: `step:${seq}`, text: `message ${seq}` };
}

function state(rows: ConsoleRow[]): ConsoleRowsState {
  const byStep = new Map<string, number>();
  rows.forEach((row, index) => {
    if ("stepId" in row) byStep.set(row.stepId, index);
  });
  return { rows, byStep };
}

function story(seq: number, basisSeq: number): StoryModel {
  return { seq, basisSeq, provenance: "model", sentences: [sentence(`story ${seq}`, { kind: "step", id: "step:1" })] };
}

describe("rowAnchorSeq", () => {
  it("reads every kind through its first step, a guardrails fold included, and gives null for a summary", () => {
    expect(rowAnchorSeq(message(4))).toBe(4);
    expect(rowAnchorSeq({ kind: "reads", key: "reads:step:6", stepIds: ["step:6", "step:8"], paths: ["a", "b"] })).toBe(6);
    expect(
      rowAnchorSeq({ kind: "guardrails", key: "guardrails:f1", stepIds: ["step:7", "step:9"], findingIds: ["f1", "f2"], findingStepIds: ["step:7", "step:9"] }),
    ).toBe(7);
    expect(rowAnchorSeq({ kind: "summary", key: "summary:3", sentences: [] })).toBeNull();
  });
});

describe("mergeSummaryRows", () => {
  it("puts each summary after the steps that started before its row and shifts byStep", () => {
    const base = state([message(1), message(2), message(5), message(8)]);
    const merged = mergeSummaryRows(base, [story(3, 2), story(12, 8)]);
    expect(merged.rows.map((row) => row.key)).toEqual(["m1", "m2", "summary:3", "m5", "m8", "summary:12"]);
    expect(merged.byStep.get("step:5")).toBe(3);
    expect(merged.base).toBe(base);
    expect(mergeSummaryRows(base, [])).toBe(base);
  });

  it("keeps a story's summary row object across merges, so a memoized row view does not re-render", () => {
    const stories = [story(3, 2)];
    const first = mergeSummaryRows(state([message(1), message(2)]), stories);
    const second = mergeSummaryRows(state([message(1), message(2), message(5)]), [...stories]);
    expect(second.rows[2]).toBe(first.rows[2]);
  });

  it("keeps the base rows, places every summary between the steps around its row, and maps byStep to the same rows", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 100 }), { maxLength: 40 }),
        fc.uniqueArray(fc.integer({ min: 0, max: 100 }), { maxLength: 8 }),
        (rowSeqs, storySeqs) => {
          // Steps on even seqs, story rows on odd seqs: a row seq is never both.
          const base = state([...rowSeqs].sort((a, b) => a - b).map((n) => message(2 * n)));
          const stories = [...storySeqs].sort((a, b) => a - b).map((n) => story(2 * n + 1, 2 * n));
          const merged = mergeSummaryRows(base, stories);
          expect(merged.rows.filter((row) => row.kind !== "summary")).toEqual(base.rows);
          merged.rows.forEach((row, index) => {
            if (row.kind !== "summary") return;
            const at = Number(row.key.slice("summary:".length));
            const before = merged.rows.slice(0, index).filter((r) => r.kind !== "summary");
            const after = merged.rows.slice(index + 1).find((r) => r.kind !== "summary");
            expect(before.every((r) => (rowAnchorSeq(r) ?? 0) < at)).toBe(true);
            expect(after === undefined || (rowAnchorSeq(after) ?? 0) > at).toBe(true);
          });
          for (const [key, index] of base.byStep) expect(merged.rows[merged.byStep.get(key) ?? -1]).toBe(base.rows[index]);
        },
      ),
    );
  });

  it("live append keeps the earlier rows as a prefix", () => {
    // Rows arrive in seq order; a story row arrives after every step already shown.
    const event = fc.oneof(fc.constant({ kind: "row" as const }), fc.constant({ kind: "story" as const }));
    fc.assert(
      fc.property(fc.array(event, { maxLength: 40 }), fc.nat(40), (events, cut) => {
        const rows: ConsoleRow[] = [];
        const stories: StoryModel[] = [];
        const snapshots: string[][] = [];
        let seq = 0;
        for (const item of events) {
          seq += 1;
          if (item.kind === "row") rows.push(message(seq));
          else stories.push(story(seq, seq - 1));
          snapshots.push(mergeSummaryRows(state([...rows]), [...stories]).rows.map((row) => row.key));
        }
        const earlier = snapshots[Math.min(cut, snapshots.length - 1)] ?? [];
        const final = snapshots.at(-1) ?? [];
        expect(final.slice(0, earlier.length)).toEqual(earlier);
      }),
    );
  });
});

describe("buildConsoleRows with story rows", () => {
  function session(upTo?: number) {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Add a limiter" });
    b.agent({ type: "agent_message", role: "assistant", text: "Reading the server." });
    b.explainer({ kind: "story", sentences: [sentence("The agent read the server.", { kind: "step", id: "step:2" })], basisSeq: 2 });
    b.agent({ type: "agent_message", role: "assistant", text: "Adding the middleware." });
    b.explainer({ kind: "story", sentences: [sentence("The agent added the middleware.", { kind: "step", id: "step:4" })], basisSeq: 4 });
    const rows = upTo === undefined ? b.rows : b.rows.slice(0, upTo);
    return foldRows(testMeta({ state: "running" }), rows, { live: true });
  }

  it("merges one summary row per story refresh where its row arrived, and an incremental build equals a fresh one", () => {
    const full = session();
    const fresh = buildConsoleRows(full, buildTraceIndex(full));
    expect(fresh.rows.map((row) => row.kind)).toEqual(["instruction", "message", "summary", "message", "summary"]);
    expect(fresh.byStep.get("step:4")).toBe(3);

    const early = session(3);
    const prev = buildConsoleRows(early, buildTraceIndex(early));
    const index = buildTraceIndex(full);
    const next = buildConsoleRows(full, index, prev);
    expect(next.rows).toEqual(fresh.rows);
    expect([...next.byStep]).toEqual([...fresh.byStep]);
    expect(buildConsoleRows(full, index, next)).toBe(next);
  });

  it("counts a summary row in the Console's \"N new\" rows once its story row is past the reader's mark", () => {
    const full = session();
    const index = buildTraceIndex(full);
    const state = buildConsoleRows(full, index);
    // Rows: instruction 1, message 2, summary 3, message 4, summary 5. After seq 2 the last three are new.
    expect(consoleNewRowCount(state, index, 2)).toBe(3);
    expect(consoleNewRowCount(state, index, 4)).toBe(1);
    expect(consoleNewRowCount(state, index, 5)).toBe(0);
  });
});
