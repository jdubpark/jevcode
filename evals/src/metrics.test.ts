import { describe, expect, it } from "vitest";

import { binaryScores, mae, setAccuracy, SPEC16_TARGETS } from "./metrics.js";

describe("binaryScores", () => {
  it("scores a perfect prediction", () => {
    const result = binaryScores([true, false], [true, false]);
    expect(result).toEqual({
      tp: 1,
      fp: 0,
      fn: 0,
      tn: 1,
      precision: 1,
      recall: 1,
    });
  });

  it("scores false positives and false negatives", () => {
    const result = binaryScores([true, true, false], [true, false, true]);
    expect(result.tp).toBe(1);
    expect(result.fp).toBe(1);
    expect(result.fn).toBe(1);
    expect(result.tn).toBe(0);
    expect(result.precision).toBeCloseTo(0.5);
    expect(result.recall).toBeCloseTo(0.5);
  });

  it("returns null precision when nothing is predicted positive", () => {
    const result = binaryScores([false, false], [true, false]);
    expect(result.precision).toBeNull();
    expect(result.recall).toBe(0);
  });

  it("returns null recall when nothing is labeled positive", () => {
    const result = binaryScores([true, false], [false, false]);
    expect(result.precision).toBe(0);
    expect(result.recall).toBeNull();
  });

  it("rejects mismatched lengths", () => {
    expect(() => binaryScores([true], [true, false])).toThrow(/same length/);
  });

  it("scores the SPEC 16 should_surface targets as achievable", () => {
    const result = binaryScores([true, true, true, false], [true, true, true, false]);
    expect(result.precision).toBeGreaterThanOrEqual(SPEC16_TARGETS.shouldSurfacePrecision);
    expect(result.recall).toBeGreaterThanOrEqual(SPEC16_TARGETS.shouldSurfaceRecall);
  });
});

describe("mae", () => {
  it("computes the mean absolute error", () => {
    expect(mae([0.9, 0.5], [0.8, 0.6])).toBeCloseTo(0.1);
  });

  it("is zero for identical arrays", () => {
    expect(mae([0.7, 0.3, 0.1], [0.7, 0.3, 0.1])).toBe(0);
  });

  it("handles empty arrays", () => {
    expect(mae([], [])).toBe(0);
  });

  it("rejects mismatched lengths", () => {
    expect(() => mae([1], [1, 2])).toThrow(/same length/);
  });
});

describe("setAccuracy", () => {
  it("counts exact and alternative hits", () => {
    const result = setAccuracy([
      { predicted: "diagram", acceptable: ["diagram"] },
      { predicted: "summary", acceptable: ["diagram", "summary"] },
      { predicted: "diff", acceptable: ["before_after"] },
    ]);
    expect(result).toEqual({ hits: 2, total: 3, accuracy: 2 / 3 });
  });

  it("returns null accuracy with no cases", () => {
    expect(setAccuracy([])).toEqual({ hits: 0, total: 0, accuracy: null });
  });

  it("treats a null-safe default as passing when there are no cases", () => {
    const result = setAccuracy([]);
    const pass = (result.accuracy ?? 1) >= SPEC16_TARGETS.representationSetAccuracy;
    expect(pass).toBe(true);
  });
});
