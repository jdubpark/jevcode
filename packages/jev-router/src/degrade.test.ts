import { describe, expect, it } from "vitest";

import {
  DEGRADE_CONFIDENCE,
  DegradeClient,
  REPRESENTATION_BY_CATEGORY,
  degradeAttention,
  degradeCategory,
  degradeProjection,
} from "./degrade.js";
import { makeInput, makeProjectionInput } from "./testing/inputs.js";

describe("degradeCategory evidence-type map", () => {
  it("maps destructive commands to decision_candidate", () => {
    expect(
      degradeCategory(makeInput({ hints: { destructiveCommands: ["rm -rf x"] } })),
    ).toBe("decision_candidate");
  });

  it("maps security paths to security_change", () => {
    expect(
      degradeCategory(makeInput({ hints: { securityPaths: ["src/auth/a.ts"] } })),
    ).toBe("security_change");
  });

  it("maps schema paths to schema_change", () => {
    expect(
      degradeCategory(makeInput({ hints: { schemaPaths: ["migrations/1.sql"] } })),
    ).toBe("schema_change");
  });

  it("maps dependency changes to dependency_change", () => {
    expect(
      degradeCategory(
        makeInput({ hints: { dependencyChanges: [{ name: "zod", change: "added" }] } }),
      ),
    ).toBe("dependency_change");
  });

  it("maps public exports and interface changes to api_change", () => {
    expect(degradeCategory(makeInput({ hints: { publicExports: ["run"] } }))).toBe(
      "api_change",
    );
    expect(degradeCategory(makeInput({ hints: { interfacesChanged: 2 } }))).toBe(
      "api_change",
    );
  });

  it("maps failing tests to failure, passing tests to test_result", () => {
    expect(
      degradeCategory(
        makeInput({
          hints: {
            testResults: [
              { runner: "vitest", passed: 1, failed: 2, skipped: 0, failureFiles: ["tests/a.test.ts"] },
            ],
          },
        }),
      ),
    ).toBe("failure");
    expect(
      degradeCategory(
        makeInput({
          hints: {
            testResults: [
              { runner: "vitest", passed: 2, failed: 0, skipped: 0, failureFiles: [] },
            ],
          },
        }),
      ),
    ).toBe("test_result");
  });

  it("maps attached decisions to decision_candidate before security hints", () => {
    expect(
      degradeCategory(
        makeInput({
          files: ["src/auth/service.ts"],
          hints: {
            decisionIds: ["dec-1"],
            securityPaths: ["src/auth/service.ts"],
          },
        }),
      ),
    ).toBe("decision_candidate");
  });

  it("maps test-only units with in-unit failures to failure before security paths", () => {
    expect(
      degradeCategory(
        makeInput({
          files: ["tests/auth/oauth.test.ts"],
          hints: {
            securityPaths: ["tests/auth/oauth.test.ts"],
            testResults: [
              {
                runner: "vitest",
                passed: 1,
                failed: 1,
                skipped: 0,
                failureFiles: ["tests/auth/oauth.test.ts"],
              },
            ],
          },
        }),
      ),
    ).toBe("failure");
  });

  it("maps a strong architecture hint to architecture_change before dependency hints", () => {
    expect(
      degradeCategory(
        makeInput({
          categoryHint: "architecture",
          hints: { dependencyChanges: [{ name: "ioredis", change: "added" }] },
        }),
      ),
    ).toBe("architecture_change");
    expect(
      degradeCategory(
        makeInput({
          categoryHint: "dependency",
          hints: { dependencyChanges: [{ name: "zod", change: "added" }] },
        }),
      ),
    ).toBe("dependency_change");
  });

  it("maps behavior change evidence to behavior_change before failure", () => {
    expect(
      degradeCategory(
        makeInput({
          files: ["src/routes/users.ts", "tests/users.test.ts"],
          categoryHint: "api",
          hints: {
            behaviorChange: true,
            testResults: [
              {
                runner: "vitest",
                passed: 1,
                failed: 1,
                skipped: 0,
                failureFiles: ["tests/users.test.ts"],
              },
            ],
          },
        }),
      ),
    ).toBe("behavior_change");
  });

  it("maps behavior changes and falls back to implementation_change", () => {
    expect(degradeCategory(makeInput({ hints: { behaviorChange: true } }))).toBe(
      "behavior_change",
    );
    expect(degradeCategory(makeInput({}))).toBe("implementation_change");
  });
});

