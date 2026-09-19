import { describe, expect, it } from "vitest";

import {
  AnswerMappingError,
  mapAttention,
  mapProjection,
  normalizeScore,
  passAAnswersFrom,
  passBAnswersFrom,
  secondaryViewsFrom,
} from "./mapping.js";
import type { PassAAnswers } from "./mapping.js";
import type {
  ChoiceAnswer,
  NoulAnswer,
  ScoreAnswer,
} from "./types.js";
import { makeProjectionInput } from "./testing/inputs.js";

function choice(
  choiceValue: string,
  probabilities: Record<string, number>,
  confidence = 0.9,
): ChoiceAnswer {
  return { type: "choice", choice: choiceValue, confidence, probabilities };
}

function score(
  scoreValue: number,
  probabilities: Record<string, number>,
  confidence = 0.9,
): ScoreAnswer {
  return { type: "score", score: scoreValue, confidence, probabilities };
}

function noul(probability: number): NoulAnswer {
  return { type: "noul", noul: probability };
}

function passA(overrides: Partial<PassAAnswers> = {}): PassAAnswers {
  return {
    should_surface: noul(0.9),
    semantic_category: choice("architecture_change", {
      architecture_change: 0.72,
      dependency_change: 0.22,
      implementation_change: 0.06,
    }),
    importance: score(4, { "0": 0, "1": 0, "2": 0, "3": 0, "4": 1 }),
    relevance: score(3, { "0": 0, "1": 0, "2": 0, "3": 1, "4": 0 }),
    interruption: score(0, { "0": 1, "1": 0, "2": 0, "3": 0, "4": 0 }),
    mental_model_change: score(2, { "0": 0, "1": 0, "2": 1, "3": 0, "4": 0 }),
    scope: choice("subsystem", { local: 0.05, module: 0.2, subsystem: 0.7, repository: 0.05 }),
    human_decision: choice("none", { none: 0.8, optional: 0.1, recommended: 0.08, required: 0.02 }),
    needs_system2: noul(0.4),
    ...overrides,
  };
}

describe("normalizeScore", () => {
  it("maps level positions linearly to 0..1", () => {
    expect(normalizeScore(score(4, {}), 5)).toBe(1);
    expect(normalizeScore(score(0, {}), 5)).toBe(0);
    expect(normalizeScore(score(2, {}), 5)).toBe(0.5);
    expect(normalizeScore(score(3, {}), 4)).toBe(1);
  });

  it("supports fractional positions between levels", () => {
    expect(normalizeScore(score(1.3, {}), 5)).toBeCloseTo(0.325);
  });

  it("clamps out-of-range positions", () => {
    expect(normalizeScore(score(9, {}), 5)).toBe(1);
    expect(normalizeScore(score(-2, {}), 5)).toBe(0);
  });

  it("throws on invalid level counts or non-finite scores", () => {
    expect(() => normalizeScore(score(1, {}), 1)).toThrow(AnswerMappingError);
    expect(() => normalizeScore(score(Number.NaN, {}), 5)).toThrow(AnswerMappingError);
  });
});

describe("mapAttention", () => {
  it("maps a full Pass A answer set", () => {
    const result = mapAttention(passA());
    expect(result.shouldSurface).toBe(true);
    expect(result.semanticCategory).toBe("architecture_change");
    expect(result.importance).toBe(1);
    expect(result.relevance).toBe(0.75);
    expect(result.interruption).toBe(0);
    expect(result.mentalModelChange).toBe(0.5);
    expect(result.scope).toBe("subsystem");
    expect(result.humanDecision).toBe("none");
    expect(result.needsSystem2).toBe(false);
    expect(result.confidence).toBe(0.9);
    expect(result.probabilities).toEqual({
      architecture_change: 0.72,
      dependency_change: 0.22,
      implementation_change: 0.06,
    });
  });

  it("treats noul >= 0.5 as true, otherwise false", () => {
    expect(mapAttention(passA({ should_surface: noul(0.5) })).shouldSurface).toBe(true);
    expect(mapAttention(passA({ should_surface: noul(0.499) })).shouldSurface).toBe(false);
    expect(mapAttention(passA({ needs_system2: noul(0.51) })).needsSystem2).toBe(true);
  });

  it("rejects unknown category choices", () => {
    expect(() =>
      mapAttention(passA({ semantic_category: choice("not_a_kind", {}) })),
    ).toThrow(AnswerMappingError);
  });

  it("drops probability keys that are not semantic kinds", () => {
    const result = mapAttention(
      passA({
        semantic_category: choice("api_change", {
          api_change: 0.6,
          bogus: 0.4,
        }),
      }),
    );
    expect(result.probabilities.bogus).toBeUndefined();
  });

  it("floors non-finite confidences to 0 instead of leaking NaN", () => {
    const nan = mapAttention(
      passA({ semantic_category: choice("api_change", { api_change: 1 }, Number.NaN) }),
    );
    expect(nan.confidence).toBe(0);
    expect(nan.probabilities.api_change).toBe(1);

    const infinity = mapAttention(
      passA({
        semantic_category: choice(
          "api_change",
          { api_change: 1 },
          Number.POSITIVE_INFINITY,
        ),
      }),
    );
    expect(infinity.confidence).toBe(0);
  });
});

