import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ArchitectureDeltaPropsSchema,
  BehaviorDeltaPropsSchema,
  CATALOG_COMPONENT_NAMES,
  ChangeOverviewPropsSchema,
  CodeDiffPropsSchema,
  DecisionPropsSchema,
  DependencyDeltaPropsSchema,
  ExecutionTimelinePropsSchema,
  FailureAnalysisPropsSchema,
  JsonRenderSpecSchema,
  SchemaDeltaPropsSchema,
  TerminalPropsSchema,
  TestMatrixPropsSchema,
  type CatalogComponentName,
  type ChangeCategory,
  type ChangeUnit,
  type Decision,
  type UIIntent,
} from "@jevcode/contracts";
import type { z } from "zod";

import { compileUI } from "./compile.js";
import type {
  ChangeUnitPayload,
  CompilePayload,
  DecisionPayload,
  FailurePayload,
  ValidationPayload,
} from "./payload.js";

const FIXTURES_DIR = new URL("../../../fixtures/", import.meta.url);

// ---------------------------------------------------------------------------
// Fixture data loading. Payload builders below are derived from the fixture
// data (labels/projection.json intents, labels/attention.json scopes,
// expected_units.json unit data, events.jsonl facts/decisions, and the
// changes/ tree for diff contents) — never from the golden spec files, so a
// dropped compiler prop cannot be masked by a payload that mirrors the
// golden output.
// ---------------------------------------------------------------------------

interface GoldenElement {
  type: string;
  props?: Record<string, unknown>;
  children?: string[];
}

interface GoldenSpec {
  root: string;
  elements: Record<string, GoldenElement>;
}

interface GoldenCase {
  fixture: string;
  slug: string;
  intent: UIIntent;
  golden: GoldenSpec;
  payload: CompilePayload;
}

interface FixtureUnit {
  id: string;
  title: string;
  category: ChangeCategory;
  files: string[];
  symbolNames: string[];
}

interface TestResultFact {
  command: string;
  runner: string;
  passed: number;
  failed: number;
  skipped: number;
  failures: { file: string; testName: string; message: string }[];
}

interface DependencyFact {
  added: { name: string; version: string }[];
  removed: { name: string; version: string }[];
}

interface FixtureData {
  fixture: string;
  projection: Record<string, UIIntent>;
  attention: Record<
    string,
    { scope?: string; confidence?: number; shouldSurface?: boolean }
  >;
  units: FixtureUnit[];
  records: Record<string, unknown>[];
}

function readJson(url: URL): unknown {
  return JSON.parse(readFileSync(url, "utf8")) as unknown;
}

function parseRecords(fixture: string): Record<string, unknown>[] {
  const text = readFileSync(
    new URL(`${fixture}/events.jsonl`, FIXTURES_DIR),
    "utf8",
  );
  const records: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    records.push(JSON.parse(trimmed) as Record<string, unknown>);
  }
  return records;
}

function loadFixtureData(fixture: string): FixtureData {
  const projection = readJson(
    new URL(`${fixture}/labels/projection.json`, FIXTURES_DIR),
  ) as Record<string, UIIntent>;
  const attention = readJson(
    new URL(`${fixture}/labels/attention.json`, FIXTURES_DIR),
  ) as Record<string, { scope?: string; confidence?: number; shouldSurface?: boolean }>;
  const rawUnits = readJson(
    new URL(`${fixture}/expected_units.json`, FIXTURES_DIR),
  ) as Array<Record<string, unknown>>;
  const units: FixtureUnit[] = rawUnits.map((raw) => ({
    id: raw["id"] as string,
    title: raw["title"] as string,
    category: raw["category"] as ChangeCategory,
    files: (raw["files"] as string[]) ?? [],
    symbolNames: (raw["symbolNames"] as string[]) ?? [],
  }));
  return {
    fixture,
    projection,
    attention,
    units,
    records: parseRecords(fixture),
  };
}

function unitDataFor(data: FixtureData, slug: string): FixtureUnit {
  const unitData = data.units.find((unit) => unit.id === slug);
  if (unitData === undefined) {
    throw new Error(`fixture ${data.fixture}: no expected unit for ${slug}`);
  }
  return unitData;
}

