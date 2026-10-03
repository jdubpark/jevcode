import { useEffect, useRef } from "react";

import { displayUntrusted } from "../../model/index.js";
import { useView } from "../state/store.js";
import { useAnnounce } from "./LiveRegion.js";
import { useSessionView } from "./session-context.js";

/**
 * Lane fix m6 (spec §7.13): a decision that becomes pending after the session loaded is announced once, through the one
 * polite live region, whichever view is shown. Decisions already open at load are not news. New decision steps arrive
 * at the end of the step list, so each commit scans only the steps that start after the last one it saw. It resumes by
 * seq, not by position: absorbing an answer message (removeStep) can shrink the list in the same commit that appends.
 */
export function DecisionAnnouncer(): null {
  const { session, index } = useSessionView();
  const loaded = useView((state) => state.loaded);
  const announce = useAnnounce();
  const known = useRef<Set<string> | null>(null);
  /** firstSeq of the last step scanned. */
  const scannedSeq = useRef(0);

  useEffect(() => {
    if (session === null || !loaded) return;
    const baseline = known.current === null;
    const seen = known.current ?? new Set<string>();
    known.current = seen;
    const steps = session.steps;
    for (let i = baseline ? 0 : index.stepIndexAtOrAfter(scannedSeq.current + 1); i < steps.length; i += 1) {
      const step = steps[i];
      if (step === undefined) continue;
      scannedSeq.current = Math.max(scannedSeq.current, step.firstSeq);
      const decision = step.decision;
      if (decision === undefined || seen.has(decision.decisionId)) continue;
      seen.add(decision.decisionId);
      if (!baseline && decision.status === "open") announce(`Decision needed: ${displayUntrusted(decision.title)}`);
    }
  }, [session, index, loaded, announce]);

  return null;
}
