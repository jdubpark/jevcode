import { afterEach, describe, expect, it, vi } from "vitest";

import { measureFromFirstAfterPaint, PERF } from "./perf.js";

afterEach(() => {
  vi.unstubAllGlobals();
  performance.clearMarks();
  performance.clearMeasures();
});

describe("measureFromFirstAfterPaint (spec §11 Console append)", () => {
  it("measures from the oldest pending start mark to the paint, and clears every start mark", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    performance.mark("tv:test-start", { startTime: 10 });
    performance.mark("tv:test-start", { startTime: 40 });
    measureFromFirstAfterPaint("tv:test-append", "tv:test-start");
    expect(performance.getEntriesByName("tv:test-start", "mark")).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [entry] = performance.getEntriesByName("tv:test-append", "measure");
    expect(entry?.startTime).toBe(10);
    expect(PERF.consoleAppend).toBe("tv:console-append");
  });

  it("does nothing without a pending start mark", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    measureFromFirstAfterPaint("tv:test-append", "tv:test-start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(performance.getEntriesByName("tv:test-append", "measure")).toHaveLength(0);
  });
});
