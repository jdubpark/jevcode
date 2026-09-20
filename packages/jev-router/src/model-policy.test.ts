import type { ModelCatalog, ModelSelectionRequest } from "@jevcode/contracts";
import { ModelSelectionResultSchema } from "@jevcode/contracts";
import { describe, expect, it } from "vitest";

import { DegradeClient } from "./degrade.js";
import type {
  ModelComplexityScores,
  ScoreAnswer,
  SystemOneRequestLike,
  TypeSafeTransport,
} from "./types.js";
import { TypeSafeClient } from "./typesafe-client.js";
import {
  combinePolicy,
  composeModelSelectionRequest,
  contextBucketFor,
  degradeModelScores,
  degradePromptComplexity,
  degradeTopicRisk,
  degradeWorkComplexity,
  estimateContextTokens,
  modelScoresFromAnswers,
  selectModelForSession,
  type ModelSelectionDeps,
} from "./model-policy.js";

function request(overrides: Partial<ModelSelectionRequest> = {}): ModelSelectionRequest {
  return {
    prompt: "Add rate limiting to the public API.",
    repoContext: { fileCount: 5, totalBytes: 120_000, languages: ["typescript"] },
    ...overrides,
  };
}

function scores(s: Partial<ModelComplexityScores> = {}): ModelComplexityScores {
  return { prompt: 0.2, topic: 0.2, work: 0.2, ...s };
}

function policy(
  s: ModelComplexityScores,
  deps: { budget?: number; contextBucket?: "small" | "medium" | "large" } = {},
) {
  return combinePolicy({
    budget: deps.budget,
    contextBucket: deps.contextBucket ?? "small",
    scores: s,
    confidence: 0.9,
  });
}

function score(value: number, confidence = 0.9): ScoreAnswer {
  return { type: "score", score: value, confidence, probabilities: {} };
}

describe("estimateContextTokens", () => {
  it("estimates prompt chars / 4 plus 300 tokens per repo file", () => {
    const result = estimateContextTokens(
      request({
        prompt: "x".repeat(400),
        repoContext: { fileCount: 2, totalBytes: 0, languages: [] },
      }),
    );
    expect(result).toBe(100 + 600);
  });

  it("caps the estimate at 400k tokens", () => {
    const result = estimateContextTokens(
      request({ repoContext: { fileCount: 1_000_000, totalBytes: 0, languages: [] } }),
    );
    expect(result).toBe(400_000);
  });
});

describe("contextBucketFor", () => {
  it("buckets small < 32k, medium 32k..128k, large > 128k", () => {
    expect(contextBucketFor(31_999)).toBe("small");
    expect(contextBucketFor(32_000)).toBe("medium");
    expect(contextBucketFor(128_000)).toBe("medium");
    expect(contextBucketFor(128_001)).toBe("large");
  });
});

describe("combinePolicy tier budget caps", () => {
  it("forces economy below 0.2 budget regardless of complexity", () => {
    expect(policy(scores({ prompt: 1, topic: 1, work: 1 }), { budget: 0 }).tier).toBe(
      "economy",
    );
    expect(policy(scores({ prompt: 1, topic: 1, work: 1 }), { budget: 0.19 }).tier).toBe(
      "economy",
    );
  });

  it("mid band: premium gate is complexity 0.7", () => {
    expect(policy(scores({ prompt: 0.4, topic: 0.4, work: 0.4 }), { budget: 0.4 }).tier).toBe(
      "standard",
    );
    expect(
      policy(scores({ prompt: 0.8, topic: 0.8, work: 0.8 }), { budget: 0.4 }).tier,
    ).toBe("premium");
  });

  it("high band: premium gate drops to complexity 0.5", () => {
    expect(policy(scores({ prompt: 0.4, topic: 0.4, work: 0.4 }), { budget: 0.9 }).tier).toBe(
      "standard",
    );
    expect(
      policy(scores({ prompt: 0.5, topic: 0.5, work: 0.5 }), { budget: 0.6 }).tier,
    ).toBe("premium");
  });

  it("large context forces premium even at low complexity", () => {
    const result = policy(scores({ prompt: 0.1, topic: 0.1, work: 0.1 }), {
      budget: 0.3,
      contextBucket: "large",
    });
    expect(result.tier).toBe("premium");
    expect(result.rationale).toContain("premium for caching");
  });
});

