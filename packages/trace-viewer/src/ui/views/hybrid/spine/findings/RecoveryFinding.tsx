import { displayUntrusted, formatOffset, type Step } from "../../../../../model/index.js";
import { Icon } from "../../../../icons/Icon.js";
import { KIND_ICON } from "../../../../icons/kind-icons.js";
import type { FindingBodyProps } from "../Spine.js";
import styles from "../Spine.module.css";

export function RecoveryFinding({ finding, session, onJump }: FindingBodyProps) {
  const steps = finding.stepIds
    .map((id) => session.steps.find((step) => step.id === id))
    .filter((step): step is Step => step !== undefined);
  return (
    <div className={styles.findingBody}>
      <p className={styles.findingText}>{displayUntrusted(finding.reason)}</p>
      <div className={styles.steps}>
        {steps.map((step, position) => (
          <span key={step.id} data-recovery-step="" className={styles.steps}>
            {position > 0 ? <span className={styles.chainLine} aria-hidden="true" /> : null}
            <button type="button" tabIndex={-1} className={styles.chevron} onClick={() => onJump(step.id)} aria-label={formatOffset(step.tMs)}>
              <Icon name={KIND_ICON[step.kind]} size={14} />
            </button>
            <span>{formatOffset(step.tMs)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
