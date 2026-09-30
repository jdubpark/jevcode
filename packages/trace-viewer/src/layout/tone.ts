import { compareFindings, type Finding, type FindingId, type Severity, type Step } from "../model/index.js";

export type Tone = "neutral" | "bad" | "good";

const SEVERITY_RANK: { readonly [S in Severity]: number } = { info: 0, warning: 1, critical: 2 };

/**
 * The anchor rule (spec §7.1, §7.6.3), in one place: a step's findingIds hold the findings anchored at it and the ones
 * that only cite it as evidence (signals.ts attaches both). Only anchored findings title, tone, fill or open the step's
 * own surfaces; citing findings appear as Related or evidence. Both lists come in FINDING_ORDER (compareFindings).
 */
export function anchoredFindings(step: Step, findingsById: ReadonlyMap<FindingId, Finding>): Finding[] {
  return findingsOf(step, findingsById, true);
}

export function citingFindings(step: Step, findingsById: ReadonlyMap<FindingId, Finding>): Finding[] {
  return findingsOf(step, findingsById, false);
}

function findingsOf(step: Step, findingsById: ReadonlyMap<FindingId, Finding>, anchored: boolean): Finding[] {
  const out: Finding[] = [];
  for (const id of step.findingIds) {
    const finding = findingsById.get(id);
    if (finding !== undefined && (finding.anchorStepId === step.id) === anchored) out.push(finding);
  }
  return out.length > 1 ? out.sort(compareFindings) : out;
}

/** Worst severity of the findings anchored at the step (a finding that only cites it does not count). */
export function worstSeverity(step: Step, findingsById: ReadonlyMap<FindingId, Finding>): Severity | null {
  let worst: Severity | null = null;
  for (const id of step.findingIds) {
    const finding = findingsById.get(id);
    if (finding === undefined || finding.anchorStepId !== step.id) continue;
    if (worst === null || SEVERITY_RANK[finding.severity] > SEVERITY_RANK[worst]) worst = finding.severity;
  }
  return worst;
}

/** bad: failed test/check, agent_failed, a guardrail problem (a critical, blocking clamp), or anchoring a critical finding;
 *  good: passed test/check; a command with exit > 0 and a warning or info clamp stay neutral (§7.12). */
export function stepTone(step: Step, findingsById: ReadonlyMap<FindingId, Finding>): Tone {
  if (worstSeverity(step, findingsById) === "critical") return "bad";
  const testLike = step.kind === "test" || step.kind === "check";
  if (testLike && step.status === "failed") return "bad";
  if (step.problems.includes("tests_failed") || step.problems.includes("agent_failed") || step.problems.includes("guardrail")) return "bad";
  if (testLike && step.status === "ok") return "good";
  return "neutral";
}

/** critical → bad, else neutral. */
export function findingTone(finding: Finding): Tone {
  return finding.severity === "critical" ? "bad" : "neutral";
}
