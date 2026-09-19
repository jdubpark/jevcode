import { describe, expect, it } from "vitest";

import type { AttentionDecision } from "@jevcode/contracts";
import type { AttentionInput } from "./types.js";

import {
  DESTRUCTIVE_INTERRUPTION_FLOOR,
  REQUIRED_DECISION_INTERRUPTION_FLOOR,
  clampAttention,
  clampProjection,
  hasSurfaceFloor,
  isSuppressed,
  preClampAttention,
} from "./guardrails.js";
import {
  isDestructiveCommand,
  isSchemaPath,
  isSecurityPath,
} from "./patterns.js";
import { classifyDestructive, isDestructiveCommand as contractsIsDestructiveCommand } from "@jevcode/contracts";
import { makeInput, makeProjectionInput } from "./testing/inputs.js";

const MODEL_BASELINE: AttentionDecision = {
  shouldSurface: true,
  importance: 0.5,
  relevance: 0.5,
  interruption: 0.1,
  mentalModelChange: 0.4,
  semanticCategory: "implementation_change",
  scope: "module",
  humanDecision: "none",
  needsSystem2: false,
  confidence: 0.8,
  probabilities: { implementation_change: 0.8 },
};

describe("destructive command patterns", () => {
  const destructive = [
    "rm -rf node_modules",
    "rm -Rf node_modules",
    "rm -RF node_modules",
    "rm -r -f node_modules",
    "git push --force origin main",
    "git push -f",
    "git reset --hard HEAD~1",
    "DROP TABLE users",
    "TRUNCATE sessions",
    "DELETE FROM users WHERE id = 1",
    "pnpm db:reset",
    "prisma migrate down",
    "knex migrate:down",
  ];
  const safe = [
    "rm README.md",
    "rm -f /tmp/cache.db",
    "rm -r src/old",
    "git push --force-with-lease origin main",
    "git push origin main",
    "git reset HEAD~1",
    "npm test",
    "knex migrate:rollback",
  ];

  it.each(destructive)("flags %s", (command) => {
    expect(isDestructiveCommand(command)).toBe(true);
  });

  it.each(safe)("does not flag %s", (command) => {
    expect(isDestructiveCommand(command)).toBe(false);
  });

  it("stays in parity with the contracts classifier over a shared corpus", () => {
    const corpus = [
      "rm -rf build",
      "rm -Rf build",
      "rm -RF build",
      "rm -f build",
      "rm -r build",
      "rm build/file.ts",
      "git push --force origin main",
      "git push -f",
      "git push --force-with-lease origin main",
      "git push origin main",
      "git reset --hard HEAD~1",
      "git reset HEAD~1",
      "DROP TABLE users",
      "drop table users",
      "TRUNCATE sessions",
      "TRUNCATE TABLE sessions",
      "DELETE FROM users",
      "delete from users",
      "pnpm db:reset",
      "prisma migrate down",
      "knex migrate:down",
      "npm run migrate:up",
      "npm test",
    ];
    for (const command of corpus) {
      expect(isDestructiveCommand(command), command).toBe(
        contractsIsDestructiveCommand(command),
      );
      expect(isDestructiveCommand(command), command).toBe(
        classifyDestructive(command),
      );
    }
    expect(isDestructiveCommand).toBe(contractsIsDestructiveCommand);
  });
});

describe("security and schema path patterns", () => {
  it("flags auth, session, token, oauth, .env, permissions, access-control paths", () => {
    for (const path of [
      "src/auth/login.ts",
      "src/session/store.ts",
      "lib/tokens/refresh.ts",
      "src/oauth/google.ts",
      ".env",
      ".env.local",
      "src/rbac/permissions.ts",
      "src/access-control.ts",
    ]) {
      expect(isSecurityPath(path), path).toBe(true);
    }
  });

  it("flags migrations, prisma, schema.sql, .prisma paths", () => {
    for (const path of [
      "migrations/001_alter_users.sql",
      "prisma/schema.prisma",
      "db/schema.sql",
      "src/prisma/client.prisma",
    ]) {
      expect(isSchemaPath(path), path).toBe(true);
    }
  });

  it("does not flag unrelated paths", () => {
    expect(isSecurityPath("src/app.ts")).toBe(false);
    expect(isSchemaPath("src/app.ts")).toBe(false);
  });
});

