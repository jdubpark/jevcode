import { describe, expect, it } from "vitest";

import { comfortBand, extendRange, pushTarget, revealAlign, spineVirtualOptions, type PushCandidate } from "./scroll-sync.js";

const win = { offset: 1_000, height: 600 };

function rows(from: number, to: number, nonTargets: readonly number[] = []): PushCandidate[] {
  const out: PushCandidate[] = [];
  for (let index = from; index <= to; index += 1) {
    const start = 1_000 + (index - from) * 32;
    out.push({ index, start, end: start + 32, target: !nonTargets.includes(index) });
  }
  return out;
}

describe("scroll-sync", () => {
  it("insets the comfort band by 32 px", () => {
    expect(comfortBand(win)).toEqual({ start: 1_032, end: 1_568 });
  });

  it("leaves a row inside the band, scrolls the minimum just outside, centers a far row", () => {
    expect(revealAlign({ start: 1_100, end: 1_132 }, win)).toBe("none");
    expect(revealAlign({ start: 1_590, end: 1_622 }, win)).toBe("auto");
    expect(revealAlign({ start: 1_010, end: 1_042 }, win)).toBe("auto");
    expect(revealAlign({ start: 2_700, end: 2_732 }, win)).toBe("center");
    expect(revealAlign({ start: 100, end: 132 }, win)).toBe("center");
  });

  it("moves the playhead the minimum distance into the comfort band", () => {
    const candidates = rows(10, 28);
    expect(pushTarget({ start: 900, end: 932 }, candidates, win)).toBe(11);
    expect(pushTarget({ start: 1_700, end: 1_732 }, candidates, win)).toBe(26);
    expect(pushTarget({ start: 1_200, end: 1_232 }, candidates, win)).toBeNull();
    expect(pushTarget(null, candidates, win)).toBeNull();
  });

  it("skips separator rows when pushing", () => {
    expect(pushTarget({ start: 900, end: 932 }, rows(10, 28, [11, 12]), win)).toBe(13);
  });

  it("anchors to the end and follows appends only while following", () => {
    expect(spineVirtualOptions(true)).toEqual({ anchorTo: "end", followOnAppend: "auto", scrollEndThreshold: 24, overscan: 10 });
    expect(spineVirtualOptions(false)).toEqual({ anchorTo: "end", followOnAppend: false, scrollEndThreshold: 24, overscan: 10 });
  });

  it("keeps the playhead and focused rows mounted", () => {
    expect(extendRange([3, 4, 5], [9, -1, 4, 40], 20)).toEqual([3, 4, 5, 9]);
  });
});
