import type { AttentionDecision, SemanticEventKind, UIIntent } from "@jevcode/contracts";

import { ATTENTION_LEVELS } from "./questions.js";
import { isTestOnly } from "./patterns.js";
import type { AttentionInput, ProjectionInput } from "./types.js";

export interface AttentionClamps {
  forced: Partial<AttentionDecision>;
  clamps: string[];
}

export const DESTRUCTIVE_INTERRUPTION_FLOOR = 0.9;
export const REQUIRED_DECISION_INTERRUPTION_FLOOR = 0.8;
export const FAILED_UNIT_RELEVANCE_FLOOR = 0.5;

export const NOISE_TRIAD_CAP = {
  importance: 0.05,
  relevance: 0.05,
  interruption: 0.02,
  mentalModelChange: 0.05,
} as const;

export const DECISION_IMPORTANCE_FLOOR = 0.85;
export const DECISION_RELEVANCE_FLOOR = 0.85;
export const DECISION_INTERRUPTION_FLOOR = 0.6;

const clamp01 = (value: number) => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

function passingTestsOnly(input: AttentionInput): boolean {
  const h = input.hints;
  // Deviation from SPEC 8.3.5 (documented in SPEC 19): in addition to the
  // documented conditions (auto-collapse on, only passing test results), the
  // unit must have no diff line changes at all. A unit that both edits code
  // and runs green tests still surfaces; this avoids hiding real work behind
  // a passing test run.
  return (
    h.autoCollapsePassingTests &&
    h.testResults.length > 0 &&
    h.testResults.every((t) => t.failed === 0) &&
    h.diffStats.added === 0 &&
    h.diffStats.removed === 0
  );
}

export function isSuppressed(input: AttentionInput): {
  suppressed: boolean;
  reason: "formatting" | "lockfile" | "passing_tests" | null;
} {
  const h = input.hints;
  if (h.formattingOnly) return { suppressed: true, reason: "formatting" };
  if (h.lockfileOnly) return { suppressed: true, reason: "lockfile" };
  if (passingTestsOnly(input)) return { suppressed: true, reason: "passing_tests" };
  return { suppressed: false, reason: null };
}

export function hasSurfaceFloor(input: AttentionInput): boolean {
  const h = input.hints;
  return (
    h.destructiveCommands.length > 0 ||
    h.securityPaths.length > 0 ||
    h.schemaPaths.length > 0 ||
    h.publicExports.length > 0
  );
}

export function preClampAttention(input: AttentionInput): AttentionClamps {
  const forced: Partial<AttentionDecision> = {};
  const clamps: string[] = [];
  const h = input.hints;
  const testOnly = isTestOnly(input.files);

  if (h.destructiveCommands.length > 0) {
    forced.shouldSurface = true;
    forced.humanDecision = "required";
    forced.interruption = DESTRUCTIVE_INTERRUPTION_FLOOR;
    clamps.push("destructive_command");
  }
  if (h.securityPaths.length > 0) {
    forced.shouldSurface = true;
    if (!testOnly && h.decisionIds.length === 0) {
      forced.semanticCategory = "security_change";
    }
    clamps.push("security_path");
  }
  if (h.schemaPaths.length > 0) {
    forced.shouldSurface = true;
    clamps.push("schema_floor");
  }
  if (h.publicExports.length > 0 && forced.semanticCategory === undefined) {
    forced.shouldSurface = true;
    forced.semanticCategory = "api_change";
    clamps.push("public_api");
  }

  const suppressed = isSuppressed(input);
  if (suppressed.suppressed && forced.shouldSurface !== true) {
    forced.shouldSurface = false;
    if (suppressed.reason === "formatting") clamps.push("suppress_formatting");
    if (suppressed.reason === "lockfile") clamps.push("suppress_lockfile");
    if (suppressed.reason === "passing_tests") clamps.push("suppress_passing_tests");
  }

  if (input.status === "failed") {
    clamps.push("failed_unit_relevance");
  }

  if (forced.humanDecision === "required") {
    forced.interruption = Math.max(
      forced.interruption ?? 0,
      REQUIRED_DECISION_INTERRUPTION_FLOOR,
    );
    clamps.push("interrupt_floor");
  }

  return { forced, clamps };
}

const KNOWN_KINDS: ReadonlySet<string> = new Set<SemanticEventKind>([
  "behavior_change",
  "architecture_change",
  "api_change",
  "schema_change",
  "dependency_change",
  "security_change",
  "test_result",
  "failure",
  "decision_candidate",
  "implementation_change",
]);

