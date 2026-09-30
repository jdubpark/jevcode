import { anchoredFindings, citingFindings } from "../../layout/tone.js";
import { autoExpandingFindings, type SelectionId, type TraceIndex } from "../../layout/trace-index.js";
import {
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

/** Findings anchored at the step (anchor rule, layout/tone.ts): only these may title, tone or fill the step's own surfaces. */
export function findingsOf(session: TraceSession, step: Step): Finding[] {
  return anchoredFindings(step, findingMap(session));
}

/** Findings that cite the step without being anchored there; they appear as Related or evidence, never as its title. */
export function citingFindingsOf(session: TraceSession, step: Step): Finding[] {
  return citingFindings(step, findingMap(session));
}

export function topFindingOf(session: TraceSession, step: Step): Finding | null {
  return findingsOf(session, step)[0] ?? null;
}

export interface RowFinding {
  finding: Finding;
  /** True when the finding takes the row's title slot and node (a critical finding that opens the row); else a badge. */
  titled: boolean;
}

/**
 * The finding a spine row shows: its top anchored finding. A finding that only cites the step (a claim over its test
 * run) belongs to its own anchor row and appears here neither as title nor as badge.
 */
export function rowFindingOf(session: TraceSession, step: Step, findingsById: ReadonlyMap<FindingId, Finding>): RowFinding | null {
  const top = topFindingOf(session, step);
  if (top === null) return null;
  return { finding: top, titled: autoExpandingFindings(step, findingsById).includes(top) };
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
