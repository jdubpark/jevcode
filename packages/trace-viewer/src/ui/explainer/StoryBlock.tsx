import type { NarrativeSentence } from "@jevcode/contracts";
import type { JSX } from "react";

import { displayUntrusted } from "../../model/index.js";
import { CitationChips } from "./CitationChips.js";
import styles from "./explainer.module.css";

/**
 * Narrator sentences (untrusted): plain text through displayUntrusted with the full text as the tooltip, each with its
 * citation chips. A rule-based story (ruling F1) carries a quiet "rule-based" label; narrator text carries none.
 */
export function StoryBlock({
  sentences,
  label,
  provenance,
}: {
  sentences: readonly NarrativeSentence[];
  label: string;
  provenance?: "rule" | "model";
}): JSX.Element {
  return (
    <div className={styles.storyWrap}>
      <ol className={styles.story} aria-label={label}>
        {sentences.map((item, index) => {
          const text = displayUntrusted(item.text);
          return (
            <li key={index} className={styles.storyLine}>
              <span title={text}>{text}</span>
              <CitationChips citations={item.citations} />
            </li>
          );
        })}
      </ol>
      {provenance === "rule" ? <span className={styles.provenance}>rule-based</span> : null}
    </div>
  );
}
