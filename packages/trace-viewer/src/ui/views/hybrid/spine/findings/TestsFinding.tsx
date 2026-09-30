import { displayUntrusted } from "../../../../../model/index.js";
import type { FindingBodyProps } from "../Spine.js";
import styles from "../Spine.module.css";

export function TestsFinding({ finding, session }: FindingBodyProps) {
  const members = new Set<string>(finding.stepIds);
  const failures = session.steps.filter((step) => members.has(step.id)).flatMap((step) => step.tests?.failures ?? []);
  return (
    <div className={styles.findingBody}>
      <p className={styles.findingText}>{displayUntrusted(finding.reason)}</p>
      <ul className={styles.failures}>
        {failures.slice(0, 3).map((failure, position) => (
          <li key={`${failure.file}:${position}`} className={styles.failure}>
            <div>{failure.testName}</div>
            <div className={styles.mono}>{displayUntrusted(failure.message.split("\n")[0] ?? "")}</div>
            <div className={styles.mono}>{displayUntrusted(failure.file)}</div>
          </li>
        ))}
      </ul>
      {failures.length > 3 ? <p className={styles.why}>{`${failures.length - 3} more`}</p> : null}
    </div>
  );
}