function makeUnit(
  data: FixtureData,
  slug: string,
  overrides: Partial<ChangeUnit> = {},
): ChangeUnit {
  const unitData = unitDataFor(data, slug);
  return {
    id: slug,
    sessionId: "sess-fixture",
    title: unitData.title,
    category: unitData.category,
    status: "detected",
    files: unitData.files,
    symbols: unitData.symbolNames.map((name) => ({
      id: `sym:${name}`,
      name,
      path: "src/index.ts",
      kind: "function",
    })),
    interfacesChanged: [],
    schemaChanges: [],
    dependencyChanges: [],
    relatedDecisions: [],
    validationResults: [],
    evidence: [],
    createdAt: "2026-09-18T09:00:00.000Z",
    updatedAt: "2026-09-18T09:00:00.000Z",
    ...overrides,
  };
}

function testResultFact(data: FixtureData): TestResultFact {
  const record = data.records.find(
    (entry) => entry["type"] === "test_result",
  ) as Record<string, unknown> | undefined;
  if (record === undefined) {
    throw new Error(`fixture ${data.fixture}: no test_result fact`);
  }
  return {
    command: String(record["command"]),
    runner: String(record["runner"]),
    passed: Number(record["passed"]),
    failed: Number(record["failed"]),
    skipped: Number(record["skipped"]),
    failures: (record["failures"] as TestResultFact["failures"]) ?? [],
  };
}

function dependencyFact(data: FixtureData): DependencyFact {
  const record = data.records.find(
    (entry) => entry["type"] === "dependency_change",
  ) as Record<string, unknown> | undefined;
  if (record === undefined) {
    throw new Error(`fixture ${data.fixture}: no dependency_change fact`);
  }
  const added = (record["added"] as { name: string; version: string }[]) ?? [];
  const removed = (record["removed"] as { name: string; version: string }[]) ?? [];
  return {
    added: added.map((item) => ({ name: item.name, version: item.version })),
    removed: removed.map((item) => ({ name: item.name, version: item.version })),
  };
}

function decisionRecord(data: FixtureData, status: "open" | "answered"): Decision {
  const record = data.records.find(
    (entry) => entry["severity"] !== undefined && entry["status"] === status,
  );
  if (record === undefined) {
    throw new Error(`fixture ${data.fixture}: no ${status} decision record`);
  }
  return record as unknown as Decision;
}

function decisionCandidateEvidence(data: FixtureData): string[] {
  const event = data.records.find(
    (entry) => entry["kind"] === "decision_candidate",
  ) as { evidence?: { sourceId?: string }[] } | undefined;
  if (event?.evidence === undefined) {
    throw new Error(`fixture ${data.fixture}: no decision_candidate semantic event`);
  }
  return event.evidence
    .map((item) => item.sourceId)
    .filter((sourceId): sourceId is string => typeof sourceId === "string");
}

function changesFileContent(fixture: string, file: string): string {
  const url = new URL(`${fixture}/changes/${file}`, FIXTURES_DIR);
  try {
    return readFileSync(url, "utf8");
  } catch {
    throw new Error(`fixture ${fixture}: missing changes/${file} for diff content`);
  }
}

type Builder = (data: FixtureData, slug: string, intent: UIIntent) => CompilePayload;

// ---------------------------------------------------------------------------
// Payload builders. Values that appear verbatim in the fixture data are
// derived above; everything else is written out explicitly with a
// provenance comment (curated surface copy, SPEC 9.2 action shapes, or
// scenario details from fixtures/README.md). No builder reads a golden file.
// ---------------------------------------------------------------------------

// Curated diff hunks: repo/ is the before-state and changes/ the after-state,
// but the golden hunks show only the semantic change with three context
// lines, so the hunk text is pinned here rather than computed.
const API_BREAK_BEHAVIOR_DIFF =
  " export function handleGetUser(id: number): { status: number; body: unknown } {\n" +
  "   const user = users.find((u) => u.id === id);\n" +
  "-  if (!user) {\n" +
  "-    throw new NotFoundError(`user ${id} not found`);\n" +
  "-  }\n" +
  "-  return { status: 200, body: { user } };\n" +
  "+  return user\n" +
  "+    ? { status: 200, body: { user } }\n" +
  "+    : { status: 200, body: { user: null } };\n" +
  " }\n";

