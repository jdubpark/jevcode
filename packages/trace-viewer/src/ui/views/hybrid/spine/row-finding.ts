import { autoExpandingFindings } from "../../../../layout/trace-index.js";
import type { Finding, FindingId, Step, TraceSession } from "../../../../model/index.js";
import { findingsOf } from "../../../inspector/finding-copy.js";

export interface RowFinding {
  finding: Finding;
  /** Anchored findings only, for stepTone: a finding that merely cites the step never colors its node. */
  anchored: ReadonlyMap<FindingId, Finding>;
  /** True when the finding takes the row's title slot and node (a critical finding that opens the row); else a badge. */
  titled: boolean;
}

/**
 * The finding a spine row shows (anchor rule): the top finding anchored on the step. A finding that only cites the
 * step (a claim over its test run) belongs to its own anchor row and appears here neither as title nor as badge.
 */
export function rowFindingOf(session: TraceSession, step: Step, findingsById: ReadonlyMap<FindingId, Finding>): RowFinding | null {
  const own = findingsOf(session, step).filter((finding) => finding.anchorStepId === step.id);
  const top = own[0];
  if (top === undefined) return null;
  return {
    finding: top,
    anchored: new Map(own.map((finding) => [finding.id, finding])),
    titled: autoExpandingFindings(step, findingsById).includes(top),
  };
}
