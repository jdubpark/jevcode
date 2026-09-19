import { describe, expect, it } from "vitest";

import {
  MAX_FILES,
  MAX_SYMBOLS,
  MAX_TASK_PROMPT_CHARS,
  attentionInputFromChangeUnit,
  collectAttentionHints,
  projectionInput,
  subjectFromCategory,
  truncateTaskPrompt,
} from "./state.js";
import type { SessionContext } from "./types.js";
import {
  commandFact,
  hunkFact,
  makeSymbolRef,
  makeUnit,
  symbolDeltaFact,
  testResultFact,
} from "./testing/inputs.js";

function ctx(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    sessionId: "sess-test-0001",
    taskPrompt: "Add rate limiting to the public API.",
    facts: [],
    ...overrides,
  };
}

describe("truncateTaskPrompt", () => {
  it("keeps prompts at or below the cap", () => {
    expect(truncateTaskPrompt("short")).toBe("short");
    expect(truncateTaskPrompt("x".repeat(MAX_TASK_PROMPT_CHARS))).toHaveLength(
      MAX_TASK_PROMPT_CHARS,
    );
  });

  it("truncates to exactly 4k chars with no suffix", () => {
    const result = truncateTaskPrompt("x".repeat(MAX_TASK_PROMPT_CHARS + 500));
    expect(result).toHaveLength(MAX_TASK_PROMPT_CHARS);
    expect(result).toBe("x".repeat(MAX_TASK_PROMPT_CHARS));
  });
});

describe("attentionInputFromChangeUnit caps", () => {
  it("caps files at 40 and symbols at 60", () => {
    const unit = makeUnit({
      files: Array.from({ length: 80 }, (_, i) => `src/f${i}.ts`),
      symbols: Array.from({ length: 100 }, (_, i) => makeSymbolRef(`sym${i}`)),
    });
    const input = attentionInputFromChangeUnit(unit, ctx(), 3);
    expect(input.files).toHaveLength(MAX_FILES);
    expect(input.symbols).toHaveLength(MAX_SYMBOLS);
  });

  it("caps the task prompt at 4k chars", () => {
    const input = attentionInputFromChangeUnit(
      makeUnit(),
      ctx({ taskPrompt: "y".repeat(10_000) }),
      3,
    );
    expect(input.taskPrompt).toHaveLength(MAX_TASK_PROMPT_CHARS);
  });

  it("requires the coordinator decisionVersion (no updatedAt fallback)", () => {
    const input = attentionInputFromChangeUnit(makeUnit(), ctx(), 42);
    expect(input.decisionVersion).toBe(42);
    const stale = makeUnit({
      updatedAt: "2026-09-18T09:00:05.000Z",
    });
    expect(attentionInputFromChangeUnit(stale, ctx(), 7).decisionVersion).toBe(7);
  });
});