describe("passAAnswersFrom", () => {
  it("extracts prefixed answers for a unit key", () => {
    const raw = Object.fromEntries(
      Object.entries(passA()).map(([name, answer]) => [`u1:${name}`, answer]),
    );
    const extracted = passAAnswersFrom(raw, "u1");
    expect(extracted.semantic_category.choice).toBe("architecture_change");
  });

  it("throws on missing or mistyped answers", () => {
    expect(() => passAAnswersFrom({}, "u0")).toThrow(AnswerMappingError);
    expect(() =>
      passAAnswersFrom({ "u0:should_surface": noul(0.5) }, "u0"),
    ).toThrow(AnswerMappingError);
  });
});

describe("secondaryViewsFrom", () => {
  it("selects nouls >= 0.5 sorted by probability, capped at 3", () => {
    const views = secondaryViewsFrom({
      CodeDiff: noul(0.9),
      TestMatrix: noul(0.2),
      ExecutionTimeline: noul(0.7),
      DependencyDelta: noul(0.65),
      Terminal: noul(0.8),
    });
    expect(views).toEqual(["CodeDiff", "Terminal", "ExecutionTimeline"]);
  });

  it("returns [] when nothing crosses 0.5", () => {
    expect(secondaryViewsFrom({ CodeDiff: noul(0.1) })).toEqual([]);
  });
});

describe("mapProjection", () => {
  const input = makeProjectionInput({
    semanticCategory: "architecture_change",
  });

  it("maps representation, attention, density, and subjects", () => {
    const result = mapProjection(
      {
        representation: choice("diagram", { diagram: 0.8, table: 0.2 }),
        attention: choice("highlight", { highlight: 0.7, surface: 0.3 }),
        density: choice("compact", { compact: 0.6, normal: 0.4 }),
        show_evidence: noul(0.9),
        show_code: noul(0.1),
        secondary_views: { DependencyDelta: noul(0.8) },
      },
      input,
    );
    expect(result.representation).toBe("diagram");
    expect(result.attention).toBe("highlight");
    expect(result.density).toBe("compact");
    expect(result.showEvidence).toBe(true);
    expect(result.showCode).toBe(false);
    expect(result.subject).toBe("architecture");
    expect(result.secondaryViews).toEqual(["DependencyDelta"]);
    expect(result.confidence).toBe(0.9);
  });

  it("rejects unknown representation values", () => {
    expect(() =>
      mapProjection(
        {
          representation: choice("carousel", {}),
          attention: choice("surface", {}),
          density: choice("normal", {}),
          show_evidence: noul(0.5),
          show_code: noul(0.5),
          secondary_views: {},
        },
        input,
      ),
    ).toThrow(AnswerMappingError);
  });
});

describe("passBAnswersFrom", () => {
  it("extracts required answers and secondary view nouls", () => {
    const raw: Record<string, unknown> = {
      representation: choice("table", {}),
      attention: choice("surface", {}),
      density: choice("normal", {}),
      show_evidence: noul(0.9),
      show_code: noul(0.1),
      "secondary:CodeDiff": noul(0.8),
      "secondary:TestMatrix": noul(0.2),
    };
    const extracted = passBAnswersFrom(raw);
    expect(extracted.representation.choice).toBe("table");
    expect(extracted.secondary_views.CodeDiff?.noul).toBe(0.8);
    expect(extracted.secondary_views.TestMatrix?.noul).toBe(0.2);
  });

  it("throws when a required answer is missing", () => {
    expect(() => passBAnswersFrom({})).toThrow(AnswerMappingError);
  });
});
