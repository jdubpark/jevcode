import { displayUntrusted, normalizeCommand, signalMeta } from "../../../../../model/index.js";
import type { FindingBodyProps } from "../Spine.js";
import styles from "../Spine.module.css";

export function DestructiveFinding({ finding, step }: FindingBodyProps) {
  const meta = signalMeta(finding.ruleId);
  const command = step.command === undefined ? displayUntrusted(step.headline) : displayUntrusted(normalizeCommand(step.command.command));
  return (
    <div className={styles.findingBody}>
      <p className={`${styles.findingText} ${styles.mono}`}>{command}</p>
      {finding.matchedPattern === undefined ? null : <p className={styles.why}>{`Matched rule: ${finding.matchedPattern}`}</p>}
      <details className={styles.why}>
        <summary>Why flagged?</summary>
        <p>{meta.rationale}</p>
        {meta.knownFalsePositives.length > 0 ? (
          <ul>
            {meta.knownFalsePositives.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        ) : null}
      </details>
    </div>
  );
}
