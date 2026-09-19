import type { AttentionDecision, UIIntent } from "@jevcode/contracts";

import {
  ATTENTION_LEVELS,
  DENSITY_LEVELS,
  HUMAN_DECISIONS,
  MAX_SECONDARY_VIEWS,
  REPRESENTATIONS,
  SCOPES,
  SEMANTIC_KINDS,
} from "./questions.js";
import { subjectFromCategory } from "./state.js";
import type {
  ChoiceAnswer,
  NoulAnswer,
  ProjectionInput,
  ScoreAnswer,
} from "./types.js";

export class AnswerMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnswerMappingError";
  }
}

// Non-finite inputs (NaN, ±Infinity) floor to 0: an unanswerable or broken
// confidence must not leak NaN into decision output.
const clamp01 = (value: number) =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

export function normalizeScore(answer: ScoreAnswer, levelCount: number): number {
  if (levelCount < 2) throw new AnswerMappingError("score needs at least two levels");
  if (!Number.isFinite(answer.score)) throw new AnswerMappingError("score is not finite");
  return clamp01(answer.score / (levelCount - 1));
}

function requireAnswer<T>(
  answers: Record<string, unknown>,
  key: string,
  type: string,
): T {
  const answer = answers[key];
  if (answer === undefined || answer === null) {
    throw new AnswerMappingError(`missing answer for "${key}"`);
  }
  const typed = answer as { type?: unknown };
  if (typed.type !== type) {
    throw new AnswerMappingError(`answer "${key}" has type ${String(typed.type)}, expected ${type}`);
  }
  return answer as T;
}

function noulToBoolean(answer: NoulAnswer): boolean {
  if (!Number.isFinite(answer.noul)) throw new AnswerMappingError("noul is not finite");
  return clamp01(answer.noul) >= 0.5;
}

function choiceOf<T extends string>(
  answer: ChoiceAnswer,
  allowed: readonly T[],
  label: string,
): T {
  if (!allowed.includes(answer.choice as T)) {
    throw new AnswerMappingError(`${label} "${answer.choice}" is not an allowed value`);
  }
  return answer.choice as T;
}

export interface PassAAnswers {
  should_surface: NoulAnswer;
  semantic_category: ChoiceAnswer;
  importance: ScoreAnswer;
  relevance: ScoreAnswer;
  interruption: ScoreAnswer;
  mental_model_change: ScoreAnswer;
  scope: ChoiceAnswer;
  human_decision: ChoiceAnswer;
  needs_system2: NoulAnswer;
}

const IMPORTANCE_LEVEL_COUNT = 5;
const RELEVANCE_LEVEL_COUNT = 5;
const INTERRUPTION_LEVEL_COUNT = 5;
const MENTAL_MODEL_LEVEL_COUNT = 5;

export function passAAnswersFrom(
  answers: Record<string, unknown>,
  unitKey: string,
): PassAAnswers {
  const key = (name: string) => `${unitKey}:${name}`;
  return {
    should_surface: requireAnswer<NoulAnswer>(answers, key("should_surface"), "noul"),
    semantic_category: requireAnswer<ChoiceAnswer>(
      answers,
      key("semantic_category"),
      "choice",
    ),
    importance: requireAnswer<ScoreAnswer>(answers, key("importance"), "score"),
    relevance: requireAnswer<ScoreAnswer>(answers, key("relevance"), "score"),
    interruption: requireAnswer<ScoreAnswer>(answers, key("interruption"), "score"),
    mental_model_change: requireAnswer<ScoreAnswer>(
      answers,
      key("mental_model_change"),
      "score",
    ),
    scope: requireAnswer<ChoiceAnswer>(answers, key("scope"), "choice"),
    human_decision: requireAnswer<ChoiceAnswer>(answers, key("human_decision"), "choice"),
    needs_system2: requireAnswer<NoulAnswer>(answers, key("needs_system2"), "noul"),
  };
}