const API_BREAK_STALE_TEST_DIFF =
  '   it("returns 404 when the user is missing", () => {\n' +
  '-    expect(() => handleGetUser(999)).toThrowError("user 999 not found");\n' +
  "+    const result = handleGetUser(999);\n" +
  "+    expect(result.status).toBe(200);\n" +
  "+    expect(result.body).toEqual({ user: null });\n" +
  "   });\n";

const builders: Record<string, Builder> = {
  "api-break/api-users-404-behavior": (data, slug, _intent) => {
    const unitData = unitDataFor(data, slug);
    const p: ChangeUnitPayload = {
      kind: "changeUnit",
      unit: makeUnit(data, slug, {
        // Curated surface copy (semantic event summary wording), not the
        // expected_units.json title.
        title: "GET /users/:id on missing user: 404 -> 200 with null body",
        status: "detected",
      }),
      behavior: {
        subject: "missing_user_response",
        before: 'HTTP 404 { error: "user <id> not found" }',
        after: "HTTP 200 { user: null }",
      },
      diff: { file: unitData.files[0] ?? "src/routes/users.ts", diff: API_BREAK_BEHAVIOR_DIFF },
      actions: [
        { action: "restore_previous_api_semantics", params: { symbol: "handleGetUser" } },
        { action: "accept_changes", params: { changeUnitId: slug } },
      ],
    };
    return p;
  },

  "api-break/api-users-404-stale-test": (data, _slug, _intent) => {
    const test = testResultFact(data);
    const p: FailurePayload = {
      kind: "failure",
      failure: {
        title: "pnpm test failed: stale 404 expectation",
        command: test.command,
        runner: test.runner,
        exitCode: 1,
        failures: test.failures,
        linkedChangeUnits: ["api-users-404-behavior"],
        note: "Test asserts the previous 404 contract; the behavior change made it stale.",
      },
      actions: [
        { action: "accept_changes", params: { updateTest: "tests/users.test.ts" } },
        { action: "restore_previous_api_semantics", params: { symbol: "handleGetUser" } },
      ],
      diff: { file: "tests/users.test.ts", diff: API_BREAK_STALE_TEST_DIFF },
    };
    return p;
  },

  "dep-change/dep-zod-add": (data, slug, intent) => {
    const dep = dependencyFact(data);
    const p: ChangeUnitPayload = {
      kind: "changeUnit",
      unit: makeUnit(data, slug, { status: "validated" }),
      confidence: intent.confidence,
      overview: {
        // Curated overview copy for the dependency swap unit.
        title: "zod added, axios removed",
        evidenceLinks: unitDataFor(data, slug).files,
      },
      dependencies: {
        // Curated title + reason fields; names/versions come from the
        // dependency_change fact in events.jsonl.
        title: "Dependency swap: axios -> fetch + zod",
        added: [
          {
            name: dep.added[0]?.name ?? "zod",
            version: dep.added[0]?.version ?? "",
            reason: "response validation in fetchJson",
          },
        ],
        removed: [
          {
            name: dep.removed[0]?.name ?? "axios",
            version: dep.removed[0]?.version ?? "",
            reason: "replaced by native fetch",
          },
        ],
      },
      actions: [{ action: "show_exact_diff", params: { files: ["package.json"] } }],
    };
    return p;
  },

  "dep-change/dep-zod-impl": (data, slug, intent) => {
    const p: ChangeUnitPayload = {
      kind: "changeUnit",
      unit: makeUnit(data, slug, {
        status: "validated",
        blastRadius: {
          affectedFiles: 0,
          affectedSymbols: 0,
          affectedTests: 0,
          scope: (data.attention[slug]?.scope as "module") ?? "module",
        },
      }),
      confidence: intent.confidence,
      overview: { evidenceLinks: unitDataFor(data, slug).files },
    };
    return p;
  },

  "oauth/oauth-identity-layer": (data, slug, intent) => {
    const p: ChangeUnitPayload = {
      kind: "changeUnit",
      unit: makeUnit(data, slug, {
        // Curated surface copy describing the architecture change.
        title: "OAuth identity layer: Identity -> Session",
        status: "in_progress",
      }),
      confidence: intent.confidence,
      architecture: {
        // Curated node/edge diagram for the SPEC 9.2 ArchitectureDelta view.
        nodes: [
          { id: "n-identity", label: "Identity", kind: "module", path: "src/auth/identity.ts" },
          { id: "n-session", label: "Session", kind: "type", path: "src/auth/service.ts" },
          { id: "n-password", label: "PasswordProvider", kind: "module", path: "src/auth/service.ts" },
          { id: "n-google", label: "GoogleOAuthProvider", kind: "module", path: "src/auth/google.ts" },
          { id: "n-callback", label: "CallbackRoute", kind: "route", path: "src/server/index.ts" },
        ],
        edges: [
          { from: "n-identity", to: "n-session", label: "creates" },
          { from: "n-password", to: "n-identity", label: "provides" },
          { from: "n-google", to: "n-identity", label: "provides" },
          { from: "n-callback", to: "n-google", label: "invokes" },
        ],
        scope: "subsystem",
        evidenceCount: 3,
      },
      actions: [
        { action: "inspect_call_sites", params: { symbol: "createSession" } },
        { action: "show_exact_diff", params: { files: ["src/auth/service.ts"] } },
      ],
    };
    return p;
  },

  "oauth/oauth-migration": (data, slug, _intent) => {
    const migrationFile = unitDataFor(data, slug).files[0] ?? "migrations/001_create_identities.sql";
    const p: ChangeUnitPayload = {
      kind: "changeUnit",
      unit: makeUnit(data, slug, {
        // Curated surface copy: the migration target, not the full unit title.
        title: "identities table",
        status: "validated",
      }),
      schema: {
        title: "identities table",
        migration: migrationFile,
        // Curated from the migration DDL in changes/migrations/...
        changes: [
          { entity: "identities", entityType: "table", change: "added" },
          { entity: "identities_provider_subject_idx", entityType: "index", change: "added" },
        ],
      },
      actions: [{ action: "show_exact_diff", params: { files: [migrationFile] } }],
      diff: { file: migrationFile, diff: changesFileContent(data.fixture, migrationFile) },
    };
    return p;
  },

  "oauth/oauth-dependency": (data, slug, intent) => {
    const dep = dependencyFact(data);
    const p: ChangeUnitPayload = {
      kind: "changeUnit",
      unit: makeUnit(data, slug, { status: "validated" }),
      confidence: intent.confidence,
      overview: { evidenceLinks: unitDataFor(data, slug).files },
      dependencies: {
        title: dep.added[0]?.name ?? "google-auth-library",
        added: [
          {
            name: dep.added[0]?.name ?? "google-auth-library",
            version: dep.added[0]?.version ?? "",
            reason: "verify Google ID tokens in the callback flow",
          },
        ],
        removed: [],
      },
      actions: [{ action: "show_exact_diff", params: { files: ["package.json"] } }],
    };
    return p;
  },

  "oauth/oauth-account-linking-decision": (data, _slug, _intent) => {
    const open = decisionRecord(data, "open");
    const answered = decisionRecord(data, "answered");
    const relatedUnitData = unitDataFor(data, "oauth-identity-layer");
    const p: DecisionPayload = {
      kind: "decision",
      decision: {
        ...open,
        // Curated option copy (labels/descriptions match events.jsonl; the
        // tradeoff wording is pinned from the scenario).
        options: [
          {
            id: "match_email",
            label: "Match by email",
            description: "Link a Google identity to an existing account when the verified Google email matches.",
            tradeoffs: [
              { dimension: "friction", consequence: "Lower friction: users are linked automatically." },
              { dimension: "security", consequence: "Trusts Google email verification; weaker against account takeover." },
            ],
          },
          {
            id: "explicit_link",
            label: "Require explicit linking",
            description: "Ask the user to sign in with email/password first, then link the Google identity explicitly.",
            tradeoffs: [
              { dimension: "security", consequence: "Password proves ownership of the existing account." },
              { dimension: "friction", consequence: "Extra sign-in step required for linking." },
            ],
          },
        ],
      },
      suggestedAnswer:
        answered.answer !== undefined
          ? { decision: answered.answer.decision, evidence: answered.answer.evidence }
          : undefined,
      relatedUnit: {
        unit: makeUnit(data, "oauth-identity-layer", {
          // Curated: the decision overview names the identity layer surface.
          title: "OAuth identity layer",
          status: "in_progress",
        }),
        confidence: relatedUnitData.files.length > 0 ? 0.92 : undefined,
        overview: { evidenceLinks: decisionCandidateEvidence(data) },
      },
    };
    return p;
  },

  "oauth/oauth-linking-test-failure": (data, _slug, _intent) => {
    const test = testResultFact(data);
    const p: FailurePayload = {
      kind: "failure",
      failure: {
        title: "pnpm test failed: oauth account linking",
        command: test.command,
        runner: test.runner,
        exitCode: 1,
        failures: test.failures,
        linkedChangeUnits: ["oauth-identity-layer"],
        note: "Agent reported all checks pass while one test failed.",
      },
      matrix: {
        rows: [
          { name: "unit tests", status: "passed", passed: 14, failed: 0, skipped: 0 },
          { name: "integration tests", status: "failed", passed: 0, failed: 1, skipped: 0 },
        ],
      },
      actions: [
        {
          action: "request_changes",
          params: { instruction: "Fix the failing oauth account-linking test before finishing." },
        },
      ],
    };
    return p;
  },

  "rate-limit/rate-limit-architecture": (data, slug, intent) => {
    const p: ChangeUnitPayload = {
      kind: "changeUnit",
      unit: makeUnit(data, slug, {
        // Curated surface copy for the architecture diagram.
        title: "Request pipeline: Client -> RateLimiter -> API, backed by Redis",
        status: "in_progress",
      }),
      confidence: intent.confidence,
      architecture: {
        nodes: [
          { id: "n-client", label: "Client", kind: "external" },
          { id: "n-api", label: "API (createApp)", kind: "module" },
          { id: "n-limiter", label: "RateLimiter", kind: "middleware", path: "src/middleware/rate-limiter.ts" },
          { id: "n-redis", label: "Redis", kind: "service" },
          { id: "n-config", label: "RateLimitOptions", kind: "config", path: "src/middleware/rate-limiter.ts" },
        ],
        edges: [
          { from: "n-client", to: "n-limiter", label: "request" },
          { from: "n-limiter", to: "n-api", label: "next()" },
          { from: "n-limiter", to: "n-redis", label: "INCR / PEXPIRE" },
          { from: "n-config", to: "n-limiter", label: "window, max, failOpen" },
        ],
        scope: "subsystem",
        evidenceCount: 4,
      },
      actions: [{ action: "inspect_call_sites", params: { symbol: "rateLimiter" } }],
    };
    return p;
  },

  "rate-limit/rate-limit-impl": (data, slug, intent) => {
    const p: ChangeUnitPayload = {
      kind: "changeUnit",
      unit: makeUnit(data, slug, {
        status: "validated",
        blastRadius: {
          affectedFiles: 0,
          affectedSymbols: 0,
          affectedTests: 0,
          scope: (data.attention[slug]?.scope as "module") ?? "module",
        },
      }),
      confidence: intent.confidence,
      overview: { evidenceLinks: unitDataFor(data, slug).files },
    };
    return p;
  },

  "rate-limit/rate-limit-dependency": (data, slug, intent) => {
    const dep = dependencyFact(data);
    const p: ChangeUnitPayload = {
      kind: "changeUnit",
      unit: makeUnit(data, slug, { status: "validated" }),
      confidence: intent.confidence,
      overview: { evidenceLinks: unitDataFor(data, slug).files },
      dependencies: {
        title: dep.added[0]?.name ?? "ioredis",
        added: [
          {
            name: dep.added[0]?.name ?? "ioredis",
            version: dep.added[0]?.version ?? "",
            reason: "distributed rate limiting",
            usage: "src/redis/client.ts",
          },
        ],
        removed: [],
      },
      actions: [{ action: "show_exact_diff", params: { files: ["package.json"] } }],
    };
    return p;
  },

  "rate-limit/rate-limit-fail-open-decision": (data, _slug, _intent) => {
    const open = decisionRecord(data, "open");
    const answered = decisionRecord(data, "answered");
    const p: DecisionPayload = {
      kind: "decision",
      // Options come verbatim from the open decision record in events.jsonl;
      // the compiler caps tradeoffs at two per option, which yields the
      // golden snapshot.
      decision: open,
      suggestedAnswer:
        answered.answer !== undefined
          ? { decision: answered.answer.decision, evidence: answered.answer.evidence }
          : undefined,
      relatedUnit: {
        unit: makeUnit(data, "rate-limit-architecture", {
          // Curated: the decision overview names the limiter surface.
          title: "Redis-backed rate limiter",
          status: "in_progress",
        }),
        confidence: 0.89,
        // Curated order: middleware first (the decision's subject file).
        overview: {
          evidenceLinks: [
            "src/middleware/rate-limiter.ts",
            "src/redis/client.ts",
          ],
        },
      },
    };
    return p;
  },

  "rate-limit/rate-limit-validation": (data, slug, _intent) => {
    const p: ValidationPayload = {
      kind: "validation",
      matrix: {
        title: "Validation: rate limiting",
        summary: "143 tests passed, 0 failed",
        // Curated row split of the single green test_result fact into the
        // demo's test suites and static checks.
        rows: [
          { name: "unit tests", status: "passed", passed: 128, failed: 0, skipped: 0 },
          { name: "integration tests", status: "passed", passed: 15, failed: 0, skipped: 0 },
          { name: "typecheck", status: "passed", passed: 1, failed: 0, skipped: 0 },
          { name: "lint", status: "skipped", passed: 0, failed: 0, skipped: 1 },
        ],
      },
      overview: {
        // Curated: the validation surface overview links the task prompt
        // scope, not a single change unit title.
        title: "Add rate limiting to the public API",
        category: "architecture",
        status: "validated",
        confidence: 0.89,
        evidenceLinks: unitDataFor(data, slug).files,
      },
      actions: [
        { action: "accept_changes", params: { changeUnitId: "rate-limit-architecture" } },
        { action: "request_changes", params: { changeUnitId: "rate-limit-architecture" } },
        { action: "continue_task", params: {} },
      ],
    };
    return p;
  },

  "schema-change/schema-users-migration": (data, slug, _intent) => {
    const migrationFile = "migrations/001_alter_users.sql";
    const p: ChangeUnitPayload = {
      kind: "changeUnit",
      unit: makeUnit(data, slug, {
        // Curated surface copy (golden title wording).
        title: "users table: profile fields added, password hash removed",
        status: "validated",
      }),
      schema: {
        title: "users table: profile fields added, password hash removed",
        migration: migrationFile,
        // Curated from the migration DDL in changes/migrations/...
        changes: [
          { entity: "full_name", entityType: "column", change: "added" },
          { entity: "last_login_at", entityType: "column", change: "added" },
          { entity: "password_hash", entityType: "column", change: "removed" },
        ],
        compatibilityNote:
          "Callers must stop reading password_hash; getUserProfile returns full_name but not last_login_at.",
      },
      actions: [{ action: "show_exact_diff", params: { files: [migrationFile] } }],
      diff: { file: migrationFile, diff: changesFileContent(data.fixture, migrationFile) },
    };
    return p;
  },

  "schema-change/schema-queries-impl": (data, slug, intent) => {
    const p: ChangeUnitPayload = {
      kind: "changeUnit",
      unit: makeUnit(data, slug, {
        status: "validated",
        // Curated: the query layer is a local-scope implementation unit.
        blastRadius: {
          affectedFiles: 0,
          affectedSymbols: 0,
          affectedTests: 0,
          scope: "local",
        },
      }),
      confidence: intent.confidence,
      overview: { evidenceLinks: unitDataFor(data, slug).files },
    };
    return p;
  },
};

