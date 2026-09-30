import { displayUntrusted, formatDuration, normalizeCommand } from "../../../../../model/index.js";
import { ClaimVsObserved } from "../../../../graphics/ClaimVsObserved.js";
import { Icon } from "../../../../icons/Icon.js";
import type { FindingBodyProps } from "../Spine.js";
import styles from "../Spine.module.css";

export function ClaimFinding({ finding, session, onJump }: FindingBodyProps) {
  const claim = finding.claim;
  if (claim === undefined) return <p className={styles.findingText}>{displayUntrusted(finding.reason)}</p>;
  const evidenceId = finding.evidenceStepIds?.[0] ?? claim.observed.stepId;
  const evidence = session.steps.find((step) => step.id === evidenceId);
  const gapMs = Math.max(0, claim.claim.tMs - ((evidence?.tMs ?? claim.observed.tMs) + (evidence?.durationMs ?? 0)));
  const gap = formatDuration(gapMs);
  return (
    <div className={styles.findingBody}>
      <p className={styles.chain}>
        <span className={styles.srOnly}>{`Claim made ${gap} after the failing run`}</span>
        <span className={styles.chainIconBad}>
          <Icon name="test" size={14} />
        </span>
        <span className={styles.chainLine} aria-hidden="true" />
        <Icon name="quote" size={14} />
        <span aria-hidden="true">{gap}</span>
      </p>
      <ClaimVsObserved
        size="sm"
        claim={{ text: claim.claim.text, span: finding.claimSpan, tMs: claim.claim.tMs }}
        observed={{
          passed: claim.observed.passed,
          failed: claim.observed.failed,
          command: displayUntrusted(normalizeCommand(claim.observed.command)),
          tMs: claim.observed.tMs,
        }}
        onObservedClick={() => onJump(evidenceId)}
        observedTabIndex={-1}
      />
    </div>
  );
}