describe("pre-clamp: rule 5 suppression (PRD section 34 formatting example)", () => {
  it("suppresses formatting-only diffs", () => {
    const input = makeInput({ hints: { formattingOnly: true } });
    const pre = preClampAttention(input);
    expect(pre.forced.shouldSurface).toBe(false);
    expect(pre.clamps).toContain("suppress_formatting");
  });

  it("suppresses lockfile-only diffs", () => {
    const input = makeInput({
      files: ["pnpm-lock.yaml"],
      hints: { lockfileOnly: true },
    });
    const pre = preClampAttention(input);
    expect(pre.forced.shouldSurface).toBe(false);
    expect(pre.clamps).toContain("suppress_lockfile");
  });

  it("suppresses passing-only test results when auto-collapse is on", () => {
    const input = makeInput({
      hints: {
        testResults: [{ runner: "vitest", passed: 12, failed: 0, skipped: 0, failureFiles: [] }],
        autoCollapsePassingTests: true,
        diffStats: { added: 0, removed: 0 },
      },
    });
    const pre = preClampAttention(input);
    expect(pre.forced.shouldSurface).toBe(false);
    expect(pre.clamps).toContain("suppress_passing_tests");
  });

  it("does not suppress passing tests when the preference is off", () => {
    const input = makeInput({
      hints: {
        testResults: [{ runner: "vitest", passed: 12, failed: 0, skipped: 0, failureFiles: [] }],
        autoCollapsePassingTests: false,
        diffStats: { added: 0, removed: 0 },
      },
    });
    expect(preClampAttention(input).forced.shouldSurface).toBeUndefined();
  });
});

describe("pre-clamp: surface floors (rules 1-4)", () => {
  it("destructive command forces surface + required decision + interruption floor", () => {
    const input = makeInput({
      hints: { destructiveCommands: ["rm -rf build"] },
    });
    const pre = preClampAttention(input);
    expect(pre.forced.shouldSurface).toBe(true);
    expect(pre.forced.humanDecision).toBe("required");
    expect(pre.forced.interruption).toBeGreaterThanOrEqual(
      DESTRUCTIVE_INTERRUPTION_FLOOR,
    );
    expect(pre.clamps).toContain("destructive_command");
  });

  it("security path forces surface and security category", () => {
    const input = makeInput({
      files: ["src/auth/login.ts"],
      hints: { securityPaths: ["src/auth/login.ts"] },
    });
    const pre = preClampAttention(input);
    expect(pre.forced.shouldSurface).toBe(true);
    expect(pre.forced.semanticCategory).toBe("security_change");
    expect(pre.clamps).toContain("security_path");
  });

  it("schema file forces a surface floor only", () => {
    const input = makeInput({
      files: ["migrations/001_alter_users.sql"],
      hints: { schemaPaths: ["migrations/001_alter_users.sql"] },
    });
    const pre = preClampAttention(input);
    expect(pre.forced.shouldSurface).toBe(true);
    expect(pre.forced.semanticCategory).toBeUndefined();
    expect(pre.clamps).toContain("schema_floor");
  });

  it("public export forces surface and api_change candidate", () => {
    const input = makeInput({ hints: { publicExports: ["getUser"] } });
    const pre = preClampAttention(input);
    expect(pre.forced.shouldSurface).toBe(true);
    expect(pre.forced.semanticCategory).toBe("api_change");
    expect(pre.clamps).toContain("public_api");
  });

  it("security category wins over api when both apply", () => {
    const input = makeInput({
      files: ["src/auth/login.ts"],
      hints: {
        securityPaths: ["src/auth/login.ts"],
        publicExports: ["getUser"],
      },
    });
    const pre = preClampAttention(input);
    expect(pre.forced.semanticCategory).toBe("security_change");
  });

  it("surface floors beat suppression (formatting-only security file still surfaces)", () => {
    const input = makeInput({
      files: ["src/auth/login.ts"],
      hints: {
        securityPaths: ["src/auth/login.ts"],
        formattingOnly: true,
      },
    });
    const pre = preClampAttention(input);
    expect(pre.forced.shouldSurface).toBe(true);
    expect(pre.clamps).not.toContain("suppress_formatting");
  });
});

