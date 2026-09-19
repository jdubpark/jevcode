import type {
  AttentionDecision,
  JevResult,
  SemanticEventKind,
  UIIntent,
} from "@jevcode/contracts";

import { clampAttention, clampProjection, preClampAttention } from "./guardrails.js";
import { isTestOnly } from "./patterns.js";
import { renderPolicy } from "./policy.js";
import { subjectFromCategory } from "./state.js";
import type { AttentionInput, JevClient, JevHealth, ProjectionInput } from "./types.js";

export const DEGRADE_CONFIDENCE = 0.6;

export const REPRESENTATION_BY_CATEGORY: Record<
  SemanticEventKind,
  { representation: UIIntent["representation"]; view: string }
> = {
  schema_change: { representation: "table", view: "SchemaDelta" },
  architecture_change: { representation: "diagram", view: "ArchitectureDelta" },
  failure: { representation: "failure", view: "FailureAnalysis" },
  decision_candidate: { representation: "decision", view: "Decision" },
  implementation_change: { representation: "summary", view: "ChangeOverview" },
  dependency_change: { representation: "graph", view: "DependencyDelta" },
  test_result: { representation: "table", view: "TestMatrix" },
  behavior_change: { representation: "before_after", view: "BehaviorDelta" },
  api_change: { representation: "diff", view: "CodeDiff" },
  security_change: { representation: "summary", view: "ChangeOverview" },
};

export function degradeCategory(input: AttentionInput): SemanticEventKind {
  const h = input.hints;
  if (h.destructiveCommands.length > 0) return "decision_candidate";
  if (h.decisionIds.length > 0) return "decision_candidate";
  const failingResults = h.testResults.filter((t) => t.failed > 0);
  const failingInUnit = failingResults.some((result) =>
    result.failureFiles.some((file) => input.files.includes(file)),
  );
  if (isTestOnly(input.files) && failingInUnit) return "failure";
  if (h.securityPaths.length > 0) return "security_change";
  if (h.schemaPaths.length > 0) return "schema_change";
  if (h.behaviorChange) return "behavior_change";
  switch (input.categoryHint) {
    case "behavior":
      return "behavior_change";
    case "architecture":
      return "architecture_change";
    case "api":
      return "api_change";
    case "schema":
      return "schema_change";
    case "dependency":
      return "dependency_change";
    case "security":
      return "security_change";
    case "tests":
      return "test_result";
    default:
      break;
  }
  if (h.dependencyChanges.length > 0) return "dependency_change";
  if (h.interfacesChanged > 0) return "api_change";
  if (h.publicExports.length > 0) return "api_change";
  if (failingResults.length > 0) return "failure";
  if (h.testResults.length > 0) return "test_result";
  return "implementation_change";
}

function diffSizeTier(input: AttentionInput): number {
  const size = input.hints.diffStats.added + input.hints.diffStats.removed;
  if (size >= 500) return 0.5;
  if (size >= 100) return 0.4;
  if (size >= 10) return 0.3;
  if (size > 0) return 0.2;
  return 0.1;
}

export function degradeImportance(input: AttentionInput): number {
  const h = input.hints;
  const suppressed = preClampAttention(input);
  if (suppressed.forced.shouldSurface === false) return 0.05;
  if (h.destructiveCommands.length > 0) return 0.99;
  if (h.decisionIds.length > 0) return 0.9;
  if (h.securityPaths.length > 0) return 0.9;
  if (h.schemaPaths.length > 0) return 0.9;
  const failingInUnit = h.testResults.some(
    (t) => t.failed > 0 && t.failureFiles.some((file) => input.files.includes(file)),
  );
  if (failingInUnit) return 0.6;
  if (h.behaviorChange) return 0.8;
  if (input.categoryHint === "architecture") return 0.7;
  if (h.testResults.length > 0) return 0.5;
  if (h.interfacesChanged > 0 || h.publicExports.length > 0) return 0.7;
  if (h.dependencyChanges.length > 0) return 0.7;
  const tier = diffSizeTier(input);
  return tier;
}

export function degradeRelevance(input: AttentionInput): number {
  const h = input.hints;
  const suppressed = preClampAttention(input);
  if (suppressed.forced.shouldSurface === false) return 0.02;
  if (h.destructiveCommands.length > 0) return 0.99;
  const failingInUnit = h.testResults.some(
    (t) => t.failed > 0 && t.failureFiles.some((file) => input.files.includes(file)),
  );
  if (failingInUnit) return 0.9;
  if (h.decisionIds.length > 0) return 0.9;
  if (h.securityPaths.length > 0) return 0.9;
  if (h.schemaPaths.length > 0) return 0.85;
  if (input.categoryHint === "architecture") return 0.8;
  if (h.testResults.length > 0) return 0.7;
  if (h.dependencyChanges.length > 0) return 0.75;
  if (h.interfacesChanged > 0 || h.publicExports.length > 0) return 0.7;
  return 0.5;
}

