export const AGENT_MODEL_OPTIONS = [
  "auto",
  "gpt-5.6-mini",
  "gpt-5.6-sol",
  "gpt-5.6-luna",
] as const;

export type AgentModelOption = (typeof AGENT_MODEL_OPTIONS)[number];

export const REASONING_EFFORT_OPTIONS = [
  "auto",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type ReasoningEffortOption = (typeof REASONING_EFFORT_OPTIONS)[number];

export const AGENT_MODEL_PREF_KEY = "agent.model";
export const REASONING_EFFORT_PREF_KEY = "agent.reasoningEffort";
export const USAGE_BUDGET_PREF_KEY = "agent.usageBudgetFraction";

export interface AgentPreferences {
  model: AgentModelOption;
  reasoningEffort: ReasoningEffortOption;
  /** Fraction of the usage budget in [0, 1] as a decimal string, or null when unknown. */
  usageBudgetFraction: string | null;
}

export interface AgentPreferencesPatch {
  model?: AgentModelOption;
  reasoningEffort?: ReasoningEffortOption;
  usageBudgetFraction?: string | null;
}

export const DEFAULT_AGENT_PREFERENCES: AgentPreferences = {
  model: "auto",
  reasoningEffort: "auto",
  usageBudgetFraction: null,
};

const BUDGET_RE = /^(0(\.\d+)?|1(\.0+)?)$/;

export function normalizeModel(value: unknown): AgentModelOption {
  if (
    typeof value === "string" &&
    (AGENT_MODEL_OPTIONS as readonly string[]).includes(value)
  ) {
    return value as AgentModelOption;
  }
  return "auto";
}

export function normalizeReasoningEffort(value: unknown): ReasoningEffortOption {
  if (
    typeof value === "string" &&
    (REASONING_EFFORT_OPTIONS as readonly string[]).includes(value)
  ) {
    return value as ReasoningEffortOption;
  }
  return "auto";
}

/** Normalizes a stored or incoming budget fraction to a 2-decimal string, or null when unknown/invalid. */
export function normalizeBudgetFraction(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  ) {
    return value.toFixed(2);
  }
  if (typeof value === "string" && value.trim() !== "" && BUDGET_RE.test(value.trim())) {
    return Number(value.trim()).toFixed(2);
  }
  return null;
}

/** Converts a normalized budget fraction string to a number, or undefined when unknown. */
export function budgetFractionNumber(
  value: string | null | undefined,
): number | undefined {
  const normalized = normalizeBudgetFraction(value);
  return normalized === null ? undefined : Number(normalized);
}

/** Parses an env-style budget value (string or number) to a number, or undefined when unknown/invalid. */
export function parseBudgetNumber(
  raw: string | number | undefined,
): number | undefined {
  const normalized = normalizeBudgetFraction(raw);
  return normalized === null ? undefined : Number(normalized);
}

/** Reads the three agent preferences through a storage getter, applying defaults. */
export function readAgentPreferences(
  get: (key: string) => unknown,
): AgentPreferences {
  return {
    model: normalizeModel(get(AGENT_MODEL_PREF_KEY)),
    reasoningEffort: normalizeReasoningEffort(get(REASONING_EFFORT_PREF_KEY)),
    usageBudgetFraction: normalizeBudgetFraction(get(USAGE_BUDGET_PREF_KEY)),
  };
}

export function applyPreferencesPatch(
  current: AgentPreferences,
  patch: AgentPreferencesPatch,
): AgentPreferences {
  return {
    model: patch.model ?? current.model,
    reasoningEffort: patch.reasoningEffort ?? current.reasoningEffort,
    usageBudgetFraction:
      patch.usageBudgetFraction !== undefined
        ? patch.usageBudgetFraction
        : current.usageBudgetFraction,
  };
}

/** Summary line shown in the task prompt panel, e.g. "gpt-5.6-luna · xhigh" or "auto". */
export function agentSummaryLabel(
  prefs: Pick<AgentPreferences, "model" | "reasoningEffort">,
): string {
  if (prefs.model === "auto") return "auto";
  return `${prefs.model} · ${prefs.reasoningEffort}`;
}
