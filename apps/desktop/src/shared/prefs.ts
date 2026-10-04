import type { NarratorAvailability } from "./narrator-log.js";

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

export const AGENT_BACKEND_OPTIONS = ["auto", "codex", "mock"] as const;
export type AgentBackendOption = (typeof AGENT_BACKEND_OPTIONS)[number];
export const JEV_CLIENT_OPTIONS = ["auto", "typesafe", "offline"] as const;
export type JevClientOption = (typeof JEV_CLIENT_OPTIONS)[number];

export const AGENT_BACKEND_PREF_KEY = "agent.backend";
export const JEV_CLIENT_PREF_KEY = "jev.client";
export const AGENT_MODEL_PREF_KEY = "agent.model";
export const REASONING_EFFORT_PREF_KEY = "agent.reasoningEffort";
export const USAGE_BUDGET_PREF_KEY = "agent.usageBudgetFraction";
/** Console-explainer spec E15: "Explain with a model". Off stops every narrator call. */
export const EXPLAIN_WITH_MODEL_PREF_KEY = "explainer.withModel";

export interface AgentPreferences {
  model: AgentModelOption;
  reasoningEffort: ReasoningEffortOption;
  /** Fraction of the usage budget in [0, 1] as a decimal string, or null when unknown. */
  usageBudgetFraction: string | null;
  /** On by default (spec E15). False: rule-based explainer data only, no model calls. */
  explainWithModel: boolean;
  /** Applies to new sessions; JEVC_AGENT wins. */
  agentBackend: AgentBackendOption;
  /** Applies to new sessions; JEVC_JEV_CLIENT wins. */
  jevClient: JevClientOption;
}

/**
 * What preferences:get, the preferences:set reply and preferences:updated carry: the stored
 * preferences plus main's read-only narrator availability (setting, API key, JEVCODE_NARRATOR).
 * The availability is never stored; it is absent when main has no narrator switch.
 */
export interface PreferencesView extends AgentPreferences {
  narratorAvailability?: NarratorAvailability;
  /** The environment value that overrides the stored choice (JEVC_AGENT), when set. */
  agentBackendOverride?: string;
  /** The environment value that overrides the stored choice (JEVC_JEV_CLIENT), when set. */
  jevClientOverride?: string;
}

export interface AgentPreferencesPatch {
  model?: AgentModelOption;
  reasoningEffort?: ReasoningEffortOption;
  usageBudgetFraction?: string | null;
  explainWithModel?: boolean;
  agentBackend?: AgentBackendOption;
  jevClient?: JevClientOption;
}

export const DEFAULT_AGENT_PREFERENCES: AgentPreferences = {
  model: "auto",
  reasoningEffort: "auto",
  usageBudgetFraction: null,
  explainWithModel: true,
  agentBackend: "auto",
  jevClient: "auto",
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

export function normalizeAgentBackend(value: unknown): AgentBackendOption {
  if (typeof value === "string" && (AGENT_BACKEND_OPTIONS as readonly string[]).includes(value)) {
    return value as AgentBackendOption;
  }
  return "auto";
}

export function normalizeJevClient(value: unknown): JevClientOption {
  if (typeof value === "string" && (JEV_CLIENT_OPTIONS as readonly string[]).includes(value)) {
    return value as JevClientOption;
  }
  return "auto";
}

const AGENT_ENV_VALUES = ["mock", "codex", "auto", "replay"];
export function agentBackendOverride(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const value = env["JEVC_AGENT"];
  return value !== undefined && AGENT_ENV_VALUES.includes(value) ? value : undefined;
}
export function jevClientOverride(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const value = env["JEVC_JEV_CLIENT"];
  return value === "typesafe" || value === "degrade" ? value : undefined;
}
export function jevClientEnvValue(option: JevClientOption): "typesafe" | "degrade" | undefined {
  return option === "typesafe" ? "typesafe" : option === "offline" ? "degrade" : undefined;
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

/** Only a stored boolean counts; anything else (missing, corrupt) reads as the default, on. */
export function normalizeExplainWithModel(value: unknown): boolean {
  return typeof value === "boolean" ? value : true;
}

/** Reads the agent preferences through a storage getter, applying defaults. */
export function readAgentPreferences(
  get: (key: string) => unknown,
): AgentPreferences {
  return {
    model: normalizeModel(get(AGENT_MODEL_PREF_KEY)),
    reasoningEffort: normalizeReasoningEffort(get(REASONING_EFFORT_PREF_KEY)),
    usageBudgetFraction: normalizeBudgetFraction(get(USAGE_BUDGET_PREF_KEY)),
    explainWithModel: normalizeExplainWithModel(get(EXPLAIN_WITH_MODEL_PREF_KEY)),
    agentBackend: normalizeAgentBackend(get(AGENT_BACKEND_PREF_KEY)),
    jevClient: normalizeJevClient(get(JEV_CLIENT_PREF_KEY)),
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
    explainWithModel: patch.explainWithModel ?? current.explainWithModel,
    agentBackend: patch.agentBackend ?? current.agentBackend,
    jevClient: patch.jevClient ?? current.jevClient,
  };
}

/** Summary line shown in the task prompt panel, e.g. "gpt-5.6-luna · xhigh" or "auto". */
export function agentSummaryLabel(
  prefs: Pick<AgentPreferences, "model" | "reasoningEffort">,
): string {
  if (prefs.model === "auto") return "auto";
  return `${prefs.model} · ${prefs.reasoningEffort}`;
}
