import { describe, expect, it, vi } from "vitest";

import { resolveSessionModelSelection } from "./model-resolution.js";
import type { ModelSelectionRequest, ModelSelectionResult } from "./model-selection.js";
import type { RepoContext } from "./repo-context.js";

const CONTEXT: RepoContext = {
  fileCount: 10,
  totalBytes: 1_000,
  languages: ["typescript"],
};

const SELECTED: ModelSelectionResult = {
  modelId: "gpt-5.6-mini",
  reasoningEffort: "low",
  tier: "economy",
  auto: true,
  confidence: 0.9,
  rationale: "test selection",
  probabilities: { economy: 0.9, standard: 0.1 },
  contextTokensEstimate: 250,
  complexity: { prompt: 0.1, topic: 0.1, work: 0.1 },
};

function makeDeps() {
  const envMap = new Map<string, string>();
  const prefMap = new Map<string, unknown>();
  const select = vi.fn<(request: ModelSelectionRequest) => Promise<ModelSelectionResult>>(
    async () => SELECTED,
  );
  const deriveContext = vi.fn<(repoPath: string) => Promise<RepoContext>>(
    async () => CONTEXT,
  );
  return {
    env: (key: string) => envMap.get(key),
    getPreference: (key: string) => prefMap.get(key),
    deriveContext,
    select,
    envMap,
    prefMap,
  };
}

const INPUT = {
  model: undefined as string | undefined,
  reasoningEffort: undefined as string | undefined,
  prompt: "add rate limiting",
  repoPath: "/repo",
};

describe("resolveSessionModelSelection", () => {
  it("bypasses auto selection for explicit model and effort", async () => {
    const deps = makeDeps();
    const result = await resolveSessionModelSelection(
      { ...INPUT, model: "gpt-5.6-sol", reasoningEffort: "high" },
      deps,
    );
    expect(result).toEqual({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      selection: null,
    });
    expect(deps.select).not.toHaveBeenCalled();
    expect(deps.deriveContext).not.toHaveBeenCalled();
  });

  it("lets env overrides win over preferences", async () => {
    const deps = makeDeps();
    deps.envMap.set("JEVCODE_CODEX_MODEL", "gpt-5.6-luna");
    deps.envMap.set("JEVCODE_CODEX_REASONING_EFFORT", "xhigh");
    deps.prefMap.set("agent.model", "auto");
    deps.prefMap.set("agent.reasoningEffort", "auto");
    const result = await resolveSessionModelSelection(INPUT, deps);
    expect(result).toEqual({
      model: "gpt-5.6-luna",
      reasoningEffort: "xhigh",
      selection: null,
    });
    expect(deps.select).not.toHaveBeenCalled();
  });

  it("runs auto selection and passes prompt, repo context, and preference budget", async () => {
    const deps = makeDeps();
    deps.prefMap.set("agent.model", "auto");
    deps.prefMap.set("agent.reasoningEffort", "auto");
    deps.prefMap.set("agent.usageBudgetFraction", "0.30");
    const result = await resolveSessionModelSelection(INPUT, deps);
    expect(deps.select).toHaveBeenCalledWith({
      prompt: "add rate limiting",
      repoContext: CONTEXT,
      usageBudgetFraction: 0.3,
    });
    expect(result).toEqual({
      model: "gpt-5.6-mini",
      reasoningEffort: "low",
      selection: SELECTED,
    });
  });

  it("treats an absent budget preference as unknown (undefined)", async () => {
    const deps = makeDeps();
    await resolveSessionModelSelection(INPUT, deps);
    expect(deps.select).toHaveBeenCalledWith(
      expect.objectContaining({ usageBudgetFraction: undefined }),
    );
  });

  it("lets the env budget override the preference budget", async () => {
    const deps = makeDeps();
    deps.envMap.set("JEVCODE_USAGE_BUDGET", "0.10");
    deps.prefMap.set("agent.usageBudgetFraction", "0.50");
    await resolveSessionModelSelection(INPUT, deps);
    expect(deps.select).toHaveBeenCalledWith(
      expect.objectContaining({ usageBudgetFraction: 0.1 }),
    );
  });

  it("keeps an explicit model while auto-selecting the effort", async () => {
    const deps = makeDeps();
    const result = await resolveSessionModelSelection(
      { ...INPUT, model: "gpt-5.6-sol" },
      deps,
    );
    expect(deps.select).toHaveBeenCalled();
    expect(result).toEqual({
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      selection: SELECTED,
    });
  });

  it("keeps an explicit effort while auto-selecting the model", async () => {
    const deps = makeDeps();
    const result = await resolveSessionModelSelection(
      { ...INPUT, reasoningEffort: "high" },
      deps,
    );
    expect(deps.select).toHaveBeenCalled();
    expect(result).toEqual({
      model: "gpt-5.6-mini",
      reasoningEffort: "high",
      selection: SELECTED,
    });
  });
});
