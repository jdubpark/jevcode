import type { NarrativeSentence } from "@jevcode/contracts";
import type { JSX } from "react";

import { displayUntrusted } from "../../model/index.js";
import { CitationChips } from "./CitationChips.js";
import styles from "./explainer.module.css";

/**
 * Narrator sentences (untrusted): plain text through displayUntrusted with the full text as the tooltip, each with its
 * citation chips. A rule-based story (ruling F1) carries a quiet "rule-based" label; narrator text carries none.
 */
/** The DOM id of sentence `index` in a StoryBlock given `id`: an aria-labelledby that lists these names only the sentences, never the citation chips. */
export function storySentenceId(id: string, index: number): string {
  return `${id}:s${index}`;
}

/** The space-separated ids of a StoryBlock's first `count` sentences, for an enclosing element's aria-labelledby. */
export function storySentenceIds(id: string, count: number): string {
  return Array.from({ length: count }, (_, index) => storySentenceId(id, index)).join(" ");
}

export function StoryBlock({
  id,
  sentences,
  label,
  provenance,
  tabbable = true,
}: {
  /** Set where the sentences name an enclosing element (a Console summary row's aria-labelledby, via storySentenceIds); then no label. */
  id?: string;
  sentences: readonly NarrativeSentence[];
  label?: string;
  provenance?: "rule" | "model";
  /** false keeps the citation chips out of the tab order (CitationChips `tabbable`). Default true. */
  tabbable?: boolean;
}): JSX.Element {
  return (
    <div className={styles.storyWrap}>
      <ol className={styles.story} aria-label={label}>
        {sentences.map((item, index) => {
          const text = displayUntrusted(item.text);
          return (
            <li key={index} className={styles.storyLine}>
              <span {...(id !== undefined ? { id: storySentenceId(id, index) } : {})} title={text}>{text}</span>
              <CitationChips citations={item.citations} tabbable={tabbable} />
            </li>
          );
        })}
      </ol>
      {provenance === "rule" ? <span className={styles.provenance}>rule-based</span> : null}
    </div>
  );
}
