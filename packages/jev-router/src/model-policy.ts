import type {
  JevResult,
  ModelCatalog,
  ModelSelectionRequest,
  ModelSelectionResult,
} from "@jevcode/contracts";
import {
  DEFAULT_MODEL_CATALOG,
  ModelSelectionRequestSchema,
} from "@jevcode/contracts";

import { normalizeScore, requireAnswer } from "./mapping.js";
import type {
  JevClient,
  ModelComplexityScores,
  ScoreAnswer,
  TypeSafeQuestion,
} from "./types.js";
import { TYPESAFE_CLIENT_KIND } from "./types.js";

export type ContextBucket = "small" | "medium" | "large";

export const PROMPT_CHARS_PER_TOKEN = 4;
export const TOKENS_PER_FILE = 300;
export const CONTEXT_ESTIMATE_CAP_TOKENS = 400_000;
export const SMALL_CONTEXT_MAX_TOKENS = 32_000;
export const LARGE_CONTEXT_MIN_TOKENS = 128_000;

export const MODEL_PROMPT_TRUNCATE_CHARS = 4000;

export const UNKNOWN_BUDGET_DEFAULT = 0.4;
export const ECONOMY_BUDGET_CEILING = 0.2;
export const HIGH_BUDGET_FLOOR = 0.6;
export const PREMIUM_COMPLEXITY_GATE_LOW_BAND = 0.7;
export const PREMIUM_COMPLEXITY_GATE_HIGH_BAND = 0.5;
export const HIGH_EFFORT_COMPLEXITY = 0.6;
export const XHIGH_EFFORT_COMPLEXITY = 0.75;
export const TOPIC_HIGHEST_LEVEL = 1;

export const MODEL_DEGRADE_CONFIDENCE = 0.6;
export const LONG_PROMPT_CHARS = 800;

export const PROMPT_COMPLEXITY_LEVELS = [
  "Trivial one-liner: a simple command, question, or one-line tweak",
  "Direct instruction: one clear task with no significant constraints",
  "Multi-step with constraints: several steps, formats, or behavior constraints",
  "Complex multi-subsystem design: cross-cutting changes spanning subsystems",
] as const;

export const TOPIC_RISK_LEVELS = [
  "Cosmetic, docs, or tests: no production behavior risk",
  "Small feature: additive change with a limited blast radius",
  "Bugfix or refactor: touches existing behavior or structure",
  "Performance or concurrency: timing, throughput, or race-condition sensitive",
  "Auth, security, migrations, or infra: credentials, data integrity, or platform risk",
] as const;

export const WORK_COMPLEXITY_LEVELS = [
  "Single file edit",
  "Small feature across a few files",
  "Large feature across many files",
  "Architecture- or repository-wide change",
] as const;

const HIGH_RISK_KEYWORDS = [
  "auth",
  "token",
  "session",
  "migration",
  "database",
  "schema",
  "security",
] as const;

const REFACTOR_KEYWORDS = ["refactor", "rename"] as const;

const DEBUG_KEYWORDS = ["debug", "fix", "failing"] as const;

export const MODEL_SELECTION_POLICY =
  "You estimate the complexity of a coding-agent session so deterministic code can route it " +
  "to a model tier (economy, standard, premium) and a reasoning effort (low, medium, high, xhigh). " +
  "Score each dimension on the described levels only. Larger expected contexts favor larger " +
  "context models because prompt caching amplifies their benefit.";

const clamp01 = (value: number) =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

export function estimateContextTokens(request: ModelSelectionRequest): number {
  const promptTokens = Math.floor(request.prompt.length / PROMPT_CHARS_PER_TOKEN);
  const repoTokens = request.repoContext.fileCount * TOKENS_PER_FILE;
  return Math.min(CONTEXT_ESTIMATE_CAP_TOKENS, promptTokens + repoTokens);
}

export function contextBucketFor(tokens: number): ContextBucket {
  if (tokens < SMALL_CONTEXT_MAX_TOKENS) return "small";
  if (tokens > LARGE_CONTEXT_MIN_TOKENS) return "large";
  return "medium";
}

export interface ModelSelectionModelState {
  system_policy: string;
  prompt: string;
  repo_context: {
    file_count: number;
    total_bytes: number;
    languages: string[];
  };
}