describe("pre-clamp: rule 6 interrupt floor and rule 7 failed-unit relevance floor", () => {
  it("raises interruption to at least 0.8 for required decisions", () => {
    const input = makeInput({
      hints: { destructiveCommands: ["git reset --hard"] },
    });
    const pre = preClampAttention(input);
    expect(pre.forced.interruption).toBeGreaterThanOrEqual(
      REQUIRED_DECISION_INTERRUPTION_FLOOR,
    );
    expect(pre.clamps).toContain("interrupt_floor");
  });

  it("marks failed units for the relevance floor without forcing a value", () => {
    const input = makeInput({ status: "failed" });
    const pre = preClampAttention(input);
    expect(pre.forced.relevance).toBeUndefined();
    expect(pre.clamps).toContain("failed_unit_relevance");
  });
});

describe("post-clamp: PRD section 34 triads", () => {
  it("formatting: model surfacing is clamped to suppressed", () => {
    const input = makeInput({ hints: { formattingOnly: true } });
    const model: AttentionDecision = {
      ...MODEL_BASELINE,
      shouldSurface: true,
      importance: 0.5,
    };
    const { value, clamps } = clampAttention(input, model);
    expect(value.shouldSurface).toBe(false);
    expect(clamps).toContain("suppress_formatting");
  });

  it("migration triad 0.96/0.88/0.10: surface floor, scores untouched, no stop", () => {
    const input = makeInput({
      files: ["migrations/001_alter_users.sql"],
      hints: { schemaPaths: ["migrations/001_alter_users.sql"] },
    });
    const model: AttentionDecision = {
      ...MODEL_BASELINE,
      shouldSurface: false,
      importance: 0.96,
      relevance: 0.88,
      interruption: 0.1,
    };
    const { value, clamps } = clampAttention(input, model);
    expect(value.shouldSurface).toBe(true);
    expect(value.importance).toBe(0.96);
    expect(value.relevance).toBe(0.88);
    expect(value.interruption).toBe(0.1);
    expect(value.humanDecision).toBe("none");
    expect(clamps).toContain("schema_floor");
    expect(clamps).not.toContain("interrupt_floor");
  });

  it("destructive triad: required decision, interruption at least 0.9", () => {
    const input = makeInput({
      hints: { destructiveCommands: ["rm -rf build"] },
    });
    const model: AttentionDecision = {
      ...MODEL_BASELINE,
      importance: 0.99,
      relevance: 0.99,
      interruption: 0.98,
    };
    const { value, clamps } = clampAttention(input, model);
    expect(value.shouldSurface).toBe(true);
    expect(value.humanDecision).toBe("required");
    expect(value.interruption).toBeGreaterThanOrEqual(0.9);
    expect(value.interruption).toBe(0.98);
    expect(clamps).toContain("destructive_command");
  });

  it("dependency triad 0.72/0.81/0.08 passes through unchanged", () => {
    const input = makeInput({
      files: ["package.json"],
      hints: {
        dependencyChanges: [{ name: "ioredis", change: "added" }],
        diffStats: { added: 6, removed: 2 },
      },
    });
    const model: AttentionDecision = {
      ...MODEL_BASELINE,
      shouldSurface: true,
      importance: 0.72,
      relevance: 0.81,
      interruption: 0.08,
      semanticCategory: "dependency_change",
    };
    const { value, clamps } = clampAttention(input, model);
    expect(value).toEqual(model);
    expect(clamps).toEqual([]);
  });

  it("interrupt floor: model-said required with low interruption is raised to 0.8", () => {
    const input = makeInput({});
    const model: AttentionDecision = {
      ...MODEL_BASELINE,
      humanDecision: "required",
      interruption: 0.2,
    };
    const { value } = clampAttention(input, model);
    expect(value.interruption).toBeGreaterThanOrEqual(0.8);
    expect(value.interruption).toBe(0.8);
  });

  it("failed unit: model-said low relevance is floored", () => {
    const input = makeInput({ status: "failed" });
    const model: AttentionDecision = { ...MODEL_BASELINE, relevance: 0.05 };
    const { value } = clampAttention(input, model);
    expect(value.relevance).toBeGreaterThanOrEqual(0.5);
  });

  it("failed unit: high model relevance is preserved, not forced down", () => {
    const input = makeInput({ status: "failed" });
    const model: AttentionDecision = { ...MODEL_BASELINE, relevance: 0.9 };
    const { value } = clampAttention(input, model);
    expect(value.relevance).toBe(0.9);
  });

  it("security clamp overrides model category for non-test files only", () => {
    const input = makeInput({
      files: ["src/oauth/google.ts"],
      hints: { securityPaths: ["src/oauth/google.ts"] },
    });
    const model: AttentionDecision = {
      ...MODEL_BASELINE,
      shouldSurface: false,
      semanticCategory: "implementation_change",
    };
    const { value } = clampAttention(input, model);
    expect(value.shouldSurface).toBe(true);
    expect(value.semanticCategory).toBe("security_change");
  });

  it("security clamp keeps surface floor but not category for test-only files", () => {
    const input = makeInput({
      files: ["tests/auth/oauth.test.ts"],
      hints: { securityPaths: ["tests/auth/oauth.test.ts"] },
    });
    const model: AttentionDecision = {
      ...MODEL_BASELINE,
      shouldSurface: false,
      semanticCategory: "implementation_change",
    };
    const { value } = clampAttention(input, model);
    expect(value.shouldSurface).toBe(true);
    expect(value.semanticCategory).toBe("implementation_change");
  });

  it("security clamp does not override a decision-linked category", () => {
    const input = makeInput({
      files: ["src/auth/service.ts"],
      hints: {
        securityPaths: ["src/auth/service.ts"],
        decisionIds: ["dec-1"],
      },
    });
    const model: AttentionDecision = {
      ...MODEL_BASELINE,
      shouldSurface: false,
      semanticCategory: "decision_candidate",
    };
    const { value } = clampAttention(input, model);
    expect(value.shouldSurface).toBe(true);
    expect(value.semanticCategory).toBe("decision_candidate");
  });

  it("sanitizes out-of-range scores and unknown probability keys", () => {
    const input = makeInput({});
    const model: AttentionDecision = {
      ...MODEL_BASELINE,
      importance: 2.5,
      relevance: -1,
      probabilities: {
        implementation_change: 0.8,
        not_a_kind: 0.2,
      },
    };
    const { value } = clampAttention(input, model);
    expect(value.importance).toBe(1);
    expect(value.relevance).toBe(0);
    expect(value.probabilities.not_a_kind).toBeUndefined();
  });
});