export function mapAttention(
  answers: PassAAnswers,
): AttentionDecision {
  const semanticCategory = choiceOf(
    answers.semantic_category,
    SEMANTIC_KINDS,
    "semantic_category",
  );
  const scope = choiceOf(answers.scope, SCOPES, "scope");
  const humanDecision = choiceOf(
    answers.human_decision,
    HUMAN_DECISIONS,
    "human_decision",
  );
  const probabilities: Record<string, number> = {};
  for (const [key, prob] of Object.entries(answers.semantic_category.probabilities ?? {})) {
    if ((SEMANTIC_KINDS as readonly string[]).includes(key)) probabilities[key] = clamp01(prob);
  }
  return {
    shouldSurface: noulToBoolean(answers.should_surface),
    importance: normalizeScore(answers.importance, IMPORTANCE_LEVEL_COUNT),
    relevance: normalizeScore(answers.relevance, RELEVANCE_LEVEL_COUNT),
    interruption: normalizeScore(answers.interruption, INTERRUPTION_LEVEL_COUNT),
    mentalModelChange: normalizeScore(
      answers.mental_model_change,
      MENTAL_MODEL_LEVEL_COUNT,
    ),
    semanticCategory,
    scope,
    humanDecision,
    needsSystem2: noulToBoolean(answers.needs_system2),
    confidence: clamp01(answers.semantic_category.confidence),
    probabilities,
  };
}

export interface PassBAnswers {
  representation: ChoiceAnswer;
  attention: ChoiceAnswer;
  density: ChoiceAnswer;
  show_evidence: NoulAnswer;
  show_code: NoulAnswer;
  secondary_views: Record<string, NoulAnswer>;
}

export function passBAnswersFrom(answers: Record<string, unknown>): PassBAnswers {
  const secondary: Record<string, NoulAnswer> = {};
  for (const [key] of Object.entries(answers)) {
    if (key.startsWith("secondary:")) {
      secondary[key.slice("secondary:".length)] = requireAnswer<NoulAnswer>(
        answers,
        key,
        "noul",
      );
    }
  }
  return {
    representation: requireAnswer<ChoiceAnswer>(answers, "representation", "choice"),
    attention: requireAnswer<ChoiceAnswer>(answers, "attention", "choice"),
    density: requireAnswer<ChoiceAnswer>(answers, "density", "choice"),
    show_evidence: requireAnswer<NoulAnswer>(answers, "show_evidence", "noul"),
    show_code: requireAnswer<NoulAnswer>(answers, "show_code", "noul"),
    secondary_views: secondary,
  };
}

export function secondaryViewsFrom(
  secondary: Record<string, NoulAnswer>,
): string[] {
  return Object.entries(secondary)
    .filter(([, answer]) => answer.noul >= 0.5)
    .sort((a, b) => b[1].noul - a[1].noul)
    .slice(0, MAX_SECONDARY_VIEWS)
    .map(([name]) => name);
}

export function mapProjection(
  answers: PassBAnswers,
  input: ProjectionInput,
): UIIntent {
  const representation = choiceOf(
    answers.representation,
    REPRESENTATIONS,
    "representation",
  );
  const attention = choiceOf(answers.attention, ATTENTION_LEVELS, "attention");
  const density = choiceOf(answers.density, DENSITY_LEVELS, "density");
  return {
    attention,
    subject: subjectFromCategory(input.attention.semanticCategory),
    representation,
    density,
    confidence: clamp01(answers.representation.confidence),
    showEvidence: noulToBoolean(answers.show_evidence),
    showCode: noulToBoolean(answers.show_code),
    secondaryViews: secondaryViewsFrom(answers.secondary_views),
    renderMode: "generic",
  };
}

export function attentionConfidence(answers: PassAAnswers): number {
  return clamp01(answers.semantic_category.confidence);
}

export function projectionConfidence(answers: PassBAnswers): number {
  return clamp01(answers.representation.confidence);
}
