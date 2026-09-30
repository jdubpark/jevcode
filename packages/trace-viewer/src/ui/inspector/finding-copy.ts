import type { SelectionId, TraceIndex } from "../../layout/trace-index.js";
import {
  compareFindings,
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

export function findingsOf(session: TraceSession, step: Step): Finding[] {
  const map = findingMap(session);
  return step.findingIds
    .map((id) => map.get(id))
    .filter((finding): finding is Finding => finding !== undefined)
    .sort(compareFindings);
}

export function topFindingOf(session: TraceSession, step: Step): Finding | null {
  return findingsOf(session, step)[0] ?? null;
}

/** Finding-first title (spec §7.1). Chapter titles and decision titles are pipeline text; agent text never fills this slot. */
export function selectionTitle(session: TraceSession, index: TraceIndex, id: SelectionId): string {
  const entry = index.entry(id);
  if (entry?.kind === "chapter") return session.chapters[entry.position]?.title ?? "Chapter";
  const step = entry === undefined ? undefined : session.steps[entry.position];
  if (step === undefined) return "Step";
  const finding = topFindingOf(session, step);
  if (finding !== null) return FINDING_TITLE[finding.ruleId];
  if (step.kind === "decision" && step.decision !== undefined) return step.decision.title;
  return KIND_META[step.kind].label;
}
