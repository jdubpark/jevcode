import { describe, expect, it } from "vitest";

import {
  AGENT_MODEL_OPTIONS,
  REASONING_EFFORT_OPTIONS,
  DEFAULT_AGENT_PREFERENCES,
  agentSummaryLabel,
  agentBackendOverride,
  applyPreferencesPatch,
  jevClientEnvValue,
  jevClientOverride,
  budgetFractionNumber,
  normalizeBudgetFraction,
  normalizeExplainWithModel,
  normalizeModel,
  normalizeReasoningEffort,
  parseBudgetNumber,
  readAgentPreferences,
} from "./prefs.js";

describe("agent preference helpers", () => {
  it("exposes the documented option lists", () => {
    expect(AGENT_MODEL_OPTIONS).toEqual([
      "auto",
      "gpt-5.6-mini",
      "gpt-5.6-sol",
      "gpt-5.6-luna",
    ]);
    expect(REASONING_EFFORT_OPTIONS).toEqual([
      "auto",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("reads defaults when storage has nothing; explaining with a model is on by default (E15)", () => {
    expect(readAgentPreferences(() => undefined)).toEqual(
      DEFAULT_AGENT_PREFERENCES,
    );
    expect(DEFAULT_AGENT_PREFERENCES).toEqual({
      model: "auto",
      reasoningEffort: "auto",
      usageBudgetFraction: null,
      explainWithModel: true,
      agentBackend: "auto",
      jevClient: "auto",
    });
  });

  it("reads stored values and falls back on invalid ones", () => {
    const store = new Map<string, unknown>([
      ["agent.model", "gpt-5.6-luna"],
      ["agent.reasoningEffort", "xhigh"],
      ["agent.usageBudgetFraction", "0.25"],
      ["explainer.withModel", false],
    ]);
    expect(readAgentPreferences((key) => store.get(key))).toEqual({
      model: "gpt-5.6-luna",
      reasoningEffort: "xhigh",
      usageBudgetFraction: "0.25",
      explainWithModel: false,
      agentBackend: "auto",
      jevClient: "auto",
    });

    const invalid = new Map<string, unknown>([
      ["agent.model", "gpt-9"],
      ["agent.reasoningEffort", "extreme"],
      ["agent.usageBudgetFraction", "2.0"],
      ["explainer.withModel", "no"],
    ]);
    expect(readAgentPreferences((key) => invalid.get(key))).toEqual(
      DEFAULT_AGENT_PREFERENCES,
    );
  });

  it("reads only a stored boolean as the explain setting", () => {
    expect(normalizeExplainWithModel(false)).toBe(false);
    expect(normalizeExplainWithModel(true)).toBe(true);
    for (const value of [undefined, null, 0, "false", "off", {}]) {
      expect(normalizeExplainWithModel(value), String(value)).toBe(true);
    }
  });

  it("normalizes model and effort values", () => {
    expect(normalizeModel("gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(normalizeModel("gpt-5")).toBe("auto");
    expect(normalizeModel(42)).toBe("auto");
    expect(normalizeReasoningEffort("medium")).toBe("medium");
    expect(normalizeReasoningEffort("extreme")).toBe("auto");
  });

  it("normalizes budget fraction strings and numbers", () => {
    expect(normalizeBudgetFraction("0.4")).toBe("0.40");
    expect(normalizeBudgetFraction(0.4)).toBe("0.40");
    expect(normalizeBudgetFraction("1")).toBe("1.00");
    expect(normalizeBudgetFraction("0")).toBe("0.00");
    expect(normalizeBudgetFraction(null)).toBeNull();
    expect(normalizeBudgetFraction(undefined)).toBeNull();
    expect(normalizeBudgetFraction("")).toBeNull();
    expect(normalizeBudgetFraction("1.5")).toBeNull();
    expect(normalizeBudgetFraction("-0.1")).toBeNull();
    expect(normalizeBudgetFraction("abc")).toBeNull();
    expect(normalizeBudgetFraction(NaN)).toBeNull();
  });

  it("converts budget fractions to numbers for policy input", () => {
    expect(budgetFractionNumber("0.30")).toBe(0.3);
    expect(budgetFractionNumber(null)).toBeUndefined();
    expect(budgetFractionNumber(undefined)).toBeUndefined();
    expect(parseBudgetNumber("0.10")).toBe(0.1);
    expect(parseBudgetNumber("junk")).toBeUndefined();
    expect(parseBudgetNumber(undefined)).toBeUndefined();
  });

  it("applies patches and preserves untouched fields", () => {
    const current = {
      model: "auto" as const,
      reasoningEffort: "medium" as const,
      usageBudgetFraction: "0.50",
      explainWithModel: true,
      agentBackend: "auto" as const,
      jevClient: "auto" as const,
    };
    expect(applyPreferencesPatch(current, { model: "gpt-5.6-sol" })).toEqual({
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      usageBudgetFraction: "0.50",
      explainWithModel: true,
      agentBackend: "auto",
      jevClient: "auto",
    });
    expect(
      applyPreferencesPatch(current, { usageBudgetFraction: null }),
    ).toEqual({
      model: "auto",
      reasoningEffort: "medium",
      usageBudgetFraction: null,
      explainWithModel: true,
      agentBackend: "auto",
      jevClient: "auto",
    });
    expect(applyPreferencesPatch(current, { explainWithModel: false })).toEqual({
      ...current,
      explainWithModel: false,
    });
    expect(applyPreferencesPatch(current, {})).toEqual(current);
  });

  it("builds the task prompt summary label", () => {
    expect(agentSummaryLabel({ model: "auto", reasoningEffort: "auto" })).toBe(
      "auto",
    );
    expect(
      agentSummaryLabel({ model: "gpt-5.6-luna", reasoningEffort: "xhigh" }),
    ).toBe("gpt-5.6-luna · xhigh");
    expect(
      agentSummaryLabel({ model: "gpt-5.6-mini", reasoningEffort: "auto" }),
    ).toBe("gpt-5.6-mini · auto");
  });
});

describe("agent backend and Jev client preferences", () => {
  it("default to auto and ignore unknown stored values", () => {
    const prefs = readAgentPreferences((key) => ({ "agent.backend": "bogus", "jev.client": 7 })[key]);
    expect(prefs).toMatchObject({ agentBackend: "auto", jevClient: "auto" });
    expect(applyPreferencesPatch(prefs, { agentBackend: "mock", jevClient: "offline" })).toMatchObject({ agentBackend: "mock", jevClient: "offline" });
  });

  it("read environment overrides and map offline to degrade", () => {
    expect(agentBackendOverride({ JEVC_AGENT: "mock" })).toBe("mock");
    expect(agentBackendOverride({ JEVC_AGENT: "replay" })).toBe("replay");
    expect(agentBackendOverride({ JEVC_AGENT: "x" })).toBeUndefined();
    expect(jevClientOverride({ JEVC_JEV_CLIENT: "degrade" })).toBe("degrade");
    expect(jevClientOverride({})).toBeUndefined();
    expect(jevClientEnvValue("offline")).toBe("degrade");
    expect(jevClientEnvValue("typesafe")).toBe("typesafe");
    expect(jevClientEnvValue("auto")).toBeUndefined();
  });
});
