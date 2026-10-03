import { useEffect, useRef } from "react";

import { displayUntrusted } from "../../model/index.js";
import { useView } from "../state/store.js";
import { useAnnounce } from "./LiveRegion.js";
import { useSessionView } from "./session-context.js";

/**
 * Lane fix m6 (spec §7.13): a decision that becomes pending after the session loaded is announced once, through the one
 * polite live region, whichever view is shown. Decisions already open at load are not news. New decision steps arrive
 * at the end of the step list, so each commit scans only the steps it has not seen.
 */
export function DecisionAnnouncer(): null {
  const { session } = useSessionView();
  const loaded = useView((state) => state.loaded);
  const announce = useAnnounce();
  const known = useRef<Set<string> | null>(null);
  const scanned = useRef(0);

  useEffect(() => {
    if (session === null || !loaded) return;
    const baseline = known.current === null;
    const seen = known.current ?? new Set<string>();
    known.current = seen;
    const steps = session.steps;
    for (let i = baseline ? 0 : Math.min(scanned.current, steps.length); i < steps.length; i += 1) {
      const decision = steps[i]?.decision;
      if (decision === undefined || seen.has(decision.decisionId)) continue;
      seen.add(decision.decisionId);
      if (!baseline && decision.status === "open") announce(`Decision needed: ${displayUntrusted(decision.title)}`);
    }
    scanned.current = steps.length;
  }, [session, loaded, announce]);

  return null;
}
