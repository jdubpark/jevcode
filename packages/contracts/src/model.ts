import { z } from "zod";

export const ModelTierSchema = z.enum(["economy", "standard", "premium"]);

export type ModelTier = z.infer<typeof ModelTierSchema>;

export const ReasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh"]);

export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const RepoContextSchema = z.object({
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  languages: z.array(z.string().min(1)),
});

export type RepoContext = z.infer<typeof RepoContextSchema>;

export const ModelSelectionRequestSchema = z.object({
  prompt: z.string().min(1),
  repoContext: RepoContextSchema,
  usageBudgetFraction: z.number().min(0).max(1).optional(),
});

export type ModelSelectionRequest = z.infer<typeof ModelSelectionRequestSchema>;

export const ComplexityScoresSchema = z.object({
  prompt: z.number().min(0).max(1),
  topic: z.number().min(0).max(1),
  work: z.number().min(0).max(1),
});

export type ComplexityScores = z.infer<typeof ComplexityScoresSchema>;

export const ModelSelectionResultSchema = z.object({
  modelId: z.string().min(1),
  reasoningEffort: ReasoningEffortSchema,
  tier: ModelTierSchema,
  auto: z.boolean(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
  contextTokensEstimate: z.number().int().nonnegative(),
  complexity: ComplexityScoresSchema,
});

export type ModelSelectionResult = z.infer<typeof ModelSelectionResultSchema>;

export const ModelCatalogSchema = z.object({
  tiers: z.object({
    economy: z.string().min(1),
    standard: z.string().min(1),
    premium: z.string().min(1),
  }),
});

export type ModelCatalog = z.infer<typeof ModelCatalogSchema>;

export const DEFAULT_MODEL_CATALOG: ModelCatalog = {
  tiers: {
    economy: "gpt-5.6-mini",
    standard: "gpt-5.6-sol",
    premium: "gpt-5.6-luna",
  },
};