describe("isSuppressed and hasSurfaceFloor", () => {
  it("reports reason for each suppression class", () => {
    expect(isSuppressed(makeInput({ hints: { formattingOnly: true } })).reason).toBe(
      "formatting",
    );
    expect(isSuppressed(makeInput({ hints: { lockfileOnly: true } })).reason).toBe(
      "lockfile",
    );
    expect(
      isSuppressed(
        makeInput({
          hints: {
            testResults: [{ runner: "vitest", passed: 1, failed: 0, skipped: 0, failureFiles: [] }],
            autoCollapsePassingTests: true,
          },
        }),
      ).reason,
    ).toBe("passing_tests");
    expect(isSuppressed(makeInput({})).suppressed).toBe(false);
  });

  it("does not suppress passing tests when the unit also has diff line changes", () => {
    const withDiff = makeInput({
      hints: {
        testResults: [{ runner: "vitest", passed: 8, failed: 0, skipped: 0, failureFiles: [] }],
        autoCollapsePassingTests: true,
        diffStats: { added: 6, removed: 2 },
      },
    });
    expect(isSuppressed(withDiff).reason).toBeNull();
    const withAddedOnly = makeInput({
      hints: {
        testResults: [{ runner: "vitest", passed: 8, failed: 0, skipped: 0, failureFiles: [] }],
        autoCollapsePassingTests: true,
        diffStats: { added: 1, removed: 0 },
      },
    });
    expect(isSuppressed(withAddedOnly).reason).toBeNull();
  });

  it("reports surface floors", () => {
    expect(hasSurfaceFloor(makeInput({ hints: { schemaPaths: ["a.sql"] } }))).toBe(true);
    expect(hasSurfaceFloor(makeInput({}))).toBe(false);
  });
});

