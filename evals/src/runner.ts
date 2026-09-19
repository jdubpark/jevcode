import { readdirSync } from "node:fs";
import path from "node:path";

import type {
  AttentionDecision,
  SemanticEventKind,
  UIIntent,
} from "@jevcode/contracts";
import {
  DegradeClient,
  createJevClient,
  type AttentionInput,
  type JevClient,
} from "@jevcode/jev-router";

import { acceptableRepresentations, loadAlternatives } from "./alternatives.js";
import { runGuardrailChecks, type GuardrailCheck } from "./guardrail-checks.js";
import {
  binaryScores,
  mae,
  setAccuracy,
  SPEC16_TARGETS,
  type BinaryScoreResult,
  type EvalTargets,
} from "./metrics.js";
import { PlaybackClient } from "./playback.js";
import {
  SCENARIOS,
  buildAttentionInputs,
  loadScenario,
  type ScenarioName,
} from "./scenario.js";

export type EvalClientKind = "degrade" | "playback" | "typesafe";

export interface RunOptions {
  client: EvalClientKind;
  fixturesDir: string;
  scenarios?: readonly ScenarioName[];
}

export interface ScoreErrors {
  importance: number;
  relevance: number;
  interruption: number;
  mentalModelChange: number;
}

// Null precision/recall means the run is degenerate (nothing predicted or
// nothing labeled positive). It must fail loudly, not pass via a null-safe
// default.
export function shouldSurfaceVerdict(
  scores: BinaryScoreResult,
  target: number,
): { pass: boolean; diagnostics: string[] } {
  const diagnostics: string[] = [];
  if (scores.precision === null) {
    diagnostics.push(
      "degenerate: all suppressed/never surfaced (precision undefined: no positive predictions)",
    );
  }
  if (scores.recall === null) {
    diagnostics.push(
      "degenerate: all suppressed/never surfaced (recall undefined: no positive labels)",
    );
  }
  const pass =
    scores.precision !== null &&
    scores.recall !== null &&
    scores.precision >= target &&
    scores.recall >= target;
  return { pass, diagnostics };
}

export function representationVerdict(
  accuracy: number | null,
  target: number,
): { pass: boolean; diagnostics: string[] } {
  if (accuracy === null) {
    return {
      pass: false,
      diagnostics: ["degenerate: no projection cases (set accuracy undefined)"],
    };
  }
  return { pass: accuracy >= target, diagnostics: [] };
}

export interface UnitAttentionResult {
  slug: string;
  shouldSurfaceLabel: boolean;
  shouldSurfacePredicted: boolean;
  scoreErrors: ScoreErrors;
  categoryLabel: SemanticEventKind;
  categoryPredicted: SemanticEventKind;
  label: AttentionDecision;
  predicted: AttentionDecision;
}

export interface UnitProjectionResult {
  slug: string;
  labelRepresentation: UIIntent["representation"];
  predictedRepresentation: UIIntent["representation"] | null;
  acceptable: string[];
  hit: boolean;
}

export interface ScenarioResult {
  name: ScenarioName;
  units: UnitAttentionResult[];
  projections: UnitProjectionResult[];
}

export interface ScoreMetrics {
  importanceMae: number;
  relevanceMae: number;
  interruptionMae: number;
  mentalModelChangeMae: number;
  overallMae: number;
  target: number;
  pass: boolean;
}

export interface RepresentationMetrics {
  accuracy: number | null;
  hits: number;
  total: number;
  target: number;
  pass: boolean;
}

export interface EvalReport {
  generatedAt: string;
  client: EvalClientKind;
  fixturesDir: string;
  targets: EvalTargets;
  metrics: {
    shouldSurface: BinaryScoreResult & { target: number; pass: boolean };
    scores: ScoreMetrics;
    representation: RepresentationMetrics;
    categoryAccuracy: { hits: number; total: number };
  };
  allTargetsPass: boolean;
  scenarios: ScenarioResult[];
  guardrailChecks: GuardrailCheck[];
  diagnostics: string[];
}

function createClient(
  kind: EvalClientKind,
  attentionLabels: Record<string, AttentionDecision>,
  projectionLabels: Record<string, UIIntent>,
): JevClient {
  if (kind === "playback") {
    return new PlaybackClient({
      attention: attentionLabels,
      projection: projectionLabels,
    });
  }
  if (kind === "typesafe") {
    return createJevClient();
  }
  return new DegradeClient();
}

function scoreErrors(
  predicted: AttentionDecision,
  label: AttentionDecision,
): ScoreErrors {
  return {
    importance: predicted.importance - label.importance,
    relevance: predicted.relevance - label.relevance,
    interruption: predicted.interruption - label.interruption,
    mentalModelChange: predicted.mentalModelChange - label.mentalModelChange,
  };
}

