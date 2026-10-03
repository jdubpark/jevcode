import { useEffect, useRef } from "react";

import { useAnnounce } from "../../shell/LiveRegion.js";
import styles from "./shared.module.css";

export interface NewBadgeProps {
  /** Steps that arrived since the reader left the tail. */
  count: number;
  /** New critical findings among the new steps; shows the red dot. */
  problems: number;
  /** The brush does not follow live: "N new after range". */
  afterRange: boolean;
  /** What `count` counts, in the announcement ("N new steps"); the Console counts rows. */
  noun?: "step" | "row";
  onActivate(): void;
}

const ANNOUNCE_INTERVAL_MS = 10_000;

/**
 * "↓ N new" pill. The visible pill always shows the step count, but the live region announces only findings
 * (spec §7.10 "in Live only findings are announced"): "N new steps, k problems" when `problems` grows, at most
 * once per 10 s. The throttle is trailing, so a growth inside the window is spoken when the window ends.
 * Plain step-count growth is never announced.
 */
export function NewBadge({ count, problems, afterRange, noun = "step", onActivate }: NewBadgeProps) {
  const announce = useAnnounce();
  const announceRef = useRef(announce);
  announceRef.current = announce;
  const seen = useRef({ count: 0, problems: 0 });
  useEffect(() => {
    const previous = seen.current;
    seen.current = { count, problems };
    if (count <= 0 || problems <= 0 || problems <= previous.problems) return;
    const steps = `${count} new ${count === 1 ? noun : `${noun}s`}`;
    const extra = problems > 0 ? `, ${problems} ${problems === 1 ? "problem" : "problems"}` : "";
    announceRef.current(`${steps}${extra}`, { key: "new-steps", minIntervalMs: ANNOUNCE_INTERVAL_MS });
  }, [count, problems, noun]);
  if (count <= 0) return null;
  return (
    <button type="button" className={styles.newBadge} onClick={onActivate}>
      {`↓ ${count} new${afterRange ? " after range" : ""}`}
      {problems > 0 ? (
        <span className={styles.badDot} role="img" aria-label="includes a critical finding" data-testid="new-badge-dot" />
      ) : null}
    </button>
  );
}
