import { describe, expect, it } from "vitest";

import {
  EVENT_TYPES,
  EvidenceFactSchema,
  NormalizedAgentEventSchema,
  TRACE_ROW_TYPES,
} from "@jevcode/contracts";

import {
  AGENT_EVENT_RULES,
  CLAMP_META,
  clampMeta,
  commandKind,
  ENVELOPE_RULES,
  FACT_RULES,
  isLockfilePath,
  KIND_META,
  READ_TOOL,
} from "./registry.js";
import { LANES, STEP_KINDS } from "./types.js";

// The mapped types already fail typecheck on a missing key; these checks catch entries a
// cast would slip past and keep the tables in step with the zod schemas at runtime.

const GUARDRAIL_CLAMP_IDS = [
  "destructive_command",
  "security_path",
  "schema_floor",
  "public_api",
  "suppress_formatting",
  "suppress_lockfile",
  "suppress_passing_tests",
  "failed_unit_relevance",
  "interrupt_floor",
  "decision_presence_floor",
  "noise_triad_cap_formatting",
  "noise_triad_cap_lockfile",
  "failed_unit_attention",
  "required_decision_attention",
  "attention_sanitize",
];

describe("rule tables", () => {
  it("maps every step kind to a lane, actor and label", () => {
    expect(Object.keys(KIND_META).sort()).toEqual([...STEP_KINDS].sort());
    for (const kind of STEP_KINDS) {
      expect(LANES).toContain(KIND_META[kind].lane);
      expect(KIND_META[kind].label.length).toBeGreaterThan(0);
    }
  });

  it("pins each kind's lane (UI index §1.4 B-2)", () => {
    const lanes = Object.fromEntries(STEP_KINDS.map((kind) => [kind, KIND_META[kind].lane]));
    expect(lanes).toEqual({
      instruction: "supervisor",
      approval: "supervisor",
      decision: "supervisor",
      message: "agent",
      reasoning: "agent",
      tool: "agent",
      lifecycle: "agent",
      command: "commands",
      edit: "edits",
      read: "edits",
      dependency: "edits",
      revert: "edits",
      test: "tests",
      check: "tests",
      guardrail: "jev",
      attention: "jev",
    });
  });

  it("maps every envelope type and consumes exactly TRACE_ROW_TYPES", () => {
    expect(Object.keys(ENVELOPE_RULES).sort()).toEqual([...EVENT_TYPES].sort());
    const consumed = EVENT_TYPES.filter((type) => ENVELOPE_RULES[type] === "consume");
    expect([...consumed].sort()).toEqual([...TRACE_ROW_TYPES].sort());
  });

  it("maps every agent event variant in the contracts schema", () => {
    const variants = NormalizedAgentEventSchema.options.map((option) => option.shape.type.value);
    expect(Object.keys(AGENT_EVENT_RULES).sort()).toEqual([...variants].sort());
    for (const variant of variants) {
      expect(STEP_KINDS).toContain(AGENT_EVENT_RULES[variant].kind);
    }
  });

  it("maps every evidence fact variant in the contracts schema", () => {
    const variants = EvidenceFactSchema.options.map((option) => option.shape.type.value);
    expect(Object.keys(FACT_RULES).sort()).toEqual([...variants].sort());
    for (const variant of variants) {
      expect(STEP_KINDS).toContain(FACT_RULES[variant].kind);
    }
  });

  it("labels the 15 guardrail clamp ids and falls back to info for unknown ids", () => {
    expect(Object.keys(CLAMP_META).sort()).toEqual([...GUARDRAIL_CLAMP_IDS].sort());
    for (const id of GUARDRAIL_CLAMP_IDS) expect(clampMeta(id).label.length).toBeGreaterThan(0);
    expect(clampMeta("destructive_command").severity).toBe("critical");
    expect(clampMeta("security_path").severity).toBe("warning");
    expect(clampMeta("suppress_lockfile").severity).toBe("info");
    expect(clampMeta("guardrail.security")).toEqual({ label: "guardrail.security", severity: "info" });
    expect(clampMeta("toString")).toEqual({ label: "toString", severity: "info" });
  });
});

describe("command and path rules", () => {
  it.each([
    ["pnpm test", "test"],
    ["/bin/zsh -lc 'pnpm run test -- auth'", "test"],
    ["npx vitest run", "test"],
    ["cargo test", "test"],
    ["pnpm typecheck", "check"],
    ["pnpm lint && pnpm test", "check"],
    ["tsc --noEmit", "check"],
    ["pnpm -r typecheck", "check"],
    ["pnpm --filter x lint", "check"],
    ["pnpm --filter=web build", "check"],
    ["npm run build", "check"],
    ["yarn lint", "check"],
    ["npx eslint src", "check"],
    ["pnpm exec tsc -p tsconfig.json", "check"],
    ["npx vite build", "check"],
    ["/bin/zsh -lc 'pnpm -r build'", "check"],
    ["cat tests/users.test.ts", "command"],
    ["pnpm add zod", "command"],
    // Near misses: a check word that is not the command head (spec §6.6).
    ["pnpm add eslint", "command"],
    ["ls build", "command"],
    ["grep -r build src", "command"],
    ["git commit -m 'fix lint'", "command"],
    ["cat tsconfig.json", "command"],
    ["pnpm test -- --grep build", "test"],
    // Test runners are anchored too (spec §16 risk 15): a runner name that is not the head is not a test run.
    ["vitest run src/model", "test"],
    ["pnpm --filter @jevcode/trace-viewer exec vitest run", "test"],
    ["python -m pytest -q", "test"],
    ["bun test", "test"],
    ["go test ./...", "test"],
    ["grep -r vitest src", "command"],
    ["grep -rn vitest src", "command"],
    ["rg jest", "command"],
    ["cat vitest.config.ts", "command"],
    ["ls tests", "command"],
    ["git commit -m 'add vitest'", "command"],
  ])("%s is a %s", (command, kind) => {
    expect(commandKind(command)).toBe(kind);
  });

  it("recognizes lockfiles by basename", () => {
    expect(isLockfilePath("pnpm-lock.yaml")).toBe(true);
    expect(isLockfilePath("apps/web/package-lock.json")).toBe(true);
    expect(isLockfilePath("src/lockfile.ts")).toBe(false);
  });

  it("recognizes read-only tools", () => {
    expect(READ_TOOL.test("read_file")).toBe(true);
    expect(READ_TOOL.test("mcp.fs.list_dir")).toBe(true);
    expect(READ_TOOL.test("apply_patch")).toBe(false);
    expect(READ_TOOL.test("thread_reader")).toBe(false);
  });
});