describe("PRD section 46 presentation mapping", () => {
  it("schema change → table / SchemaDelta", () => {
    expect(REPRESENTATION_BY_CATEGORY.schema_change).toEqual({
      representation: "table",
      view: "SchemaDelta",
    });
  });

  it("architecture change → diagram / ArchitectureDelta", () => {
    expect(REPRESENTATION_BY_CATEGORY.architecture_change).toEqual({
      representation: "diagram",
      view: "ArchitectureDelta",
    });
  });

  it("failure → failure / FailureAnalysis", () => {
    expect(REPRESENTATION_BY_CATEGORY.failure).toEqual({
      representation: "failure",
      view: "FailureAnalysis",
    });
  });

  it("decision → decision / Decision", () => {
    expect(REPRESENTATION_BY_CATEGORY.decision_candidate).toEqual({
      representation: "decision",
      view: "Decision",
    });
  });

  it("simple change → summary / ChangeOverview", () => {
    expect(REPRESENTATION_BY_CATEGORY.implementation_change).toEqual({
      representation: "summary",
      view: "ChangeOverview",
    });
  });

  it("dependency → graph / DependencyDelta", () => {
    expect(REPRESENTATION_BY_CATEGORY.dependency_change).toEqual({
      representation: "graph",
      view: "DependencyDelta",
    });
  });

  it("tests → table / TestMatrix", () => {
    expect(REPRESENTATION_BY_CATEGORY.test_result).toEqual({
      representation: "table",
      view: "TestMatrix",
    });
  });

  it("behavior → before_after / BehaviorDelta", () => {
    expect(REPRESENTATION_BY_CATEGORY.behavior_change).toEqual({
      representation: "before_after",
      view: "BehaviorDelta",
    });
  });
});

describe("degradeAttention", () => {
  it("always returns fixed confidence 0.6 with heuristic flag", () => {
    const result = degradeAttention(makeInput({}));
    expect(result.confidence).toBe(DEGRADE_CONFIDENCE);
    expect(result.heuristic).toBe(true);
    expect(result.clientKind).toBe("degrade");
    expect(result.value.confidence).toBe(DEGRADE_CONFIDENCE);
  });

  it("suppresses formatting-only input deterministically", () => {
    const result = degradeAttention(makeInput({ hints: { formattingOnly: true } }));
    expect(result.value.shouldSurface).toBe(false);
    expect(result.value.importance).toBe(0.05);
  });

  it("destructive input interrupts with a required decision", () => {
    const result = degradeAttention(
      makeInput({ hints: { destructiveCommands: ["DROP TABLE users"] } }),
    );
    expect(result.value.shouldSurface).toBe(true);
    expect(result.value.humanDecision).toBe("required");
    expect(result.value.interruption).toBeGreaterThanOrEqual(0.9);
  });

  it("schema input surfaces prominently without stopping (PRD triad shape)", () => {
    const result = degradeAttention(
      makeInput({
        files: ["migrations/1.sql"],
        hints: { schemaPaths: ["migrations/1.sql"], diffStats: { added: 4, removed: 0 } },
      }),
    );
    expect(result.value.shouldSurface).toBe(true);
    expect(result.value.humanDecision).toBe("none");
    expect(result.value.interruption).toBeLessThan(0.8);
    expect(result.value.semanticCategory).toBe("schema_change");
  });

  it("returns probabilities keyed by final clamped category", () => {
    const result = degradeAttention(
      makeInput({
        files: ["src/auth/x.ts"],
        hints: { securityPaths: ["src/auth/x.ts"] },
      }),
    );
    expect(result.probabilities?.security_change).toBeDefined();
    expect(result.value.probabilities.security_change).toBeDefined();
  });
});

describe("degradeProjection", () => {
  it("maps category to representation and secondary view", () => {
    const result = degradeProjection(
      makeProjectionInput({
        semanticCategory: "schema_change",
      }),
    );
    expect(result.value.representation).toBe("table");
    expect(result.value.secondaryViews).toContain("SchemaDelta");
    expect(result.value.subject).toBe("schema");
    expect(result.heuristic).toBe(true);
  });

  it("interrupts for required decisions", () => {
    const result = degradeProjection(
      makeProjectionInput({ humanDecision: "required" }),
    );
    expect(result.value.attention).toBe("interrupt");
    expect(result.value.renderMode).toBe("generic");
  });

  it("highlights when interruption is high", () => {
    const result = degradeProjection(
      makeProjectionInput({ interruption: 0.7 }),
    );
    expect(result.value.attention).toBe("highlight");
  });

  it("never throws on empty/neutral input", () => {
    expect(() => degradeProjection(makeProjectionInput())).not.toThrow();
  });
});

describe("DegradeClient", () => {
  it("returns [] for an empty batch", async () => {
    const client = new DegradeClient();
    expect(await client.attention([])).toEqual([]);
  });

  it("health is always degraded", async () => {
    const client = new DegradeClient();
    expect(await client.health()).toBe("degraded");
  });

  it("returns one result per input, aligned by order", async () => {
    const client = new DegradeClient();
    const results = await client.attention([
      makeInput({ changeUnitId: "cu-1", hints: { schemaPaths: ["migrations/1.sql"] } }),
      makeInput({ changeUnitId: "cu-2", hints: { formattingOnly: true } }),
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]?.value.semanticCategory).toBe("schema_change");
    expect(results[1]?.value.shouldSurface).toBe(false);
  });
});
