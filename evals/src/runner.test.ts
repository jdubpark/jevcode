import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { reportToTable } from "./report.js";
import {
  representationVerdict,
  runEval,
  shouldSurfaceVerdict,
} from "./runner.js";

const fixturesDir = fileURLToPath(new URL("../../fixtures", import.meta.url));

describe("runEval (playback client)", () => {
  it("proves the wiring passes every target with a perfect model", async () => {
    const report = await runEval({ client: "playback", fixturesDir });
    expect(report.metrics.shouldSurface.precision).toBe(1);
    expect(report.metrics.shouldSurface.recall).toBe(1);
    expect(report.metrics.scores.overallMae).toBe(0);
    expect(report.metrics.representation.accuracy).toBe(1);
    expect(report.guardrailChecks.every((entry) => entry.passed)).toBe(true);
    expect(report.allTargetsPass).toBe(true);
    expect(report.scenarios.length).toBe(5);
  });

  it("never projects suppressed units", async () => {
    const report = await runEval({ client: "playback", fixturesDir });
    const depChange = report.scenarios.find(
      (scenario) => scenario.name === "dep-change",
    );
    expect(depChange).toBeDefined();
    const noise = depChange?.units.find(
      (unit) => unit.slug === "dep-format-noise",
    );
    expect(noise?.shouldSurfacePredicted).toBe(false);
    expect(
      depChange?.projections.some((entry) => entry.slug === "dep-format-noise"),
    ).toBe(false);
  });
});

describe("runEval (degrade client)", () => {
  it("hits the deterministic should_surface targets and all guardrail checks", async () => {
    const report = await runEval({ client: "degrade", fixturesDir });
    expect(report.guardrailChecks.every((entry) => entry.passed)).toBe(true);
    expect(report.metrics.shouldSurface.pass).toBe(true);
    expect(report.metrics.shouldSurface.precision).toBeGreaterThanOrEqual(0.9);
    expect(report.metrics.shouldSurface.recall).toBeGreaterThanOrEqual(0.85);
  });

  it("reports per-unit comparisons for every labeled unit", async () => {
    const report = await runEval({ client: "degrade", fixturesDir });
    const unitCount = report.scenarios.reduce(
      (sum, scenario) => sum + scenario.units.length,
      0,
    );
    expect(unitCount).toBe(20);
    const noise = report.scenarios
      .find((scenario) => scenario.name === "dep-change")
      ?.units.find((unit) => unit.slug === "dep-format-noise");
    expect(noise?.shouldSurfacePredicted).toBe(false);
    expect(noise?.shouldSurfaceLabel).toBe(false);
  });

  it("emits a parseable human table and JSON report", async () => {
    const report = await runEval({ client: "degrade", fixturesDir });
    const table = reportToTable(report);
    expect(table).toContain("Targets:");
    expect(table).toContain("Guardrail checks:");
    const json = JSON.parse(JSON.stringify(report)) as {
      allTargetsPass: boolean;
      scenarios: unknown[];
    };
    expect(typeof json.allTargetsPass).toBe("boolean");
    expect(json.scenarios.length).toBe(5);
  });

  it("includes degenerate diagnostics in the table output", async () => {
    const report = await runEval({ client: "degrade", fixturesDir });
    expect(report.diagnostics).toEqual([]);
    expect(reportToTable(report)).not.toContain("Diagnostics:");
  });
});

describe("degenerate verdicts", () => {
  it("fails with a diagnostic when nothing is predicted positive", () => {
    const verdict = shouldSurfaceVerdict(
      { tp: 0, fp: 0, fn: 3, tn: 0, precision: null, recall: 0 },
      0.9,
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.diagnostics).toEqual([
      expect.stringContaining("degenerate: all suppressed/never surfaced"),
    ]);
  });

  it("fails with a diagnostic when nothing is labeled positive", () => {
    const verdict = shouldSurfaceVerdict(
      { tp: 0, fp: 3, fn: 0, tn: 0, precision: 0, recall: null },
      0.9,
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.diagnostics).toEqual([
      expect.stringContaining("degenerate: all suppressed/never surfaced"),
    ]);
  });

  it("passes only when both precision and recall are defined and on target", () => {
    expect(
      shouldSurfaceVerdict(
        { tp: 10, fp: 1, fn: 1, tn: 2, precision: 0.91, recall: 0.91 },
        0.9,
      ).pass,
    ).toBe(true);
    expect(
      shouldSurfaceVerdict(
        { tp: 1, fp: 1, fn: 1, tn: 2, precision: 0.5, recall: 0.5 },
        0.9,
      ).pass,
    ).toBe(false);
  });

  it("fails representation accuracy with no projection cases", () => {
    const verdict = representationVerdict(null, 0.75);
    expect(verdict.pass).toBe(false);
    expect(verdict.diagnostics).toEqual([
      "degenerate: no projection cases (set accuracy undefined)",
    ]);
    expect(representationVerdict(0.8, 0.75)).toEqual({
      pass: true,
      diagnostics: [],
    });
  });
});