describe("clampProjection", () => {
  it("raises background to surface for failed units", () => {
    const input = makeProjectionInput({}, { status: "failed" });
    const { value, clamps } = clampProjection(input, {
      attention: "background",
      subject: "code",
      representation: "summary",
      density: "normal",
      confidence: 0.8,
      showEvidence: false,
      showCode: false,
      secondaryViews: [],
      renderMode: "generic",
    });
    expect(value.attention).toBe("surface");
    expect(clamps).toContain("failed_unit_attention");
  });

  it("raises attention to interrupt when a decision is required", () => {
    const input = makeProjectionInput({ humanDecision: "required" });
    const { value, clamps } = clampProjection(input, {
      attention: "surface",
      subject: "decision",
      representation: "decision",
      density: "normal",
      confidence: 0.8,
      showEvidence: true,
      showCode: false,
      secondaryViews: [],
      renderMode: "generic",
    });
    expect(value.attention).toBe("interrupt");
    expect(clamps).toContain("required_decision_attention");
  });

  it("leaves surface attention untouched for normal units", () => {
    const input = makeProjectionInput();
    const { value, clamps } = clampProjection(input, {
      attention: "surface",
      subject: "code",
      representation: "summary",
      density: "normal",
      confidence: 0.8,
      showEvidence: false,
      showCode: false,
      secondaryViews: [],
      renderMode: "generic",
    });
    expect(value.attention).toBe("surface");
    expect(clamps).toEqual([]);
  });
});

describe("noise triad cap", () => {
  const baseInput = (overrides: Partial<AttentionInput["hints"]>): AttentionInput =>
    ({
      changeUnitId: "u1",
      decisionVersion: 1,
      sessionId: "s",
      title: "t",
      categoryHint: "implementation",
      status: "in_progress",
      files: ["x.ts"],
      symbols: [],
      taskPrompt: "",
      hints: {
        diffStats: { added: 0, removed: 0 },
        formattingOnly: false,
        lockfileOnly: false,
        configOnly: false,
        destructiveCommands: [],
        securityPaths: [],
        schemaPaths: [],
        publicExports: [],
        dependencyChanges: [],
        testResults: [],
        behaviorChange: false,
        interfacesChanged: 0,
        decisionIds: [],
        autoCollapsePassingTests: false,
        ...overrides,
      },
      createdAt: "x",
    }) as AttentionInput;

  it("caps the triad for formatting-only units", () => {
    const result = clampAttention(baseInput({ formattingOnly: true }), {
      shouldSurface: true,
      importance: 0.9,
      relevance: 0.8,
      interruption: 0.7,
      mentalModelChange: 0.6,
      semanticCategory: "implementation_change",
      scope: "local",
      humanDecision: "none",
      needsSystem2: false,
      confidence: 0.9,
      probabilities: {},
    });
    expect(result.value.shouldSurface).toBe(false);
    expect(result.value.importance).toBeLessThanOrEqual(0.05);
    expect(result.value.relevance).toBeLessThanOrEqual(0.05);
    expect(result.value.interruption).toBeLessThanOrEqual(0.02);
    expect(result.value.mentalModelChange).toBeLessThanOrEqual(0.05);
    expect(result.clamps).toContain("noise_triad_cap_formatting");
  });

  it("caps the triad for lockfile-only units", () => {
    const result = clampAttention(baseInput({ lockfileOnly: true }), {
      shouldSurface: true,
      importance: 0.48,
      relevance: 0.8,
      interruption: 0.1,
      mentalModelChange: 0.28,
      semanticCategory: "implementation_change",
      scope: "local",
      humanDecision: "none",
      needsSystem2: false,
      confidence: 0.9,
      probabilities: {},
    });
    expect(result.value.shouldSurface).toBe(false);
    expect(result.value.importance).toBeLessThanOrEqual(0.05);
    expect(result.value.relevance).toBeLessThanOrEqual(0.05);
    expect(result.clamps).toContain("noise_triad_cap_lockfile");
  });

  it("does not cap non-noise units", () => {
    const result = clampAttention(baseInput({}), {
      shouldSurface: true,
      importance: 0.72,
      relevance: 0.81,
      interruption: 0.08,
      mentalModelChange: 0.45,
      semanticCategory: "dependency_change",
      scope: "module",
      humanDecision: "none",
      needsSystem2: false,
      confidence: 0.94,
      probabilities: {},
    });
    expect(result.value.importance).toBe(0.72);
    expect(result.value.relevance).toBe(0.81);
  });
});