export function composeModelSelectionRequest(request: ModelSelectionRequest): {
  state: ModelSelectionModelState;
  questions: Record<string, TypeSafeQuestion>;
} {
  return {
    state: {
      system_policy: MODEL_SELECTION_POLICY,
      prompt: request.prompt.slice(0, MODEL_PROMPT_TRUNCATE_CHARS),
      repo_context: {
        file_count: request.repoContext.fileCount,
        total_bytes: request.repoContext.totalBytes,
        languages: request.repoContext.languages,
      },
    },
    questions: {
      prompt_complexity: {
        type: "score",
        instructions: "How complex is the task prompt itself, independent of the repository?",
        criteria: PROMPT_COMPLEXITY_LEVELS,
      },
      topic_risk: {
        type: "score",
        instructions: "How risky or sensitive is the subject matter of this task?",
        criteria: TOPIC_RISK_LEVELS,
      },
      work_complexity: {
        type: "score",
        instructions: "How much repository work will this task likely require?",
        criteria: WORK_COMPLEXITY_LEVELS,
      },
    },
  };
}

export function modelScoresFromAnswers(
  answers: Record<string, unknown>,
): JevResult<ModelComplexityScores> {
  const prompt = requireAnswer<ScoreAnswer>(answers, "prompt_complexity", "score");
  const topic = requireAnswer<ScoreAnswer>(answers, "topic_risk", "score");
  const work = requireAnswer<ScoreAnswer>(answers, "work_complexity", "score");
  const confidence = clamp01(
    Math.min(prompt.confidence, topic.confidence, work.confidence),
  );
  return {
    value: {
      prompt: normalizeScore(prompt, PROMPT_COMPLEXITY_LEVELS.length),
      topic: normalizeScore(topic, TOPIC_RISK_LEVELS.length),
      work: normalizeScore(work, WORK_COMPLEXITY_LEVELS.length),
    },
    confidence,
    clientKind: TYPESAFE_CLIENT_KIND,
    heuristic: false,
  };
}

export function degradePromptComplexity(prompt: string): number {
  return prompt.length > LONG_PROMPT_CHARS ? 0.6 : 0.3;
}

export function degradeTopicRisk(prompt: string): number {
  const text = prompt.toLowerCase();
  if (HIGH_RISK_KEYWORDS.some((keyword) => text.includes(keyword))) return 0.8;
  if (REFACTOR_KEYWORDS.some((keyword) => text.includes(keyword))) return 0.5;
  if (DEBUG_KEYWORDS.some((keyword) => text.includes(keyword))) return 0.45;
  return 0.3;
}

export function degradeWorkComplexity(fileCount: number): number {
  if (fileCount >= 25) return 0.8;
  if (fileCount >= 8) return 0.6;
  if (fileCount >= 2) return 0.35;
  return 0.15;
}

export function degradeModelScores(
  request: ModelSelectionRequest,
): JevResult<ModelComplexityScores> {
  return {
    value: {
      prompt: degradePromptComplexity(request.prompt),
      topic: degradeTopicRisk(request.prompt),
      work: degradeWorkComplexity(request.repoContext.fileCount),
    },
    confidence: MODEL_DEGRADE_CONFIDENCE,
    clientKind: "degrade",
    heuristic: true,
  };
}

export interface CombinePolicyInput {
  /**
   * Session usage budget fraction (0..1). Absent means unknown; the policy
   * falls back to {@link UNKNOWN_BUDGET_DEFAULT} (0.4) — a conservative
   * mid-band assumption that never unlocks the high-band premium gate.
   */
  budget?: number;
  contextBucket: ContextBucket;
  scores: ModelComplexityScores;
  confidence: number;
}

export interface ModelPolicy {
  tier: ModelSelectionResult["tier"];
  reasoningEffort: ModelSelectionResult["reasoningEffort"];
  complexity: number;
  rationale: string;
  probabilities: Record<string, number>;
}

function tierFor(
  budget: number,
  complexity: number,
  bucket: ContextBucket,
): ModelSelectionResult["tier"] {
  if (budget < ECONOMY_BUDGET_CEILING) return "economy";
  const gate =
    budget >= HIGH_BUDGET_FLOOR
      ? PREMIUM_COMPLEXITY_GATE_HIGH_BAND
      : PREMIUM_COMPLEXITY_GATE_LOW_BAND;
  if (complexity >= gate || bucket === "large") return "premium";
  return "standard";
}

function effortFor(
  tier: ModelSelectionResult["tier"],
  complexity: number,
  topic: number,
): ModelSelectionResult["reasoningEffort"] {
  if (tier === "economy") {
    return complexity >= HIGH_EFFORT_COMPLEXITY ? "medium" : "low";
  }
  if (tier === "standard") {
    return complexity >= HIGH_EFFORT_COMPLEXITY ? "high" : "medium";
  }
  if (complexity >= XHIGH_EFFORT_COMPLEXITY || topic >= TOPIC_HIGHEST_LEVEL) {
    return "xhigh";
  }
  return "high";
}

