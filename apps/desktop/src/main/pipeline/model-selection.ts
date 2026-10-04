import { DEFAULT_MODEL_CATALOG } from "@jevcode/contracts";
import type {
  ModelSelectionRequest,
  ModelSelectionResult,
} from "@jevcode/contracts";
import { createJevClient, selectModelForSession } from "@jevcode/jev-router";
import type { JevClient } from "@jevcode/jev-router";

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

function selectWith(request: ModelSelectionRequest, client: JevClient): Promise<ModelSelectionResult> {
  return selectModelForSession(
    {
      prompt: request.prompt,
      repoContext: request.repoContext as RepoContext,
      usageBudgetFraction: request.usageBudgetFraction,
    },
    { client },
  );
}

/**
 * Auto-selection via the jev-router model policy: Jev scores prompt, topic,
 * and work complexity; deterministic policy combines them with the usage
 * budget and context estimate (see SPEC §3.1c). Degrades to heuristics
 * offline. The request.repoContext shape matches @jevcode/contracts
 * RepoContextSchema.
 *
 * Its client reads process.env once for the life of the process. The desktop
 * app passes createModelSelector instead; this stays the fallback for runtimes
 * built without a selector (the replay CLI, perf and soak scripts, tests).
 */
export async function defaultModelSelector(
  request: ModelSelectionRequest,
): Promise<ModelSelectionResult> {
  if (cachedClient === null) {
    cachedClient = createJevClient();
  }
  return selectWith(request, cachedClient);
}

/**
 * Auto-selection that scores each request with a Jev client built for it, so
 * the saved TypeSafe key and the Jev client choice apply from the next session
 * (settings spec: "the runtime creates the Jev client per session").
 */
export function createModelSelector(createClient: () => JevClient): ModelSelector {
  return (request) => selectWith(request, createClient());
}
