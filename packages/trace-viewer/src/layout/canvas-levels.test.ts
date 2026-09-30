import { describe, expect, it } from "vitest";

import { LEVELS } from "../model/index.js";
import type { Step } from "../model/index.js";
import { LEVEL_SPECS, frameSize, stepFinder } from "./canvas-levels.js";

// Expected values: spec §7.5 level table and its band formulas.

describe("LEVEL_SPECS", () => {
  it("derives the Chapter bands from the spec table", () => {
    expect(LEVEL_SPECS.chapter).toMatchObject({
      w: 224, labelH: 22, storyCap: 1, rMax: 4, colGap: 40, turnGap: 72, breakGap: 64, rowGap: 16,
      channelH: 32, channelLanes: 4, railLanes: 3, pps: 8, slack: 64, breakMinMs: 60_000,
      minZoom: 0.2, maxZoom: 2, pitch: 264, storyBand: 118, workTop: 150,
    });
  });

  it("derives the Session and Step bands", () => {
    expect(LEVEL_SPECS.session).toMatchObject({
      w: 168, labelH: 0, storyCap: 3, rMax: 12, channelLanes: 2, railLanes: 1, pps: 0.5,
      breakMinMs: 300_000, minZoom: 0.25, pitch: 192, storyBand: 100, workTop: 116,
    });
    expect(LEVEL_SPECS.step).toMatchObject({ w: 320, rMax: 3, pitch: 368, storyBand: 118, workTop: 150 });
  });

  it("names each spec after its level", () => {
    for (const level of LEVELS) expect(LEVEL_SPECS[level].level).toBe(level);
  });
});

describe("frameSize", () => {
  it("depends only on level and kind", () => {
    expect(frameSize("chapter", "intent")).toEqual({ w: 224, h: 118 });
    expect(frameSize("chapter", "decision")).toEqual({ w: 224, h: 118 });
    expect(frameSize("chapter", "chapter")).toEqual({ w: 224, h: 134 });
    expect(frameSize("chapter", "noise")).toEqual({ w: 224, h: 58 });
    expect(frameSize("chapter", "loose")).toEqual({ w: 224, h: 66 });
    expect(frameSize("step", "chapter")).toEqual({ w: 320, h: 294 });
    expect(frameSize("session", "claim")).toEqual({ w: 168, h: 28 });
  });
});

describe("stepFinder", () => {
  const at = (firstSeq: number): Step => ({ id: `step:${firstSeq}`, firstSeq }) as Step;

  it("finds steps by firstSeq even when the list is out of order, and leaves the input alone", () => {
    const steps = [at(7), at(2), at(5)];
    const find = stepFinder(steps);
    expect(find("step:5")?.firstSeq).toBe(5);
    expect(find("step:2")?.firstSeq).toBe(2);
    expect(steps.map((step) => step.firstSeq)).toEqual([7, 2, 5]);
  });

  it("returns undefined for a non-step id or a missing seq", () => {
    const find = stepFinder([at(1), at(4)]);
    expect(find("unit:c1")).toBeUndefined();
    expect(find("step:3")).toBeUndefined();
    expect(find("step:x")).toBeUndefined();
  });
});