describe("combinePolicy threshold boundaries", () => {
  it("up-tiers at the exact mid-band gate (complexity exactly 0.7)", () => {
    // 0.4 * 0.25 + 0.35 * 1 + 0.25 * 1 === 0.7 in float64
    const result = policy(scores({ prompt: 1, topic: 1, work: 0.25 }), { budget: 0.4 });
    expect(result.complexity).toBe(0.7);
    expect(result.tier).toBe("premium");
  });

  it("up-tiers at the exact high-band gate (complexity exactly 0.5)", () => {
    // 0.4 * 0.5 + 0.35 * 0.5 + 0.25 * 0.5 === 0.5 in float64
    const result = policy(scores({ prompt: 0.5, topic: 0.5, work: 0.5 }), {
      budget: 0.6,
    });
    expect(result.complexity).toBe(0.5);
    expect(result.tier).toBe("premium");
  });

  it("stays standard just below the mid-band gate", () => {
    const result = policy(scores({ prompt: 0.9, topic: 0.9, work: 0.2 }), { budget: 0.4 });
    expect(result.complexity).toBeLessThan(0.7);
    expect(result.tier).toBe("standard");
  });
});

describe("combinePolicy effort mapping", () => {
  it("economy: low, or medium at complexity >= 0.6", () => {
    expect(policy(scores(), { budget: 0 }).reasoningEffort).toBe("low");
    // 0.4 * 0 + 0.35 * 1 + 0.25 * 1 === 0.6 in float64
    const raised = policy(scores({ prompt: 1, topic: 1, work: 0 }), { budget: 0.1 });
    expect(raised.tier).toBe("economy");
    expect(raised.reasoningEffort).toBe("medium");
  });

  it("standard: medium, or high at complexity >= 0.6", () => {
    expect(policy(scores({ prompt: 0.4, topic: 0.4, work: 0.4 }), { budget: 0.4 }).reasoningEffort).toBe(
      "medium",
    );
    const raised = policy(scores({ prompt: 1, topic: 1, work: 0 }), { budget: 0.4 });
    expect(raised.tier).toBe("standard");
    expect(raised.reasoningEffort).toBe("high");
  });

  it("premium: high, xhigh at complexity >= 0.75", () => {
    const high = policy(scores({ prompt: 1, topic: 0.6, work: 0.6 }), { budget: 0.8 });
    expect(high.tier).toBe("premium");
    expect(high.reasoningEffort).toBe("high");
    // 0.4 * 0.75 + 0.35 * 0.75 + 0.25 * 0.75 === 0.75 in float64
    expect(
      policy(scores({ prompt: 0.75, topic: 0.75, work: 0.75 }), { budget: 0.8 })
        .reasoningEffort,
    ).toBe("xhigh");
  });

  it("premium: xhigh when topic risk hits the highest level (auth/security/migrations/infra)", () => {
    const result = policy(scores({ prompt: 0.5, topic: 1, work: 0.5 }), { budget: 0.8 });
    expect(result.tier).toBe("premium");
    expect(result.reasoningEffort).toBe("xhigh");
    expect(result.rationale).toContain("highest-risk topic → xhigh effort");
  });
});

describe("unknown budget default", () => {
  it("treats an absent budget as the conservative 0.4 mid band", () => {
    const result = policy(scores({ prompt: 1, topic: 1, work: 0.25 }));
    expect(result.tier).toBe("premium");
    const standard = policy(scores({ prompt: 0.4, topic: 0.4, work: 0.4 }));
    expect(standard.tier).toBe("standard");
  });

  it("never unlocks the high-band premium gate at complexity 0.5", () => {
    expect(policy(scores({ prompt: 0.5, topic: 0.5, work: 0.5 })).tier).toBe("standard");
  });
});

describe("degrade heuristics", () => {
  it("maps risk keywords to topic risk", () => {
    expect(degradeTopicRisk("add authentication tokens and session handling")).toBe(0.8);
    expect(degradeTopicRisk("run the database migration")).toBe(0.8);
    expect(degradeTopicRisk("tighten the schema security")).toBe(0.8);
    expect(degradeTopicRisk("rename the old API helpers")).toBe(0.5);
    expect(degradeTopicRisk("debug the failing test")).toBe(0.45);
    expect(degradeTopicRisk("add a small feature")).toBe(0.3);
  });

  it("maps prompt length to prompt complexity", () => {
    expect(degradePromptComplexity("x".repeat(800))).toBe(0.3);
    expect(degradePromptComplexity("x".repeat(801))).toBe(0.6);
  });

  it("maps file counts to work complexity", () => {
    expect(degradeWorkComplexity(1)).toBe(0.15);
    expect(degradeWorkComplexity(2)).toBe(0.35);
    expect(degradeWorkComplexity(8)).toBe(0.6);
    expect(degradeWorkComplexity(25)).toBe(0.8);
    expect(degradeWorkComplexity(100)).toBe(0.8);
  });

  it("flags degrade results with confidence 0.6 and heuristic", () => {
    const result = degradeModelScores(request({ prompt: "add auth token support" }));
    expect(result.value.topic).toBe(0.8);
    expect(result.confidence).toBe(0.6);
    expect(result.heuristic).toBe(true);
    expect(result.clientKind).toBe("degrade");
  });
});