describe("attentionInputFromChangeUnit hint derivation", () => {
  it("sums diff stats from hunks of unit files only", () => {
    const unit = makeUnit({ files: ["src/app.ts", "src/other.ts"] });
    const session = ctx({
      facts: [
        hunkFact("src/app.ts", { added: 10, removed: 2 }),
        hunkFact("src/other.ts", { added: 3, removed: 1 }),
        hunkFact("src/unrelated.ts", { added: 100, removed: 0 }),
      ],
    });
    const input = attentionInputFromChangeUnit(unit, session, 3);
    expect(input.hints.diffStats).toEqual({ added: 13, removed: 3 });
  });

  it("flags formatting-only and lockfile-only from hunks", () => {
    const unit = makeUnit({ files: ["a.ts", "b.ts"] });
    const formatting = attentionInputFromChangeUnit(unit, ctx({
      facts: [
        hunkFact("a.ts", { isFormattingOnly: true, added: 1, removed: 1 }),
        hunkFact("b.ts", { isFormattingOnly: true, added: 2, removed: 2 }),
      ],
    }), 3);
    expect(formatting.hints.formattingOnly).toBe(true);
    const mixed = attentionInputFromChangeUnit(unit, ctx({
      facts: [
        hunkFact("a.ts", { isFormattingOnly: true }),
        hunkFact("b.ts", { isFormattingOnly: false }),
      ],
    }), 3);
    expect(mixed.hints.formattingOnly).toBe(false);
  });

  it("collects destructive commands from facts and pattern matching", () => {
    const session = ctx({
      facts: [commandFact("rm -rf build", false), commandFact("pnpm test", false)],
    });
    const input = attentionInputFromChangeUnit(makeUnit(), session, 3);
    expect(input.hints.destructiveCommands).toEqual(["rm -rf build"]);
  });

  it("collects security and schema paths", () => {
    const unit = makeUnit({
      files: ["src/auth/login.ts", "migrations/001.sql", "src/app.ts"],
    });
    const input = attentionInputFromChangeUnit(unit, ctx(), 3);
    expect(input.hints.securityPaths).toEqual(["src/auth/login.ts"]);
    expect(input.hints.schemaPaths).toEqual(["migrations/001.sql"]);
  });

  it("computes public exports: exported in unit and imported outside", () => {
    const unit = makeUnit({ files: ["src/api.ts"] });
    const session = ctx({
      facts: [
        symbolDeltaFact("src/api.ts", {
          added: [{ name: "getUser", kind: "export", signature: "export const getUser", startLine: 1, endLine: 2 }],
          modified: [{ name: "internal", kind: "function", signature: "function internal", startLine: 3, endLine: 4 }],
        }),
        symbolDeltaFact("src/consumer.ts", {
          added: [{ name: "getUser", kind: "import", signature: 'import { getUser } from "./api"', startLine: 1, endLine: 1 }],
        }),
        symbolDeltaFact("src/other.ts", {
          added: [{ name: "unrelated", kind: "import", signature: 'import { unrelated } from "./api"', startLine: 1, endLine: 1 }],
        }),
      ],
    });
    const input = attentionInputFromChangeUnit(unit, session, 3);
    expect(input.hints.publicExports).toEqual(["getUser"]);
  });

  it("matches exported bindings against aliased imports via the import signature", () => {
    const unit = makeUnit({ files: ["src/api.ts"] });
    const session = ctx({
      facts: [
        symbolDeltaFact("src/api.ts", {
          added: [
            { name: "getUser", kind: "export", signature: "export const getUser", startLine: 1, endLine: 2 },
            { name: "createSession", kind: "export", signature: "export const createSession", startLine: 4, endLine: 5 },
          ],
        }),
        symbolDeltaFact("src/consumer.ts", {
          added: [
            { name: "fetchUser", kind: "import", signature: 'import { getUser as fetchUser } from "./api"', startLine: 1, endLine: 1 },
          ],
        }),
      ],
    });
    const input = attentionInputFromChangeUnit(unit, session, 3);
    expect(input.hints.publicExports).toEqual(["getUser"]);
  });

  it("ignores export-star specifier pseudo-names and unit-local imports", () => {
    const unit = makeUnit({ files: ["src/api.ts"] });
    const session = ctx({
      facts: [
        symbolDeltaFact("src/api.ts", {
          added: [
            { name: "./everything", kind: "export", signature: 'export * from "./everything"', startLine: 1, endLine: 1 },
            { name: "localOnly", kind: "export", signature: "export const localOnly", startLine: 2, endLine: 3 },
          ],
        }),
        symbolDeltaFact("src/api.ts", {
          added: [
            { name: "localOnly", kind: "import", signature: 'import { localOnly } from "./sibling"', startLine: 1, endLine: 1 },
          ],
        }),
        symbolDeltaFact("src/consumer.ts", {
          added: [
            { name: "./everything", kind: "import", signature: 'import "./everything"', startLine: 1, endLine: 1 },
          ],
        }),
      ],
    });
    const input = attentionInputFromChangeUnit(unit, session, 3);
    expect(input.hints.publicExports).toEqual([]);
  });

  it("collects test results, dependency changes, and decision ids", () => {
    const unit = makeUnit({
      files: ["package.json", "src/app.ts"],
      relatedDecisions: ["dec-1"],
    });
    const session = ctx({
      facts: [
        testResultFact({ passed: 4, failed: 1 }),
        {
          type: "dependency_change",
          repoId: "repo-test",
          sessionId: "sess-test-0001",
          ts: "2026-09-18T09:00:04.000Z",
          manifest: "package.json",
          added: [{ name: "ioredis", version: "5.4.1" }],
          removed: [],
        },
      ],
      decisionsForUnit: { [unit.id]: ["dec-2"] },
    });
    const input = attentionInputFromChangeUnit(unit, session, 3);
    expect(input.hints.testResults).toHaveLength(1);
    expect(input.hints.testResults[0]?.failed).toBe(1);
    expect(input.hints.dependencyChanges).toEqual([{ name: "ioredis", change: "added" }]);
    expect(input.hints.decisionIds.sort()).toEqual(["dec-1", "dec-2"]);
  });

  it("attributes failing test results to units containing the failing file", () => {
    const failing = makeUnit({ files: ["tests/auth/oauth.test.ts"] });
    const other = makeUnit({ id: "cu-other", files: ["src/app.ts"] });
    const session = ctx({
      facts: [
        testResultFact({
          passed: 14,
          failed: 1,
          failures: [
            {
              file: "tests/auth/oauth.test.ts",
              testName: "links an identity",
              message: "boom",
            },
          ],
        }),
      ],
    });
    const failingInput = attentionInputFromChangeUnit(failing, session, 3);
    const otherInput = attentionInputFromChangeUnit(other, session, 3);
    expect(failingInput.hints.testResults).toHaveLength(1);
    expect(failingInput.hints.testResults[0]?.failureFiles).toEqual([
      "tests/auth/oauth.test.ts",
    ]);
    expect(otherInput.hints.testResults).toHaveLength(0);
  });

  it("attaches passing test results only to units with test files", () => {
    const testUnit = makeUnit({ files: ["tests/rate-limit.test.ts"] });
    const codeUnit = makeUnit({ id: "cu-code", files: ["src/app.ts"] });
    const session = ctx({
      facts: [testResultFact({ passed: 42, failed: 0 })],
    });
    const testInput = attentionInputFromChangeUnit(testUnit, session, 3);
    const codeInput = attentionInputFromChangeUnit(codeUnit, session, 3);
    expect(testInput.hints.testResults).toHaveLength(1);
    expect(codeInput.hints.testResults).toHaveLength(0);
  });

  it("carries the auto-collapse preference", () => {
    const input = attentionInputFromChangeUnit(
      makeUnit(),
      ctx({ autoCollapsePassingTests: true }),
      3,
    );
    expect(input.hints.autoCollapsePassingTests).toBe(true);
  });
});

