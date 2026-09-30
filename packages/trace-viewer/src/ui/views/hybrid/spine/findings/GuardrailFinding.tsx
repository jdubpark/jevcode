import { clampMeta, displayUntrusted } from "../../../../../model/index.js";
import { Icon } from "../../../../icons/Icon.js";
import type { FindingBodyProps } from "../Spine.js";
import styles from "../Spine.module.css";

export function GuardrailFinding({ finding }: FindingBodyProps) {
  return (
    <div className={styles.findingBody}>
      {finding.clampId === undefined ? null : (
        <p className={styles.chain}>
          <Icon name="shield" size={14} />
          <span>{clampMeta(finding.clampId).label}</span>
        </p>
      )}
      <p className={styles.findingText}>{displayUntrusted(finding.reason)}</p>
    </div>
  );
}