export function tierProbabilities(
  budget: number,
  complexity: number,
  bucket: ContextBucket,
): Record<string, number> {
  const gate =
    budget >= HIGH_BUDGET_FLOOR
      ? PREMIUM_COMPLEXITY_GATE_HIGH_BAND
      : PREMIUM_COMPLEXITY_GATE_LOW_BAND;
  const economyPull =
    budget < ECONOMY_BUDGET_CEILING
      ? clamp01((ECONOMY_BUDGET_CEILING - budget) / ECONOMY_BUDGET_CEILING)
      : 0;
  let premiumPull = clamp01((complexity - (gate - 0.2)) / 0.4);
  if (bucket === "large") premiumPull = Math.max(premiumPull, 0.7);
  if (budget < ECONOMY_BUDGET_CEILING) premiumPull = Math.min(premiumPull, 0.1);
  const raw = {
    economy: economyPull,
    standard:
      budget < ECONOMY_BUDGET_CEILING ? (1 - economyPull) * 0.8 : 1 - premiumPull,
    premium: premiumPull,
  };
  const total = raw.economy + raw.standard + raw.premium;
  return {
    economy: raw.economy / total,
    standard: raw.standard / total,
    premium: raw.premium / total,
  };
}

function policyRationale(
  budget: number,
  tier: ModelSelectionResult["tier"],
  effort: ModelSelectionResult["reasoningEffort"],
  complexity: number,
  topic: number,
  bucket: ContextBucket,
): string {
  const drivers: string[] = [];
  if (budget < ECONOMY_BUDGET_CEILING) {
    drivers.push("low budget → economy tier");
  } else if (tier === "premium" && bucket === "large") {
    drivers.push("large expected context → premium for caching");
  } else if (tier === "premium") {
    drivers.push("high complexity → premium tier");
  } else {
    drivers.push("moderate budget and complexity → standard tier");
  }
  if (effort === "xhigh") {
    drivers.push(
      topic >= TOPIC_HIGHEST_LEVEL
        ? "highest-risk topic → xhigh effort"
        : "high complexity → xhigh effort",
    );
  } else if (effort === "high") {
    drivers.push("high complexity → high effort");
  } else if (effort === "medium") {
    drivers.push(
      complexity >= HIGH_EFFORT_COMPLEXITY
        ? "high complexity → medium effort"
        : "moderate complexity → medium effort",
    );
  } else {
    drivers.push("low complexity → low effort");
  }
  return `${drivers.join("; ")}.`;
}

export function combinePolicy(input: CombinePolicyInput): ModelPolicy {
  const budget = input.budget ?? UNKNOWN_BUDGET_DEFAULT;
  const complexity =
    0.4 * input.scores.work +
    0.35 * input.scores.topic +
    0.25 * input.scores.prompt;
  const tier = tierFor(budget, complexity, input.contextBucket);
  const reasoningEffort = effortFor(tier, complexity, input.scores.topic);
  return {
    tier,
    reasoningEffort,
    complexity,
    rationale: policyRationale(
      budget,
      tier,
      reasoningEffort,
      complexity,
      input.scores.topic,
      input.contextBucket,
    ),
    probabilities: tierProbabilities(budget, complexity, input.contextBucket),
  };
}

export interface ModelSelectionDeps {
  client?: JevClient;
  catalog?: ModelCatalog;
}

export async function selectModelForSession(
  request: ModelSelectionRequest,
  deps: ModelSelectionDeps = {},
): Promise<ModelSelectionResult> {
  ModelSelectionRequestSchema.parse(request);
  const catalog = deps.catalog ?? DEFAULT_MODEL_CATALOG;
  const contextTokensEstimate = estimateContextTokens(request);
  const scores =
    (await deps.client?.scoreModelComplexity?.(request)) ??
    degradeModelScores(request);
  const policy = combinePolicy({
    budget: request.usageBudgetFraction,
    contextBucket: contextBucketFor(contextTokensEstimate),
    scores: scores.value,
    confidence: scores.confidence,
  });
  return {
    modelId: catalog.tiers[policy.tier],
    reasoningEffort: policy.reasoningEffort,
    tier: policy.tier,
    auto: true,
    confidence: scores.confidence,
    rationale: scores.heuristic ? `[heuristic] ${policy.rationale}` : policy.rationale,
    probabilities: policy.probabilities,
    contextTokensEstimate,
    complexity: { ...scores.value },
  };
}