export async function runEval(options: RunOptions): Promise<EvalReport> {
  const scenarioNames = options.scenarios ?? SCENARIOS;
  const alternatives = loadAlternatives();
  const inputsByScenario = new Map<string, readonly AttentionInput[]>();
  const scenarioResults: ScenarioResult[] = [];

  for (const name of scenarioNames) {
    const data = loadScenario(path.join(options.fixturesDir, name), name);
    const inputs = buildAttentionInputs(data);
    inputsByScenario.set(name, inputs);
    const client = createClient(
      options.client,
      data.attentionLabels,
      data.projectionLabels,
    );
    const attentionResults = await client.attention(inputs);

    const units: UnitAttentionResult[] = [];
    const projections: UnitProjectionResult[] = [];
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index];
      const result = attentionResults[index];
      if (input === undefined || result === undefined) {
        throw new Error(`missing result for input at index ${index}`);
      }
      const label = data.attentionLabels[input.changeUnitId];
      if (label === undefined) {
        throw new Error(`missing label for unit "${input.changeUnitId}"`);
      }
      const predicted = result.value;
      units.push({
        slug: input.changeUnitId,
        shouldSurfaceLabel: label.shouldSurface,
        shouldSurfacePredicted: predicted.shouldSurface,
        scoreErrors: scoreErrors(predicted, label),
        categoryLabel: label.semanticCategory,
        categoryPredicted: predicted.semanticCategory,
        label,
        predicted,
      });

      const projectionLabel = data.projectionLabels[input.changeUnitId];
      if (projectionLabel === undefined) continue;
      let predictedRepresentation: UIIntent["representation"] | null = null;
      if (predicted.shouldSurface) {
        const projection = await client.project({
          ...input,
          attention: predicted,
        });
        predictedRepresentation = projection.value.representation;
      }
      const acceptable = acceptableRepresentations(
        alternatives,
        label.semanticCategory,
        projectionLabel.representation,
      );
      projections.push({
        slug: input.changeUnitId,
        labelRepresentation: projectionLabel.representation,
        predictedRepresentation,
        acceptable: [...acceptable],
        hit:
          predictedRepresentation !== null &&
          acceptable.has(predictedRepresentation),
      });
    }
    scenarioResults.push({ name, units, projections });
  }

  const allUnits = scenarioResults.flatMap((scenario) => scenario.units);
  const shouldSurfaceBinary = binaryScores(
    allUnits.map((unit) => unit.shouldSurfacePredicted),
    allUnits.map((unit) => unit.shouldSurfaceLabel),
  );
  const shouldSurface = shouldSurfaceVerdict(
    shouldSurfaceBinary,
    SPEC16_TARGETS.shouldSurfacePrecision,
  );

  const importanceMae = mae(
    allUnits.map((unit) => unit.predicted.importance),
    allUnits.map((unit) => unit.label.importance),
  );
  const relevanceMae = mae(
    allUnits.map((unit) => unit.predicted.relevance),
    allUnits.map((unit) => unit.label.relevance),
  );
  const interruptionMae = mae(
    allUnits.map((unit) => unit.predicted.interruption),
    allUnits.map((unit) => unit.label.interruption),
  );
  const mentalModelChangeMae = mae(
    allUnits.map((unit) => unit.predicted.mentalModelChange),
    allUnits.map((unit) => unit.label.mentalModelChange),
  );
  const overallMae =
    (importanceMae + relevanceMae + interruptionMae + mentalModelChangeMae) /
    4;
  const scoresPass = overallMae <= SPEC16_TARGETS.scoreMae;

  const allProjections = scenarioResults.flatMap(
    (scenario) => scenario.projections,
  );
  const representationScore = setAccuracy(
    allProjections.map((projection) => ({
      predicted: projection.predictedRepresentation ?? "suppressed",
      acceptable: projection.acceptable,
    })),
  );
  const representation = representationVerdict(
    representationScore.accuracy,
    SPEC16_TARGETS.representationSetAccuracy,
  );

  const categoryHits = allUnits.filter(
    (unit) => unit.categoryLabel === unit.categoryPredicted,
  ).length;

  const guardrailChecks = runGuardrailChecks(inputsByScenario);
  const guardrailsPass = guardrailChecks.every((entry) => entry.passed);

  const diagnostics = [...shouldSurface.diagnostics, ...representation.diagnostics];
  const allTargetsPass =
    shouldSurface.pass && scoresPass && representation.pass && guardrailsPass;

  return {
    generatedAt: new Date().toISOString(),
    client: options.client,
    fixturesDir: options.fixturesDir,
    targets: { ...SPEC16_TARGETS },
    metrics: {
      shouldSurface: {
        ...shouldSurfaceBinary,
        target: SPEC16_TARGETS.shouldSurfacePrecision,
        pass: shouldSurface.pass,
      },
      scores: {
        importanceMae,
        relevanceMae,
        interruptionMae,
        mentalModelChangeMae,
        overallMae,
        target: SPEC16_TARGETS.scoreMae,
        pass: scoresPass,
      },
      representation: {
        accuracy: representationScore.accuracy,
        hits: representationScore.hits,
        total: representationScore.total,
        target: SPEC16_TARGETS.representationSetAccuracy,
        pass: representation.pass,
      },
      categoryAccuracy: {
        hits: categoryHits,
        total: allUnits.length,
      },
    },
    allTargetsPass,
    scenarios: scenarioResults,
    guardrailChecks,
    diagnostics,
  };
}

export function listScenarioNames(fixturesDir: string): string[] {
  return readdirSync(fixturesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}