describe("model selection question composition and mapping", () => {
  it("composes ONE request with exactly three score questions over the same state", () => {
    const composed = composeModelSelectionRequest(request({ prompt: "y".repeat(5000) }));
    expect(composed.state.prompt).toHaveLength(4000);
    expect(Object.keys(composed.questions).sort()).toEqual([
      "prompt_complexity",
      "topic_risk",
      "work_complexity",
    ]);
    for (const question of Object.values(composed.questions)) {
      expect(question.type).toBe("score");
    }
    expect(composed.state.repo_context.file_count).toBe(5);
    expect(composed.state.system_policy.length).toBeGreaterThan(0);
  });

  it("normalizes score levels and takes the minimum confidence", () => {
    const result = modelScoresFromAnswers({
      prompt_complexity: score(0, 0.9),
      topic_risk: score(2, 0.7),
      work_complexity: score(3, 0.8),
    });
    expect(result.value.prompt).toBe(0);
    expect(result.value.topic).toBe(0.5);
    expect(result.value.work).toBe(1);
    expect(result.confidence).toBe(0.7);
    expect(result.heuristic).toBe(false);
    expect(result.clientKind).toBe("typesafe");
  });
});

describe("selectModelForSession", () => {
  it("scores through a live client in one request and takes the minimum confidence", async () => {
    const calls: SystemOneRequestLike[] = [];
    const transport: TypeSafeTransport = {
      async systemOne(call) {
        calls.push(call);
        return {
          answers: {
            prompt_complexity: score(3, 0.9),
            topic_risk: score(4, 0.8),
            work_complexity: score(3, 0.7),
          },
        };
      },
    };
    const client = new TypeSafeClient({ transport, env: () => ({}) });
    const result = await selectModelForSession(
      request({ usageBudgetFraction: 0.9 }),
      { client },
    );
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]?.questions ?? {})).toHaveLength(3);
    expect(result.tier).toBe("premium");
    expect(result.reasoningEffort).toBe("xhigh");
    expect(result.confidence).toBe(0.7);
    expect(result.auto).toBe(true);
    expect(result.rationale).not.toContain("heuristic");
  });

  it("falls back to degrade heuristics when scoring fails", async () => {
    const client = new TypeSafeClient({
      transport: {
        async systemOne() {
          throw new Error("boom");
        },
      },
      env: () => ({}),
    });
    const result = await selectModelForSession(request(), { client });
    expect(result.confidence).toBe(0.6);
    expect(result.rationale).toContain("[heuristic]");
  });

  it("uses degrade heuristics with a DegradeClient", async () => {
    const result = await selectModelForSession(
      request({
        prompt: "add auth token handling",
        usageBudgetFraction: 0.9,
        repoContext: { fileCount: 30, totalBytes: 1, languages: [] },
      }),
      { client: new DegradeClient() },
    );
    expect(result.confidence).toBe(0.6);
    expect(result.rationale).toContain("[heuristic]");
    expect(result.tier).toBe("premium");
    expect(result.complexity.topic).toBe(0.8);
    expect(result.complexity.work).toBe(0.8);
  });

  it("maps the selected tier through the provided catalog", async () => {
    const catalog: ModelCatalog = {
      tiers: { economy: "mini-e", standard: "std-s", premium: "prem-p" },
    };
    const deps: ModelSelectionDeps = { catalog };
    const economy = await selectModelForSession(
      request({ usageBudgetFraction: 0.1 }),
      deps,
    );
    expect(economy.modelId).toBe("mini-e");
    const standard = await selectModelForSession(
      request({ usageBudgetFraction: 0.4 }),
      deps,
    );
    expect(standard.modelId).toBe("std-s");
    const premium = await selectModelForSession(
      request({
        prompt: "a".repeat(900),
        usageBudgetFraction: 0.9,
        repoContext: { fileCount: 25, totalBytes: 1, languages: [] },
      }),
      { ...deps, client: new DegradeClient() },
    );
    expect(premium.modelId).toBe("prem-p");
  });

  it("uses the default catalog model ids", async () => {
    const result = await selectModelForSession(request({ usageBudgetFraction: 0.1 }));
    expect(result.modelId).toBe("gpt-5.6-mini");
  });

  it("produces results that pass the contracts schema", async () => {
    const req = request({
      prompt: "rename the public API surface",
      usageBudgetFraction: 0.3,
      repoContext: { fileCount: 2, totalBytes: 0, languages: [] },
    });
    const result = await selectModelForSession(req, { client: new DegradeClient() });
    const parsed = ModelSelectionResultSchema.parse(result);
    expect(parsed.auto).toBe(true);
    expect(parsed.modelId).toBe("gpt-5.6-sol");
    expect(parsed.contextTokensEstimate).toBe(estimateContextTokens(req));
    for (const value of Object.values(parsed.probabilities)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("rejects schema-invalid requests", async () => {
    await expect(
      selectModelForSession(
        request({ usageBudgetFraction: 1.5 }),
        { client: new DegradeClient() },
      ),
    ).rejects.toThrow();
  });
});
