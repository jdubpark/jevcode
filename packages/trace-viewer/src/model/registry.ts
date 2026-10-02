import type { EventStoreType, EvidenceFactType, NormalizedAgentEventType } from "@jevcode/contracts";

import { normalizeCommand } from "./format.js";
import type { Actor, Lane, Severity, StepKind } from "./types.js";

// Exhaustive rule tables. The mapped types make a new contract variant or step
// kind a typecheck error until it has an entry here; registry.test.ts catches
// entries that a cast would slip past.

export interface KindMeta {
  lane: Lane;
  actor: Actor;
  label: string;
}

export const KIND_META: { readonly [K in StepKind]: KindMeta } = {
  instruction: { lane: "supervisor", actor: "supervisor", label: "Instruction" },
  message: { lane: "agent", actor: "agent", label: "Message" },
  reasoning: { lane: "agent", actor: "agent", label: "Reasoning" },
  command: { lane: "commands", actor: "agent", label: "Command" },
  test: { lane: "tests", actor: "agent", label: "Test run" },
  check: { lane: "tests", actor: "agent", label: "Check" },
  edit: { lane: "edits", actor: "agent", label: "Edit" },
  read: { lane: "edits", actor: "agent", label: "Read" },
  tool: { lane: "agent", actor: "agent", label: "Tool call" },
  approval: { lane: "supervisor", actor: "agent", label: "Approval request" },
  decision: { lane: "supervisor", actor: "jevcode", label: "Decision" },
  dependency: { lane: "edits", actor: "repo", label: "Dependency change" },
  revert: { lane: "edits", actor: "repo", label: "Revert" },
  lifecycle: { lane: "agent", actor: "agent", label: "Session event" },
  guardrail: { lane: "jev", actor: "jevcode", label: "Guardrail" },
  attention: { lane: "jev", actor: "jevcode", label: "Attention" },
};

export type RowDisposition = "consume" | "hidden";

/**
 * consume = TRACE_ROW_TYPES; everything else is only counted in TraceSession.hidden.
 * overview_snapshot (lane 06 P-1) and explainer (lane 07 S-3) are consumed, but until those
 * tasks add their `case` to accumulate (fold.ts) the default branch counts them in hidden.
 */
export const ENVELOPE_RULES: { readonly [K in EventStoreType]: RowDisposition } = {
  agent_event: "consume",
  evidence_fact: "consume",
  change_unit: "consume",
  decision: "consume",
  validation: "consume",
  failure: "hidden",
  jev_decision: "consume",
  ui_intent: "hidden",
  ui_snapshot: "hidden",
  graph_node: "hidden",
  graph_edge: "hidden",
  command: "hidden",
  semantic_event: "hidden",
  telemetry: "hidden",
  overview_snapshot: "consume",
  explainer: "consume",
};

export interface AgentEventRule {
  kind: StepKind;
  role: "start" | "complete" | "point";
}

/** agent_message with role "user" folds as an instruction (supervisor), not a message. */
export const AGENT_EVENT_RULES: { readonly [K in NormalizedAgentEventType]: AgentEventRule } = {
  agent_started: { kind: "instruction", role: "point" },
  agent_message: { kind: "message", role: "point" },
  agent_reasoning: { kind: "reasoning", role: "point" },
  tool_started: { kind: "tool", role: "start" },
  tool_completed: { kind: "tool", role: "complete" },
  command_started: { kind: "command", role: "start" },
  command_completed: { kind: "command", role: "complete" },
  file_read: { kind: "read", role: "point" },
  file_changed: { kind: "edit", role: "point" },
  approval_requested: { kind: "approval", role: "point" },
  test_started: { kind: "test", role: "start" },
  test_completed: { kind: "test", role: "complete" },
  agent_waiting: { kind: "lifecycle", role: "point" },
  agent_completed: { kind: "lifecycle", role: "point" },
  agent_failed: { kind: "lifecycle", role: "point" },
  agent_interrupted: { kind: "lifecycle", role: "point" },
};

export interface FactRule {
  kind: StepKind;
  attach: "call" | "path" | "none";
}

export const FACT_RULES: { readonly [K in EvidenceFactType]: FactRule } = {
  git_hunk: { kind: "edit", attach: "path" },
  file_changed: { kind: "edit", attach: "path" },
  symbol_delta: { kind: "edit", attach: "path" },
  dependency_change: { kind: "dependency", attach: "none" },
  test_result: { kind: "test", attach: "call" },
  command_executed: { kind: "command", attach: "call" },
  revert_detected: { kind: "revert", attach: "none" },
};

export interface ClampMeta {
  label: string;
  severity: Severity;
}