function sanitizeAttention(value: AttentionDecision): AttentionDecision {
  const probabilities: Record<string, number> = {};
  for (const [key, prob] of Object.entries(value.probabilities ?? {})) {
    if (KNOWN_KINDS.has(key)) probabilities[key] = clamp01(prob);
  }
  return {
    ...value,
    importance: clamp01(value.importance),
    relevance: clamp01(value.relevance),
    interruption: clamp01(value.interruption),
    mentalModelChange: clamp01(value.mentalModelChange),
    confidence: clamp01(value.confidence),
    probabilities,
  };
}

export function clampAttention(
  input: AttentionInput,
  model: AttentionDecision,
  pre?: AttentionClamps,
): { value: AttentionDecision; clamps: string[] } {
  const clamps = pre ?? preClampAttention(input);
  const value: AttentionDecision = sanitizeAttention({
    ...model,
    ...clamps.forced,
  });
  if (clamps.forced.interruption !== undefined) {
    value.interruption = Math.max(model.interruption, clamps.forced.interruption);
  }

  const h = input.hints;
  const testOnly = isTestOnly(input.files);
  if (h.destructiveCommands.length > 0) {
    value.shouldSurface = true;
    value.humanDecision = "required";
    value.interruption = Math.max(value.interruption, DESTRUCTIVE_INTERRUPTION_FLOOR);
  }
  if (h.decisionIds.length > 0) {
    value.importance = Math.max(value.importance, DECISION_IMPORTANCE_FLOOR);
    value.relevance = Math.max(value.relevance, DECISION_RELEVANCE_FLOOR);
    value.interruption = Math.max(
      value.interruption,
      DECISION_INTERRUPTION_FLOOR,
    );
    clamps.clamps.push("decision_presence_floor");
  }
  if (h.securityPaths.length > 0) {
    value.shouldSurface = true;
    if (!testOnly && h.decisionIds.length === 0) {
      value.semanticCategory = "security_change";
    }
  }
  if (h.schemaPaths.length > 0) {
    value.shouldSurface = true;
  }
  if (h.publicExports.length > 0) {
    value.shouldSurface = true;
    if (value.semanticCategory !== "security_change" && !clamps.clamps.includes("public_api")) {
      value.semanticCategory = "api_change";
    }
  }
  if (value.humanDecision === "required") {
    value.interruption = Math.max(
      value.interruption,
      REQUIRED_DECISION_INTERRUPTION_FLOOR,
    );
  }
  if (input.status === "failed") {
    value.relevance = Math.max(value.relevance, FAILED_UNIT_RELEVANCE_FLOOR);
  }
  const suppressed = isSuppressed(input);
  if (suppressed.suppressed && !hasSurfaceFloor(input)) {
    value.shouldSurface = false;
    if (suppressed.reason === "formatting" || suppressed.reason === "lockfile") {
      value.importance = Math.min(value.importance, NOISE_TRIAD_CAP.importance);
      value.relevance = Math.min(value.relevance, NOISE_TRIAD_CAP.relevance);
      value.interruption = Math.min(
        value.interruption,
        NOISE_TRIAD_CAP.interruption,
      );
      value.mentalModelChange = Math.min(
        value.mentalModelChange,
        NOISE_TRIAD_CAP.mentalModelChange,
      );
      clamps.clamps.push(`noise_triad_cap_${suppressed.reason}`);
    }
  }
  return { value, clamps: clamps.clamps };
}

const ATTENTION_RANK: Record<UIIntent["attention"], number> = {
  background: 0,
  surface: 1,
  highlight: 2,
  interrupt: 3,
};

export interface ProjectionClamps {
  forced: Partial<UIIntent>;
  clamps: string[];
}

export function clampProjection(
  input: ProjectionInput,
  model: UIIntent,
): { value: UIIntent; clamps: string[] } {
  const value: UIIntent = { ...model };
  const clamps: string[] = [];

  if (input.status === "failed" && ATTENTION_RANK[value.attention] < ATTENTION_RANK.surface) {
    value.attention = "surface";
    clamps.push("failed_unit_attention");
  }
  if (
    input.attention.humanDecision === "required" &&
    ATTENTION_RANK[value.attention] < ATTENTION_RANK.interrupt
  ) {
    value.attention = "interrupt";
    clamps.push("required_decision_attention");
  }
  const attention = model.attention as string;
  if (
    !ATTENTION_LEVELS.includes(attention as (typeof ATTENTION_LEVELS)[number])
  ) {
    value.attention = "surface";
    clamps.push("attention_sanitize");
  }
  return { value, clamps };
}
