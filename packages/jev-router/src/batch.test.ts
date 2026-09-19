import { describe, expect, it } from "vitest";

import {
  MAX_ATTENTION_BATCH,
  MAX_PASS_B_IN_FLIGHT,
  alignResults,
  chunkAttentionBatch,
  discardStale,
  selectPassBTasks,
} from "./batch.js";

describe("chunkAttentionBatch", () => {
  it("chunks to at most 8 per batch", () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const chunks = chunkAttentionBatch(items);
    expect(chunks).toEqual([
      [0, 1, 2, 3, 4, 5, 6, 7],
      [8, 9, 10, 11, 12, 13, 14, 15],
      [16, 17, 18, 19],
    ]);
    expect(chunks.every((c) => c.length <= MAX_ATTENTION_BATCH)).toBe(true);
  });

  it("handles empty and exact-multiple inputs", () => {
    expect(chunkAttentionBatch([])).toEqual([]);
    expect(chunkAttentionBatch([1, 2, 3, 4, 5, 6, 7, 8])).toHaveLength(1);
    expect(chunkAttentionBatch([1, 2, 3, 4, 5, 6, 7, 8, 9])).toHaveLength(2);
  });

  it("rejects non-positive maxima", () => {
    expect(chunkAttentionBatch([1, 2], 0)).toEqual([]);
  });
});

describe("selectPassBTasks", () => {
  const queue = [1, 2, 3, 4, 5, 6].map((n) => ({
    changeUnitId: `cu-${n}`,
    decisionVersion: n,
  }));

  it("fills up to 4 in-flight slots", () => {
    const selected = selectPassBTasks(queue, 1);
    expect(selected.map((t) => t.changeUnitId)).toEqual([
      "cu-1",
      "cu-2",
      "cu-3",
    ]);
  });

  it("starts nothing when the concurrency window is full", () => {
    expect(selectPassBTasks(queue, MAX_PASS_B_IN_FLIGHT)).toEqual([]);
    expect(selectPassBTasks(queue, 10)).toEqual([]);
  });

  it("starts all tasks when capacity exceeds the queue", () => {
    expect(selectPassBTasks(queue.slice(0, 2), 0)).toHaveLength(2);
  });

  it("treats negative in-flight as zero", () => {
    expect(selectPassBTasks(queue, -3)).toHaveLength(MAX_PASS_B_IN_FLIGHT);
  });
});

describe("alignResults and discardStale", () => {
  const inputs = [
    { changeUnitId: "cu-1", decisionVersion: 1 },
    { changeUnitId: "cu-2", decisionVersion: 2 },
    { changeUnitId: "cu-3", decisionVersion: 3 },
  ];
  const results = ["r1", "r2", "r3"];

  it("aligns results to inputs by index", () => {
    const aligned = alignResults(inputs, results);
    expect(aligned).toEqual([
      { changeUnitId: "cu-1", decisionVersion: 1, result: "r1" },
      { changeUnitId: "cu-2", decisionVersion: 2, result: "r2" },
      { changeUnitId: "cu-3", decisionVersion: 3, result: "r3" },
    ]);
  });

  it("drops results older than the current decision version", () => {
    const aligned = alignResults(inputs, results);
    const current = new Map([
      ["cu-1", 1],
      ["cu-2", 3],
      ["cu-3", 2],
    ]);
    const fresh = discardStale(aligned, current);
    expect(fresh.map((r) => r.changeUnitId)).toEqual(["cu-1", "cu-3"]);
  });

  it("keeps results for units with no current version", () => {
    const aligned = alignResults(inputs, results);
    expect(discardStale(aligned, new Map())).toHaveLength(3);
  });
});
