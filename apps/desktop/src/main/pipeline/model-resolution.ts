import {
  budgetFractionNumber,
  parseBudgetNumber,
  readAgentPreferences,
} from "../../shared/prefs.js";
import type {
  ModelSelectionRequest,
  ModelSelectionResult,
  ModelSelector,
} from "./model-selection.js";
import type { RepoContext } from "./repo-context.js";

export interface ModelResolutionDeps {
  env(key: string): string | undefined;
  getPreference(key: string): unknown;
  deriveContext(repoPath: string): Promise<RepoContext>;
  select: ModelSelector;
}

export interface ModelResolutionInput {
  model?: string;
  reasoningEffort?: string;
  prompt: string;
  repoPath: string;
}

export interface ResolvedModelSelection {
  model: string | undefined;
  reasoningEffort: string | undefined;
  selection: ModelSelectionResult | null;
}

/**
 * Resolves the concrete model/reasoning effort for a session start.
 *
 * Precedence: explicit session input > env override (JEVCODE_CODEX_MODEL /
 * JEVCODE_CODEX_REASONING_EFFORT) > auto policy selection. The policy runs
 * when either value is missing or "auto"; explicit values always bypass it.
 * The usage budget comes from JEVCODE_USAGE_BUDGET, then the stored
 * preference, and is undefined (unknown) when neither exists.
 */
export async function resolveSessionModelSelection(
  input: ModelResolutionInput,
  deps: ModelResolutionDeps,
): Promise<ResolvedModelSelection> {
  const explicitModel = input.model ?? deps.env("JEVCODE_CODEX_MODEL");
  const explicitEffort =
    input.reasoningEffort ?? deps.env("JEVCODE_CODEX_REASONING_EFFORT");
  const modelIsAuto = explicitModel === undefined || explicitModel === "auto";
  const effortIsAuto =
    explicitEffort === undefined || explicitEffort === "auto";

  if (!modelIsAuto && !effortIsAuto) {
    return {
      model: explicitModel,
      reasoningEffort: explicitEffort,
      selection: null,
    };
  }

  const prefs = readAgentPreferences(deps.getPreference);
  const usageBudgetFraction =
    parseBudgetNumber(deps.env("JEVCODE_USAGE_BUDGET")) ??
    budgetFractionNumber(prefs.usageBudgetFraction);
  const repoContext = await deps.deriveContext(input.repoPath);
  const request: ModelSelectionRequest = {
    prompt: input.prompt,
    repoContext,
    usageBudgetFraction,
  };
  const selection = await deps.select(request);

  return {
    model: modelIsAuto ? selection.modelId : explicitModel,
    reasoningEffort: effortIsAuto ? selection.reasoningEffort : explicitEffort,
    selection,
  };
}