/** The 15 clamp ids pushed in packages/jev-router/src/guardrails.ts:76-256. */
export const CLAMP_META: Readonly<Record<string, ClampMeta>> = {
  destructive_command: { label: "Destructive command", severity: "critical" },
  security_path: { label: "Security-sensitive path", severity: "warning" },
  schema_floor: { label: "Schema change kept visible", severity: "warning" },
  public_api: { label: "Public API change kept visible", severity: "warning" },
  suppress_formatting: { label: "Formatting-only change hidden", severity: "info" },
  suppress_lockfile: { label: "Lockfile change hidden", severity: "info" },
  suppress_passing_tests: { label: "Passing tests hidden", severity: "info" },
  failed_unit_relevance: { label: "Failed change kept relevant", severity: "warning" },
  interrupt_floor: { label: "Interruption floor applied", severity: "info" },
  decision_presence_floor: { label: "Decision kept visible", severity: "info" },
  noise_triad_cap_formatting: { label: "Formatting noise capped", severity: "info" },
  noise_triad_cap_lockfile: { label: "Lockfile noise capped", severity: "info" },
  failed_unit_attention: { label: "Failed change surfaced", severity: "warning" },
  required_decision_attention: { label: "Required decision surfaced", severity: "info" },
  attention_sanitize: { label: "Attention values sanitized", severity: "info" },
};

/** Unknown ids (for example "guardrail.security" in old rows) are info and labeled by their id. */
export function clampMeta(id: string): ClampMeta {
  return Object.hasOwn(CLAMP_META, id) ? (CLAMP_META[id] as ClampMeta) : { label: id, severity: "info" };
}

const SEVERITY_RANK: { readonly [K in Severity]: number } = { info: 0, warning: 1, critical: 2 };

export function severityRank(severity: Severity): number {
  return SEVERITY_RANK[severity];
}

// ------------------------------------------------------------ command and path rules

/** Workspace flags a package manager may take before a script or a binary: -r, -w, --filter x,
 *  --filter=x, -F x, --workspace x. */
const PM_FLAGS = String.raw`(?:\s+(?:-r|--recursive|-w|--workspace-root|(?:-F|--filter|--workspace)(?:=|\s+)\S+))*`;

/** Type checks, linters and builds (R10, spec §6.6), matched at the head of normalizeCommand(command):
 *  tsc, eslint or vite build, bare or through npx or pnpm/npm/yarn (optionally with run or exec), or
 *  a pnpm/npm/yarn typecheck, lint or build script. Anchored, so "ls build", "grep -r build src"
 *  (exit 1 on no match) and "pnpm add eslint" are not checks: a failed check paints red and can
 *  contradict a claim. Checked before TEST_COMMAND. */
export const CHECK_COMMAND = new RegExp(
  String.raw`^(?:npx\s+|(?:pnpm|npm|yarn)${PM_FLAGS}\s+(?:(?:run|exec)\s+)?)?(?:tsc|eslint|vite build)\b` +
    String.raw`|^(?:pnpm|npm|yarn)${PM_FLAGS}\s+(?:run\s+)?(?:typecheck|lint|build)\b`,
);

/** Test runners (spec §16 risk 15), matched at the head of normalizeCommand(command) like
 *  CHECK_COMMAND: vitest, jest, pytest or mocha, bare or through npx, python -m (pytest) or
 *  pnpm/npm/yarn/bun (optionally with run or exec); a pnpm/npm/yarn/bun test script after the
 *  workspace flags; or go, cargo or deno test. Anchored, so "grep -rn vitest src" (exit 1 on no
 *  match), "cat vitest.config.ts" and "ls tests" are not test runs: commandKind makes a match a test
 *  step even without a test_result, and a failed test paints red and can contradict a claim. */
export const TEST_COMMAND = new RegExp(
  String.raw`^(?:npx\s+|(?:pnpm|npm|yarn|bun)${PM_FLAGS}\s+(?:(?:run|exec)\s+)?)?(?:vitest|jest|mocha|pytest)\b` +
    String.raw`|^python3?\s+-m\s+pytest\b` +
    String.raw`|^(?:pnpm|npm|yarn|bun)${PM_FLAGS}\s+(?:run\s+)?test\b` +
    String.raw`|^(?:go|cargo|deno)\s+test\b`,
);

/** Classifies a raw command; both patterns see normalizeCommand(command) (a bash -lc wrapper unwrapped). */
export function commandKind(command: string): "check" | "test" | "command" {
  const normalized = normalizeCommand(command);
  if (CHECK_COMMAND.test(normalized)) return "check";
  if (TEST_COMMAND.test(normalized)) return "test";
  return "command";
}

const LOCKFILE_NAMES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "composer.lock",
  "go.sum",
]);

export function isLockfilePath(path: string): boolean {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return LOCKFILE_NAMES.has(basename);
}

/** Tools that only read (read_file, list_dir, grep, …) collapse as "read" noise. */
export const READ_TOOL = /(?:^|[._-])(?:read|view|list|search|grep|glob|find|ls|cat)(?:[._-]|$)/i;
