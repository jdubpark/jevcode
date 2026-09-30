import { normalizeCommand } from "./format.js";
import { clampMeta, READ_TOOL, severityRank } from "./registry.js";
import {
  PROBLEM_KINDS,
  type Chapter,
  type Gap,
  type NoiseReason,
  type ProblemKind,
  type Step,
  type Turn,
} from "./types.js";

// Problems are orthogonal to kind; noise is never set on a step with a problem or a finding (R10).

function isRun(step: Step): boolean {
  return step.kind === "command" || step.kind === "test" || step.kind === "check";
}

/** A guardrail step with a warning or critical clamp (CLAMP_META; unknown ids are info). Only these
 *  anchor a guardrail_clamp finding; an info-only step is pipeline noise. */
export function hasSevereClamp(step: Step): boolean {
  return (step.guardrail?.clampIds ?? []).some((id) => severityRank(clampMeta(id).severity) >= severityRank("warning"));
}

/** A guardrail step with a critical clamp: the rule blocked something. Only these carry the
 *  guardrail problem, so a warning clamp keeps its finding but never paints red (spec §7.12). */
export function hasBlockingClamp(step: Step): boolean {
  return (step.guardrail?.clampIds ?? []).some((id) => clampMeta(id).severity === "critical");
}

/** Rule-derived problems of one step. claim_contradicted comes from the claim_contradicted signal. */
export function problemsOf(step: Step): ProblemKind[] {
  const found = new Set<ProblemKind>();
  const exitCode = step.command?.exitCode;
  if (isRun(step) && exitCode !== null && exitCode !== undefined && exitCode > 0) found.add("exit_nonzero");
  if (step.tests !== undefined && step.tests.failed > 0) found.add("tests_failed");
  if (step.kind === "lifecycle" && step.status === "failed") found.add("agent_failed");
  if (step.command?.destructivePattern !== undefined) found.add("destructive");
  if (step.kind === "guardrail" && hasBlockingClamp(step)) found.add("guardrail");
  if (step.problems.includes("claim_contradicted")) found.add("claim_contradicted");
  return PROBLEM_KINDS.filter((kind) => found.has(kind));
}

export function applyProblems(steps: readonly Step[]): void {
  for (const step of steps) step.problems = problemsOf(step);
}

/** A turn is closed when it ended, a later turn exists, or the session is not live. */
export function isTurnClosed(turn: Turn, lastTurnIndex: number, live: boolean): boolean {
  return !live || turn.index < lastTurnIndex || turn.outcome === "completed" || turn.outcome === "failed" || turn.outcome === "interrupted";
}

/** missing_evidence (closed turns only): a finished test run with no test_result, or an agent
 *  edit claim with no repo fact by the end of its turn. */
export function flagMissingEvidence(steps: readonly Step[], turns: readonly Turn[], live: boolean, gaps: Gap[]): void {
  const lastTurnIndex = turns.length - 1;
  const closed = new Set(turns.filter((turn) => isTurnClosed(turn, lastTurnIndex, live)).map((turn) => turn.index));
  for (const step of steps) {
    if (!closed.has(step.turnIndex)) continue;
    if (step.kind === "test" && step.endTs !== null && step.tests === undefined) {
      gaps.push({
        kind: "missing_evidence",
        atSeq: step.firstSeq,
        message: `${step.target ?? "test run"} finished but no test result was recorded`,
      });
    }
    if (step.kind === "edit" && step.edit !== undefined && step.edit.claimed && !step.edit.observed) {
      step.status = "unknown";
      gaps.push({
        kind: "missing_evidence",
        atSeq: step.firstSeq,
        message: `the agent reported a change to ${step.edit.path} but no repository change was observed`,
      });
    }
  }
}

export interface NoiseContext {
  /** duplicate_poll edit steps. */
  duplicates: ReadonlySet<string>;
  chapters: readonly Chapter[];
}

function lastRunByTarget(steps: readonly Step[]): Map<string, Step> {
  const last = new Map<string, Step>();
  for (const step of steps) {
    if ((step.kind === "test" || step.kind === "check") && step.target !== undefined) {
      last.set(normalizeCommand(step.target), step);
    }
  }
  return last;
}

export function noiseOf(step: Step, context: NoiseContext, lastRuns: ReadonlyMap<string, Step>, superseded: ReadonlySet<string>): NoiseReason | null {
  switch (step.kind) {
    case "read":
      return "read";
    case "tool":
      return step.target !== undefined && READ_TOOL.test(step.target) ? "read" : null;
    case "edit": {
      if (context.duplicates.has(step.id)) return "duplicate_poll";
      if (step.edit?.lockfile === true) return "lockfile";
      if (step.edit?.formattingOnly === true) return "formatting";
      if (step.chapterIds.length > 0 && step.chapterIds.every((id) => superseded.has(id))) return "superseded";
      return null;
    }
    case "lifecycle":
      return "lifecycle";
    case "attention":
      // Jev pipeline rows, not agent lifecycle: the spine names them "pipeline events" (spec §6.6).
      return "pipeline";
    case "guardrail":
      // Routine suppress_formatting and suppress_lockfile rows collapse (spec §6.6, §6.7).
      return hasSevereClamp(step) ? null : "pipeline";
    case "test":
    case "check": {
      if (step.status !== "ok" || step.target === undefined) return null;
      const last = lastRuns.get(normalizeCommand(step.target));
      return last !== undefined && last.id !== step.id ? "passing_test" : null;
    }
    default:
      return null;
  }
}

/** Runs after signals: a step with a problem or a finding never collapses. */
export function applyNoise(steps: readonly Step[], context: NoiseContext): void {
  const lastRuns = lastRunByTarget(steps);
  const superseded = new Set(context.chapters.filter((chapter) => chapter.status === "superseded").map((chapter) => chapter.id));
  for (const step of steps) {
    step.noise =
      step.problems.length > 0 || step.findingIds.length > 0 ? null : noiseOf(step, context, lastRuns, superseded);
  }
}
