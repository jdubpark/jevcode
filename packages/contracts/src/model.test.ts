import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL_CATALOG,
  ModelCatalogSchema,
  ModelSelectionRequestSchema,
  ModelSelectionResultSchema,
} from "./model.js";

const baseRequest = {
  prompt: "Add rate limiting to the public API.",
  repoContext: { fileCount: 12, totalBytes: 512_000, languages: ["typescript"] },
};

const baseResult = {
  modelId: "gpt-5.6-sol",
  reasoningEffort: "medium",
  tier: "standard",
  auto: true,
  confidence: 0.9,
  rationale: "moderate budget and complexity → standard tier; moderate complexity → medium effort.",
  probabilities: { economy: 0.05, standard: 0.8, premium: 0.15 },
  contextTokensEstimate: 6_400,
  complexity: { prompt: 0.4, topic: 0.4, work: 0.4 },
};

describe("ModelSelectionRequestSchema", () => {
  it("parses a request without a usage budget", () => {
    expect(ModelSelectionRequestSchema.safeParse(baseRequest).success).toBe(true);
  });

  it("parses a request with a usage budget fraction", () => {
    expect(
      ModelSelectionRequestSchema.safeParse({ ...baseRequest, usageBudgetFraction: 0.3 })
        .success,
    ).toBe(true);
  });

  it("rejects usage budget fractions outside 0..1", () => {
    expect(
      ModelSelectionRequestSchema.safeParse({ ...baseRequest, usageBudgetFraction: 1.2 })
        .success,
    ).toBe(false);
    expect(
      ModelSelectionRequestSchema.safeParse({ ...baseRequest, usageBudgetFraction: -0.1 })
        .success,
    ).toBe(false);
  });

  it("rejects invalid repo context", () => {
    expect(
      ModelSelectionRequestSchema.safeParse({
        ...baseRequest,
        repoContext: { ...baseRequest.repoContext, fileCount: -1 },
      }).success,
    ).toBe(false);
    expect(
      ModelSelectionRequestSchema.safeParse({
        ...baseRequest,
        repoContext: { ...baseRequest.repoContext, fileCount: 1.5 },
      }).success,
    ).toBe(false);
    expect(
      ModelSelectionRequestSchema.safeParse({ ...baseRequest, prompt: "" }).success,
    ).toBe(false);
  });
});

describe("ModelSelectionResultSchema", () => {
  it("parses a full auto-selection result", () => {
    expect(ModelSelectionResultSchema.safeParse(baseResult).success).toBe(true);
  });

  it("rejects invalid enums and out-of-range values", () => {
    expect(
      ModelSelectionResultSchema.safeParse({ ...baseResult, tier: "luxury" }).success,
    ).toBe(false);
    expect(
      ModelSelectionResultSchema.safeParse({ ...baseResult, reasoningEffort: "max" })
        .success,
    ).toBe(false);
    expect(
      ModelSelectionResultSchema.safeParse({ ...baseResult, confidence: 1.5 }).success,
    ).toBe(false);
    expect(
      ModelSelectionResultSchema.safeParse({
        ...baseResult,
        probabilities: { premium: -0.2 },
      }).success,
    ).toBe(false);
    expect(
      ModelSelectionResultSchema.safeParse({
        ...baseResult,
        complexity: { prompt: 0.4, topic: 1.4, work: 0.4 },
      }).success,
    ).toBe(false);
    expect(
      ModelSelectionResultSchema.safeParse({ ...baseResult, auto: "yes" }).success,
    ).toBe(false);
  });
});

describe("ModelCatalogSchema", () => {
  it("parses the default catalog", () => {
    expect(ModelCatalogSchema.parse(DEFAULT_MODEL_CATALOG)).toEqual(DEFAULT_MODEL_CATALOG);
  });

  it("ships the expected default tier models", () => {
    expect(DEFAULT_MODEL_CATALOG.tiers.economy).toBe("gpt-5.6-mini");
    expect(DEFAULT_MODEL_CATALOG.tiers.standard).toBe("gpt-5.6-sol");
    expect(DEFAULT_MODEL_CATALOG.tiers.premium).toBe("gpt-5.6-luna");
  });

  it("accepts consumer catalog overrides", () => {
    const result = ModelCatalogSchema.safeParse({
      tiers: { economy: "mini", standard: "mid", premium: "max" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects catalogs with empty model ids", () => {
    expect(
      ModelCatalogSchema.safeParse({
        tiers: { economy: "", standard: "mid", premium: "max" },
      }).success,
    ).toBe(false);
  });
});
