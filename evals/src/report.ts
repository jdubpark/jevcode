import type { EvalReport, UnitAttentionResult } from "./runner.js";

export function reportToJson(report: EvalReport): string {
  return JSON.stringify(report, null, 2);
}

function pad(value: string, width: number): string {
  return value.padEnd(width);
}

function pct(value: number | null): string {
  if (value === null) return "-";
  return value.toFixed(3);
}

function signed(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(3)}`;
}

function unitRow(unit: UnitAttentionResult): string {
  return [
    pad(unit.slug, 34),
    `${unit.shouldSurfaceLabel}/${unit.shouldSurfacePredicted}`.padEnd(14),
    signed(unit.scoreErrors.importance).padEnd(9),
    signed(unit.scoreErrors.relevance).padEnd(9),
    signed(unit.scoreErrors.interruption).padEnd(9),
    signed(unit.scoreErrors.mentalModelChange).padEnd(9),
    `${unit.categoryLabel}<-${unit.categoryPredicted}`,
  ].join(" ");
}

export function reportToTable(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`Jevcode evals report  client=${report.client}`);
  lines.push(`generated: ${report.generatedAt}`);
  lines.push(`fixtures: ${report.fixturesDir}`);
  lines.push("");

  const { shouldSurface, scores, representation, categoryAccuracy } =
    report.metrics;
  lines.push("Targets:");
  lines.push(
    `  should_surface precision >= ${report.targets.shouldSurfacePrecision}  |  ${pct(shouldSurface.precision)}  ${shouldSurface.pass ? "PASS" : "FAIL"}`,
  );
  lines.push(
    `  should_surface recall    >= ${report.targets.shouldSurfaceRecall}  |  ${pct(shouldSurface.recall)}  ${shouldSurface.pass ? "PASS" : "FAIL"}`,
  );
  lines.push(
    `  score MAE (overall)      <= ${report.targets.scoreMae}  |  ${scores.overallMae.toFixed(3)}  ${scores.pass ? "PASS" : "FAIL"}`,
  );
  lines.push(
    `  representation set-acc   >= ${report.targets.representationSetAccuracy}  |  ${pct(representation.accuracy)}  ${representation.pass ? "PASS" : "FAIL"}`,
  );
  lines.push("");
  lines.push(
    `should_surface tp=${shouldSurface.tp} fp=${shouldSurface.fp} fn=${shouldSurface.fn} tn=${shouldSurface.tn}`,
  );
  lines.push(
    `score MAE per field: importance=${scores.importanceMae.toFixed(3)} relevance=${scores.relevanceMae.toFixed(3)} interruption=${scores.interruptionMae.toFixed(3)} mental_model_change=${scores.mentalModelChangeMae.toFixed(3)}`,
  );
  lines.push(
    `representation hits=${representation.hits}/${representation.total}`,
  );
  lines.push(
    `category accuracy (informational): ${categoryAccuracy.hits}/${categoryAccuracy.total}`,
  );
  lines.push("");

  lines.push(
    "unit (label/pred, score errors = predicted - label, category = label<-predicted)");
  for (const scenario of report.scenarios) {
    lines.push(`[${scenario.name}]`);
    for (const unit of scenario.units) {
      lines.push(`  ${unitRow(unit)}`);
      const projection = scenario.projections.find(
        (entry) => entry.slug === unit.slug,
      );
      if (projection !== undefined) {
        const predicted = projection.predictedRepresentation ?? "suppressed";
        lines.push(
          `    representation: ${projection.labelRepresentation} <- ${predicted}  ${projection.hit ? "hit" : "MISS"}  (acceptable: ${projection.acceptable.join(", ")})`,
        );
      }
    }
  }

  lines.push("");
  lines.push("Guardrail checks:");
  for (const entry of report.guardrailChecks) {
    lines.push(`  ${entry.passed ? "PASS" : "FAIL"}  ${entry.id}`);
    lines.push(`       ${entry.description}`);
    if (!entry.passed) lines.push(`       detail: ${entry.detail}`);
  }
  if (report.diagnostics.length > 0) {
    lines.push("");
    lines.push("Diagnostics:");
    for (const diagnostic of report.diagnostics) {
      lines.push(`  ${diagnostic}`);
    }
  }
  lines.push("");
  lines.push(`overall: ${report.allTargetsPass ? "PASS" : "FAIL"}`);
  return lines.join("\n");
}
