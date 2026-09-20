import { DEFAULT_MODEL_CATALOG } from "@jevcode/contracts";
import type {
  ModelSelectionRequest,
  ModelSelectionResult,
} from "@jevcode/contracts";
import { createJevClient, selectModelForSession } from "@jevcode/jev-router";

import type { RepoContext } from "./repo-context.js";

export const MODEL_TIERS = DEFAULT_MODEL_CATALOG.tiers;
export const MODEL_OPTIONS = [
  "auto",
  MODEL_TIERS.economy,
  MODEL_TIERS.standard,
  MODEL_TIERS.premium,
] as const;

export type ModelTier = "economy" | "standard" | "premium";

export type { ModelSelectionRequest, ModelSelectionResult };

export type ModelSelector = (
  request: ModelSelectionRequest,
) => ModelSelectionResult | Promise<ModelSelectionResult>;

let cachedClient: ReturnType<typeof createJevClient> | null = null;

/**
 * Auto-selection via the jev-router model policy: Jev scores prompt, topic,
 * and work complexity; deterministic policy combines them with the usage
 * budget and context estimate (see SPEC §3.1c). Degrades to heuristics
 * offline. The request.repoContext shape matches @jevcode/contracts
 * RepoContextSchema.
 */
export async function defaultModelSelector(
  request: ModelSelectionRequest,
): Promise<ModelSelectionResult> {
  if (cachedClient === null) {
    cachedClient = createJevClient();
  }
  return selectModelForSession(
    {
      prompt: request.prompt,
      repoContext: request.repoContext as RepoContext,
      usageBudgetFraction: request.usageBudgetFraction,
    },
    { client: cachedClient },
  );
}
