import type { SelectionId, TraceIndex } from "../../layout/trace-index.js";
import {
  compareFindings,
  displayUntrusted,
  KIND_META,
  type Finding,
  type FindingId,
  type SignalId,
  type Step,
  type TraceSession,
} from "../../model/index.js";

export const FINDING_TITLE = {
  claim_contradicted: "Claim contradicts tests",
  failing_tests: "Tests failed",
  destructive_command: "Destructive command",
  guardrail_clamp: "Guardrail clamp",
  recovery_arc: "Recovered after a failure",
} as const satisfies Record<SignalId, string>;

const byIdCache = new WeakMap<TraceSession, ReadonlyMap<FindingId, Finding>>();

function findingMap(session: TraceSession): ReadonlyMap<FindingId, Finding> {
  let map = byIdCache.get(session);
  if (map === undefined) {
    map = new Map(session.findings.map((finding) => [finding.id, finding]));
    byIdCache.set(session, map);
  }
  return map;
}

function stepFindings(session: TraceSession, step: Step): Finding[] {
  const map = findingMap(session);
  return step.findingIds.map((id) => map.get(id)).filter((finding): finding is Finding => finding !== undefined);
}

/** Findings anchored at the step (anchor rule): only these may title, tone or fill the step's own surfaces. */
export function findingsOf(session: TraceSession, step: Step): Finding[] {
  return stepFindings(session, step)
    .filter((finding) => finding.anchorStepId === step.id)
    .sort(compareFindings);
}

/** Findings that cite the step without being anchored there; they appear as Related or evidence, never as its title. */
export function citingFindingsOf(session: TraceSession, step: Step): Finding[] {
  return stepFindings(session, step)
    .filter((finding) => finding.anchorStepId !== step.id)
    .sort(compareFindings);
}

export function topFindingOf(session: TraceSession, step: Step): Finding | null {
  return findingsOf(session, step)[0] ?? null;
}

/** Finding-first title (spec §7.1). Chapter and decision titles carry paths and agent text, so they pass through displayUntrusted. */
export function selectionTitle(session: TraceSession, index: TraceIndex, id: SelectionId): string {
  const entry = index.entry(id);
  if (entry?.kind === "chapter") {
    const chapter = session.chapters[entry.position];
    return chapter === undefined ? "Chapter" : displayUntrusted(chapter.title);
  }
  const step = entry === undefined ? undefined : session.steps[entry.position];
  if (step === undefined) return "Step";
  const finding = topFindingOf(session, step);
  if (finding !== null) return FINDING_TITLE[finding.ruleId];
  if (step.kind === "decision" && step.decision !== undefined) return displayUntrusted(step.decision.title);
  return KIND_META[step.kind].label;
}
