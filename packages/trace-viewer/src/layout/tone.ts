import type { Finding, FindingId, Severity, Step } from "../model/index.js";

export type Tone = "neutral" | "bad" | "good";

const SEVERITY_RANK: { readonly [S in Severity]: number } = { info: 0, warning: 1, critical: 2 };

export function worstSeverity(step: Step, findingsById: ReadonlyMap<FindingId, Finding>): Severity | null {
  let worst: Severity | null = null;
  for (const id of step.findingIds) {
    const severity = findingsById.get(id)?.severity;
    if (severity !== undefined && (worst === null || SEVERITY_RANK[severity] > SEVERITY_RANK[worst])) worst = severity;
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