const COMPONENT_PROP_SCHEMAS: Record<CatalogComponentName, z.ZodType> = {
  ChangeOverview: ChangeOverviewPropsSchema,
  BehaviorDelta: BehaviorDeltaPropsSchema,
  ArchitectureDelta: ArchitectureDeltaPropsSchema,
  SchemaDelta: SchemaDeltaPropsSchema,
  CodeDiff: CodeDiffPropsSchema,
  Decision: DecisionPropsSchema,
  TestMatrix: TestMatrixPropsSchema,
  FailureAnalysis: FailureAnalysisPropsSchema,
  ExecutionTimeline: ExecutionTimelinePropsSchema,
  Terminal: TerminalPropsSchema,
  DependencyDelta: DependencyDeltaPropsSchema,
};

function loadGoldenCases(): GoldenCase[] {
  const cases: GoldenCase[] = [];
  const fixtureNames = readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const fixture of fixtureNames) {
    const specsDir = new URL(`${fixture}/golden_specs/`, FIXTURES_DIR);
    let specFiles: string[] = [];
    try {
      specFiles = readdirSync(specsDir);
    } catch {
      continue;
    }
    const data = loadFixtureData(fixture);
    for (const specFile of specFiles.sort()) {
      const slug = specFile.replace(/\.json$/, "");
      const intent = data.projection[slug];
      if (intent === undefined) {
        throw new Error(`fixture ${fixture}: no projection label for ${slug}`);
      }
      const golden = JSON.parse(
        readFileSync(new URL(specFile, specsDir), "utf8"),
      ) as GoldenSpec;
      const builder = builders[`${fixture}/${slug}`];
      if (builder === undefined) {
        throw new Error(`no payload builder for ${fixture}/${slug}`);
      }
      cases.push({
        fixture,
        slug,
        intent,
        golden,
        payload: builder(data, slug, intent),
      });
    }
  }
  return cases;
}

