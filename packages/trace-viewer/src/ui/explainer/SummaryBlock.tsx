import type { NarrativeSentence } from "@jevcode/contracts";
import type { JSX } from "react";

import { useDispatch } from "../state/store.js";
import styles from "./explainer.module.css";
import { StoryBlock } from "./StoryBlock.js";

/**
 * Spec §3.2 summary row: the ◆ marker in the Console's glyph column, then "Summary" (with the quiet "rule-based" label
 * of a rule story beside it, as the H3 mockup shows), the story's sentences, and a link back to the Brief. Clearing the
 * selection shows the Brief (V-2: `ViewState.brief` only pins the Brief over a selection), so the link needs no toggle.
 */
export function SummaryBlock({
  id,
  sentences,
  provenance,
}: {
  id?: string;
  sentences: readonly NarrativeSentence[];
  provenance?: "rule" | "model";
}): JSX.Element {
  const dispatch = useDispatch();
  return (
    <section className={styles.summaryRow} aria-label="Session summary">
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
            onClick={() => dispatch({ type: "select", id: null, by: "shell" })}
          >
            Brief
          </button>
        </div>
        {/* `id` (the row's lineId) names the Console row by its own sentences, so each summary row reads differently. */}
        <StoryBlock {...(id !== undefined ? { id } : { label: "Summary sentences" })} sentences={sentences} />
      </div>
    </section>
  );
}
