import { describe, expect, it } from "vitest";

import {
  BlastRadiusSchema,
  ChangeUnitSchema,
  DecisionSchema,
  SemanticEventSchema,
  StructuredDecisionSchema,
  ValidationResultSchema,
} from "./semantic.js";

const sessionId = "sess_abc";
const ts = "2026-01-15T10:30:00.000Z";

describe("SemanticEventSchema", () => {
  it("parses the SPEC section 4.3 shape with evidence refs", () => {
    const result = SemanticEventSchema.safeParse({
      id: "sem_1",
      sessionId,
      kind: "dependency_change",
      summary: "package.json adds ioredis",
      changeUnitId: "cu_1",
      evidence: [
        {
          id: "fact_1",
          type: "git_hunk",
          sourceId: "git_1",
          description: "package.json hunk",
        },
      ],
      files: ["package.json", "src/redis.ts"],
      symbols: ["createClient"],
      createdAt: ts,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid kind", () => {
    const result = SemanticEventSchema.safeParse({
      id: "sem_1",
      sessionId,
      kind: "weather_change",
      summary: "x",
      evidence: [],
      files: [],
      symbols: [],
      createdAt: ts,
    });
    expect(result.success).toBe(false);
  });
});

describe("ChangeUnitSchema", () => {
  const unit = {
    id: "cu_1",
    sessionId,
    title: "Introduce provider-independent identity layer",
    intent: "Support Google sign-in",
    category: "architecture",
    status: "in_progress",
    behaviorBefore: "auth via password only",
    behaviorAfter: "auth via password or Google",
    files: ["auth/service.ts", "auth/google.ts", "db/schema.ts"],
    symbols: [
      {
        id: "auth/service.ts#createSession(method)@abc",
        name: "createSession",
        path: "auth/service.ts",
        kind: "method",
      },
    ],
    interfacesChanged: [
      {
        name: "AuthService.login",
        path: "auth/service.ts",
        change: "modified",
        before: "login(email, password)",
        after: "login(identity)",
      },
    ],
    schemaChanges: [
      {
        entity: "users",
        entityType: "table",
        change: "modified",
        after: "added oauth_provider column",
        migration: "migrations/042_add_oauth.sql",
      },
    ],
    dependencyChanges: [
      { name: "ioredis", version: "5.4.1", change: "added", manifest: "package.json" },
    ],
    relatedDecisions: ["dec_1"],
    validationResults: ["val_1"],
    blastRadius: {
      affectedFiles: 5,
      affectedSymbols: 3,
      affectedTests: 2,
      scope: "subsystem",
    },
    importance: 0.72,
    relevance: 0.81,
    interruption: 0.08,
    uncertainty: 0.1,
    mentalModelChange: 0.4,
    evidence: ["fact_1", "fact_2"],
    createdAt: ts,
    updatedAt: ts,
  };

  it("parses a full ChangeUnit", () => {
    expect(ChangeUnitSchema.safeParse(unit).success).toBe(true);
  });

  it("parses all PRD section 9 categories", () => {
    const categories = [
      "behavior",
      "architecture",
      "api",
      "schema",
      "dependency",
      "security",
      "configuration",
      "performance",
      "implementation",
      "tests",
      "documentation",
    ];
    for (const category of categories) {
      expect(ChangeUnitSchema.safeParse({ ...unit, category }).success).toBe(true);
    }
  });

  it("parses all six statuses", () => {
    const statuses = ["detected", "in_progress", "validated", "failed", "reverted", "superseded"];
    for (const status of statuses) {
      expect(ChangeUnitSchema.safeParse({ ...unit, status }).success).toBe(true);
    }
  });

  it("rejects out-of-range scores", () => {
    expect(ChangeUnitSchema.safeParse({ ...unit, importance: 1.5 }).success).toBe(false);
    expect(ChangeUnitSchema.safeParse({ ...unit, relevance: -0.1 }).success).toBe(false);
  });

  it("rejects an invalid blast radius scope", () => {
    const result = BlastRadiusSchema.safeParse({
      affectedFiles: 1,
      affectedSymbols: 1,
      affectedTests: 0,
      scope: "global",
    });
    expect(result.success).toBe(false);
  });
});

describe("DecisionSchema", () => {
  it("parses a Decision with tradeoff options", () => {
    const result = DecisionSchema.safeParse({
      id: "dec_1",
      sessionId,
      title: "Account linking policy",
      context: "Existing users signing in through Google",
      severity: "required",
      options: [
        {
          id: "opt_match_email",
          label: "Match by email",
          description: "Link when verified email matches",
          tradeoffs: [
            { dimension: "Friction", consequence: "Lower friction" },
            { dimension: "Verification", consequence: "Weaker" },
          ],
        },
        {
          id: "opt_explicit",
          label: "Require explicit linking",
          description: "User must confirm before linking",
          tradeoffs: [
            { dimension: "Friction", consequence: "More user steps" },
            { dimension: "Verification", consequence: "Stronger" },
          ],
        },
      ],
      affectedChangeUnits: ["cu_1"],
      evidence: ["fact_1"],
      status: "open",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid severity", () => {
    const result = DecisionSchema.safeParse({
      id: "dec_1",
      sessionId,
      title: "x",
      context: "y",
      severity: "mandatory",
      options: [],
      affectedChangeUnits: [],
      evidence: [],
      status: "open",
    });
    expect(result.success).toBe(false);
  });
});

describe("StructuredDecisionSchema", () => {
  it("parses the PRD section 8 example", () => {
    const result = StructuredDecisionSchema.safeParse({
      decisionId: "dec_1",
      decision: {
        account_linking_policy: "require_explicit_verification",
      },
      evidence: ["oauth_callback_change", "user_identity_schema_change"],
      instruction:
        "Continue implementation using explicit verification before linking a Google identity to an existing password account.",
    });
    expect(result.success).toBe(true);
  });
});

describe("ValidationResultSchema", () => {
  it("parses a validation row", () => {
    const result = ValidationResultSchema.safeParse({
      id: "val_1",
      kind: "test",
      command: "vitest run",
      status: "failed",
      passed: 12,
      failed: 1,
      skipped: 0,
      ts,
    });
    expect(result.success).toBe(true);
  });
});