describe("collectAttentionHints", () => {
  it("derives every evidence field from files + facts (shared with evals)", () => {
    const facts: Parameters<typeof collectAttentionHints>[1] = [
      hunkFact("src/app.ts", { added: 5, removed: 3 }),
      commandFact("rm -rf build", false),
      symbolDeltaFact("src/app.ts", {
        added: [{ name: "run", kind: "export", signature: "export const run", startLine: 1, endLine: 1 }],
      }),
      symbolDeltaFact("src/other.ts", {
        added: [{ name: "run", kind: "import", signature: 'import { run } from "./app"', startLine: 1, endLine: 1 }],
      }),
      testResultFact({ passed: 3, failed: 0 }),
    ];
    const hints = collectAttentionHints(["src/app.ts", "src/auth/login.ts"], facts);
    expect(hints.diffStats).toEqual({ added: 5, removed: 3 });
    expect(hints.destructiveCommands).toEqual(["rm -rf build"]);
    expect(hints.securityPaths).toEqual(["src/auth/login.ts"]);
    expect(hints.publicExports).toEqual(["run"]);
    expect(hints.testResults).toHaveLength(0);
  });

  it("matches the pipeline derivation for the same unit", () => {
    const unit = makeUnit({ files: ["src/app.ts", "src/auth/login.ts"] });
    const session = ctx({
      facts: [hunkFact("src/app.ts", { added: 5, removed: 3 })],
    });
    const routed = attentionInputFromChangeUnit(unit, session, 3);
    const shared = collectAttentionHints(unit.files, session.facts);
    for (const key of Object.keys(shared) as (keyof typeof shared)[]) {
      expect(routed.hints[key]).toEqual(shared[key]);
    }
  });
});

describe("projectionInput", () => {
  it("extends the attention input with the attention decision", () => {
    const input = projectionInput(
      makeUnit(),
      {
        shouldSurface: true,
        importance: 0.8,
        relevance: 0.7,
        interruption: 0.1,
        mentalModelChange: 0.5,
        semanticCategory: "dependency_change",
        scope: "module",
        humanDecision: "none",
        needsSystem2: false,
        confidence: 0.9,
        probabilities: { dependency_change: 0.9 },
      },
      ctx(),
      3,
    );
    expect(input.attention.semanticCategory).toBe("dependency_change");
    expect(input.changeUnitId).toBe("cu-test-0001");
  });
});

describe("subjectFromCategory", () => {
  it("maps every semantic kind to a UIIntent subject", () => {
    expect(subjectFromCategory("behavior_change")).toBe("behavior");
    expect(subjectFromCategory("architecture_change")).toBe("architecture");
    expect(subjectFromCategory("api_change")).toBe("api");
    expect(subjectFromCategory("schema_change")).toBe("schema");
    expect(subjectFromCategory("dependency_change")).toBe("dependency");
    expect(subjectFromCategory("security_change")).toBe("security");
    expect(subjectFromCategory("test_result")).toBe("tests");
    expect(subjectFromCategory("failure")).toBe("tests");
    expect(subjectFromCategory("decision_candidate")).toBe("decision");
    expect(subjectFromCategory("implementation_change")).toBe("code");
  });
});
