import type { NarrativeSentence } from "@jevcode/contracts";
import type { JSX } from "react";

import { useDispatch } from "../state/store.js";
import styles from "./explainer.module.css";
import { StoryBlock } from "./StoryBlock.js";

/**
 * Spec §3.2 summary row: the ◆ marker in the Console's glyph column, then "Summary" (with the quiet "rule-based" label
 * of a rule story beside it, as the H3 mockup shows), the story's sentences, and a link back to the Brief. Clearing the
 * selection shows the Brief (V-2: `ViewState.brief` only pins the Brief over a selection), so the link needs no toggle.
 * `tabbable={false}` takes the Brief link and the citation chips out of the tab order, so the Console feed keeps one tab
 * stop (E M-1); they stay buttons with their names.
 */
export function SummaryBlock({
  id,
  sentences,
  provenance,
  tabbable = true,
}: {
  id?: string;
  sentences: readonly NarrativeSentence[];
  provenance?: "rule" | "model";
  /** Default true. */
  tabbable?: boolean;
}): JSX.Element {
  const dispatch = useDispatch();
  return (
    // A named group, not a region landmark: a long session has one summary per story refresh (lane review minor 3).
    <div role="group" className={styles.summaryRow} aria-label="Session summary">
      <span className={styles.diamond} aria-hidden="true">
        <span>◆</span>
      </span>
      <div className={styles.summary} data-summary-box="">
        <div className={styles.summaryHead}>
          <span>Summary</span>
          {provenance === "rule" ? <span className={styles.provenance}>rule-based</span> : null}
          <button
            type="button"
            className={styles.briefLink}
            aria-label="Show the Brief"
            {...(tabbable ? {} : { tabIndex: -1 })}
            onClick={() => dispatch({ type: "select", id: null, by: "shell" })}
          >
            Brief
          </button>
        </div>
        {/* `id` (the row's lineId) names the Console row by its own sentences, so each summary row reads differently. */}
        <StoryBlock {...(id !== undefined ? { id } : { label: "Summary sentences" })} sentences={sentences} tabbable={tabbable} />
      </div>
    </div>
  );
}