const cases = loadGoldenCases();

describe.each(cases.map((c) => [c.fixture, c.slug] as const))(
  "golden spec %s/%s",
  (fixture, slug) => {
    const testCase = cases.find(
      (c) => c.fixture === fixture && c.slug === slug,
    );
    if (testCase === undefined) {
      throw new Error(`missing case ${fixture}/${slug}`);
    }

    it("compiler output equals the golden spec exactly", () => {
      const compiled = compileUI(testCase.intent, testCase.payload);
      expect(compiled).toEqual(testCase.golden);
      expect(JSON.stringify(compiled)).toBe(JSON.stringify(testCase.golden));
    });

    it("compiler output is a valid json-render spec", () => {
      const compiled = compileUI(testCase.intent, testCase.payload);
      expect(JsonRenderSpecSchema.safeParse(compiled).success).toBe(true);
    });

    it("golden props validate against the component prop schemas", () => {
      for (const element of Object.values(testCase.golden.elements)) {
        const schema = COMPONENT_PROP_SCHEMAS[element.type as CatalogComponentName];
        expect(schema, `unknown component type ${element.type}`).toBeDefined();
        const result = schema.safeParse(element.props ?? {});
        expect(
          result.success,
          `${element.type} props rejected: ${"error" in result && result.error !== undefined ? JSON.stringify(result.error.issues) : ""}`,
        ).toBe(true);
      }
    });

    it("emits only catalog components and actions", () => {
      const compiled = compileUI(testCase.intent, testCase.payload);
      const componentNames = new Set<string>(CATALOG_COMPONENT_NAMES);
      for (const el of Object.values(compiled.elements)) {
        expect(componentNames.has(el.type)).toBe(true);
        const actions = el.props?.["actions"] as
          | { action: string }[]
          | undefined;
        for (const a of actions ?? []) {
          expect(a.action).toMatch(
            /^(answer_decision|delegate_decision|restore_previous_api_semantics|inspect_call_sites|show_exact_diff|accept_changes|request_changes|continue_task|open_terminal|interrupt_agent|pin_surface|dismiss_surface)$/,
          );
        }
      }
    });
  },
);

describe("fixture coverage", () => {
  it("has a golden case for every fixture golden spec", () => {
    expect(cases.length).toBeGreaterThanOrEqual(16);
  });
});
