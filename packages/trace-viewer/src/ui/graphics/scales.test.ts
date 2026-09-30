import { describe, expect, it } from "vitest";

import { compactCount, diffSidePx, durationPx, graphicA11y, testDotsMode } from "./scales.js";

describe("graphic scales (R24, spec §7.12)", () => {
  it("DiffBar sides follow 8·log2(1+lines), 0 for none, capped at 56", () => {
    expect(diffSidePx(0)).toBe(0);
    expect(diffSidePx(1)).toBe(8);
    expect(diffSidePx(127)).toBe(56);
    expect(diffSidePx(10_000)).toBe(56);
    expect(diffSidePx(-3)).toBe(0);
  });

  it("counts are exact below 1,000 and compact above", () => {
    expect(compactCount(999)).toBe("999");
    expect(compactCount(1_234)).toBe("1.2k");
    expect(compactCount(1_000)).toBe("1.0k");
    expect(compactCount(2_500_000)).toBe("2.5M");
  });

  it("TestDots draws dots up to 15 tests, then a bar", () => {
    expect(testDotsMode(15)).toBe("dots");
    expect(testDotsMode(16)).toBe("bar");
  });

  it("DurationBar is 20+40·log10(s) on an absolute scale, clamped to [4, 120]", () => {
    expect(durationPx(1_000)).toBe(20);
    expect(durationPx(10_000)).toBe(60);
    expect(durationPx(100_000)).toBe(100);
    expect(durationPx(100)).toBe(4);
    expect(durationPx(0)).toBe(4);
    expect(durationPx(10_000_000)).toBe(120);
  });

  it("a graphic without a label is hidden from assistive tech", () => {
    expect(graphicA11y()).toEqual({ "aria-hidden": true });
    expect(graphicA11y("14 passed, 1 failed")).toEqual({ role: "img", "aria-label": "14 passed, 1 failed" });
  });
});
