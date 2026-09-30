import { displayUntrusted, formatDuration, normalizeCommand, type Finding, type TraceSession } from "../../../../../model/index.js";
import { ClaimVsObserved } from "../../../../graphics/ClaimVsObserved.js";
import { Icon } from "../../../../icons/Icon.js";
import type { FindingBodyProps } from "../Spine.js";
import styles from "../Spine.module.css";

function evidenceOf(finding: Finding, session: TraceSession) {
  const claim = finding.claim;
  const evidenceId = finding.evidenceStepIds?.[0] ?? claim?.observed.stepId;
  return { evidenceId, evidence: session.steps.find((step) => step.id === evidenceId) };
}

/** Header extras: `[test] —— [quote] 3.0 s`, the time from the end of the failing run to the claim (spec §7.6.3). */
export function ClaimChain({ finding, session }: FindingBodyProps) {
  const claim = finding.claim;
  if (claim === undefined) return null;
  const { evidence } = evidenceOf(finding, session);
  const gapMs = Math.max(0, claim.claim.tMs - ((evidence?.tMs ?? claim.observed.tMs) + (evidence?.durationMs ?? 0)));
  const gap = formatDuration(gapMs);
  return (
    <span className={styles.chain}>
      <span className={styles.srOnly}>{`Claim made ${gap} after the failing run`}</span>
      <span className={styles.chainIconBad}>
        <Icon name="test" size={14} />
      </span>
      <span className={styles.chainLine} aria-hidden="true" />
      <Icon name="quote" size={14} />
      <span aria-hidden="true">{gap}</span>
    </span>
  );
}

export function ClaimFinding({ finding, session, onJump }: FindingBodyProps) {
  const claim = finding.claim;
  if (claim === undefined) return <p className={styles.findingText}>{displayUntrusted(finding.reason)}</p>;
  const { evidenceId } = evidenceOf(finding, session);
  const target = evidenceId ?? claim.observed.stepId;
  return (
    <ClaimVsObserved
      size="sm"
      claim={{ text: claim.claim.text, span: finding.claimSpan, tMs: claim.claim.tMs }}
      observed={{
        passed: claim.observed.passed,
        failed: claim.observed.failed,
        command: displayUntrusted(normalizeCommand(claim.observed.command)),
        tMs: claim.observed.tMs,
      }}
      onObservedClick={() => onJump(target)}
      observedTabIndex={-1}
    />
  );
}