describe("decision presence floor", () => {
  it("floors importance/relevance/interruption for units with pending decisions", () => {
    const input = {
      changeUnitId: "u1",
      decisionVersion: 1,
      sessionId: "s",
      title: "Account-linking policy",
      categoryHint: "security",
      status: "in_progress",
      files: ["src/auth/service.ts"],
      symbols: [],
      taskPrompt: "",
      hints: {
        diffStats: { added: 0, removed: 0 },
        formattingOnly: false,
        lockfileOnly: false,
        configOnly: false,
        destructiveCommands: [],
        securityPaths: [],
        schemaPaths: [],
        publicExports: [],
        dependencyChanges: [],
        testResults: [],
        behaviorChange: false,
        interfacesChanged: 0,
        decisionIds: ["d1"],
        autoCollapsePassingTests: false,
      },
      createdAt: "x",
    } as AttentionInput;
    const result = clampAttention(input, {
      shouldSurface: true,
      importance: 0.06,
      relevance: 0.04,
      interruption: 0.01,
      mentalModelChange: 0.2,
      semanticCategory: "implementation_change",
      scope: "local",
      humanDecision: "none",
      needsSystem2: false,
      confidence: 0.8,
      probabilities: {},
    });
    expect(result.value.importance).toBeGreaterThanOrEqual(0.85);
    expect(result.value.relevance).toBeGreaterThanOrEqual(0.85);
    expect(result.value.interruption).toBeGreaterThanOrEqual(0.5);
    expect(result.clamps).toContain("decision_presence_floor");
  });

  it("does not floor units without decisions", () => {
    const input = {
      changeUnitId: "u2",
      decisionVersion: 1,
      sessionId: "s",
      title: "t",
      categoryHint: "implementation",
      status: "in_progress",
      files: ["src/a.ts"],
      symbols: [],
      taskPrompt: "",
      hints: {
        diffStats: { added: 0, removed: 0 },
        formattingOnly: false,
        lockfileOnly: false,
        configOnly: false,
        destructiveCommands: [],
        securityPaths: [],
        schemaPaths: [],
        publicExports: [],
        dependencyChanges: [],
        testResults: [],
        behaviorChange: false,
        interfacesChanged: 0,
        decisionIds: [],
        autoCollapsePassingTests: false,
      },
      createdAt: "x",
    } as AttentionInput;
    const result = clampAttention(input, {
      shouldSurface: true,
      importance: 0.06,
      relevance: 0.04,
      interruption: 0.01,
      mentalModelChange: 0.2,
      semanticCategory: "implementation_change",
      scope: "local",
      humanDecision: "none",
      needsSystem2: false,
      confidence: 0.8,
      probabilities: {},
    });
    expect(result.value.importance).toBe(0.06);
  });
});