export function degradeInterruption(input: AttentionInput): number {
  const h = input.hints;
  const suppressed = preClampAttention(input);
  if (suppressed.forced.shouldSurface === false) return 0.02;
  if (h.destructiveCommands.length > 0) return 0.98;
  if (h.decisionIds.length > 0) return 0.8;
  if (h.behaviorChange) return 0.35;
  if (h.testResults.some((t) => t.failed > 0)) return 0.2;
  return 0.1;
}

export function degradeHumanDecision(
  input: AttentionInput,
): AttentionDecision["humanDecision"] {
  const h = input.hints;
  if (h.destructiveCommands.length > 0) return "required";
  if (h.decisionIds.length > 0) return "recommended";
  if (h.behaviorChange) return "recommended";
  return "none";
}

export function degradeScope(input: AttentionInput): AttentionDecision["scope"] {
  const files = input.files.length;
  if (files >= 10) return "repository";
  if (files >= 4) return "subsystem";
  if (files >= 2) return "module";
  return "local";
}

export function degradeNeedsSystem2(input: AttentionInput): boolean {
  const h = input.hints;
  return (
    h.decisionIds.length > 0 ||
    h.securityPaths.length > 0 ||
    h.schemaPaths.length > 0
  );
}

const MENTAL_MODEL_CHANGE_BY_CATEGORY: Partial<Record<SemanticEventKind, number>> = {
  decision_candidate: 0.55,
  failure: 0.2,
  test_result: 0.15,
  architecture_change: 0.7,
  schema_change: 0.7,
  behavior_change: 0.75,
  dependency_change: 0.45,
  security_change: 0.7,
};

export function degradeMentalModelChange(
  input: AttentionInput,
  category: SemanticEventKind,
  importance: number,
): number {
  const suppressed = preClampAttention(input);
  if (suppressed.forced.shouldSurface === false) return 0.02;
  return MENTAL_MODEL_CHANGE_BY_CATEGORY[category] ?? importance * 0.75;
}

export function degradeProbabilities(category: SemanticEventKind): Record<string, number> {
  const other: SemanticEventKind =
    category === "implementation_change" ? "dependency_change" : "implementation_change";
  return { [category]: 0.6, [other]: 0.4 };
}

export function degradeAttention(input: AttentionInput): JevResult<AttentionDecision> {
  const category = degradeCategory(input);
  const importance = degradeImportance(input);
  const model: AttentionDecision = {
    shouldSurface: true,
    importance,
    relevance: degradeRelevance(input),
    interruption: degradeInterruption(input),
    mentalModelChange: degradeMentalModelChange(input, category, importance),
    semanticCategory: category,
    scope: degradeScope(input),
    humanDecision: degradeHumanDecision(input),
    needsSystem2: degradeNeedsSystem2(input),
    confidence: DEGRADE_CONFIDENCE,
    probabilities: degradeProbabilities(category),
  };
  const clamped = clampAttention(input, model);
  const probabilities = degradeProbabilities(clamped.value.semanticCategory);
  return {
    value: { ...clamped.value, probabilities },
    confidence: DEGRADE_CONFIDENCE,
    probabilities,
    clientKind: "degrade",
    heuristic: true,
  };
}

export function degradeProjection(input: ProjectionInput): JevResult<UIIntent> {
  const category = input.attention.semanticCategory;
  const mapping = REPRESENTATION_BY_CATEGORY[category];
  const secondaryViews = [mapping.view];
  if (category === "security_change" && !secondaryViews.includes("CodeDiff")) {
    secondaryViews.push("CodeDiff");
  }
  const attention = degradeAttentionLevel(input);
  const model: UIIntent = {
    attention,
    subject: subjectFromCategory(category),
    representation: mapping.representation,
    density: "normal",
    confidence: DEGRADE_CONFIDENCE,
    showEvidence: true,
    showCode: false,
    secondaryViews,
    renderMode: "generic",
  };
  const clamped = clampProjection(input, model);
  const result: JevResult<UIIntent> = {
    value: clamped.value,
    confidence: DEGRADE_CONFIDENCE,
    clientKind: "degrade",
    heuristic: true,
  };
  return renderPolicy(result);
}

export function degradeAttentionLevel(
  input: ProjectionInput,
): UIIntent["attention"] {
  const a = input.attention;
  if (a.humanDecision === "required") return "interrupt";
  if (a.interruption >= 0.5) return "highlight";
  if (a.shouldSurface) return "surface";
  return "background";
}

export class DegradeClient implements JevClient {
  async attention(batch: AttentionInput[]): Promise<JevResult<AttentionDecision>[]> {
    if (batch.length === 0) return [];
    return batch.map((input) => degradeAttention(input));
  }

  async project(input: ProjectionInput): Promise<JevResult<UIIntent>> {
    return degradeProjection(input);
  }

  async health(): Promise<JevHealth> {
    return "degraded";
  }
}
