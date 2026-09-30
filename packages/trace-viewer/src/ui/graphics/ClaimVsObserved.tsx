import { memo, type JSX, type ReactNode } from "react";

import { Icon } from "../icons/Icon.js";
import styles from "./graphics.module.css";
import { graphicA11y, type GraphicBaseProps } from "./scales.js";
import { TestDots } from "./TestDots.js";
import { displayUntrusted } from "../../model/index.js";

export interface ClaimVsObservedProps extends GraphicBaseProps {
  claim: { text: string; span?: readonly [number, number]; tMs: number };
  observed: { passed: number; failed: number; command: string; tMs: number };
  onObservedClick?(): void;
  /** Tab index of the observed button (default 0). A caller inside a roving-tabindex region
   *  passes -1 so the region stays one tab stop (spec §7.13). */
  observedTabIndex?: 0 | -1;
}

function ClaimText({ text, span }: { text: string; span?: readonly [number, number] }): JSX.Element {
  if (span === undefined || span[0] < 0 || span[1] > text.length || span[0] >= span[1]) return <>{text}</>;
  return (
    <>
      {text.slice(0, span[0])}
      <span className={styles.span} data-claim-span="">{text.slice(span[0], span[1])}</span>
      {text.slice(span[1])}
    </>
  );
}

function ClaimVsObservedImpl({ size, label, claim, observed, onObservedClick, observedTabIndex }: ClaimVsObservedProps): JSX.Element {
  // Mockup `.obs`: the eye and the dots over "1 failed <command>".
  const content: ReactNode = (
    <>
      <span className={styles.observedTop}>
        <Icon name="eye" size={14} />
        <TestDots size="xs" passed={observed.passed} failed={observed.failed} skipped={0} />
      </span>
      <span className={styles.observedBottom}>
        <span className={observed.failed > 0 ? styles.observedFail : undefined}>{`${observed.failed} failed`}</span>
        <span className={styles.mono}>{displayUntrusted(observed.command)}</span>
      </span>
    </>
  );
  // Unlike the other glyphs, this one can hold a real interactive control (the observed
  // card, when onObservedClick is set — spec: "clicking the observed card moves the
  // playhead to the evidence"). graphicA11y's aria-hidden fallback is only correct for a
  // purely decorative graphic: applying it here would remove that button from the
  // accessibility tree. When interactive, skip the aria-hidden default and, if a label was
  // given, describe the whole widget as a group instead of hiding it.
  const wrapperA11y = onObservedClick === undefined
    ? graphicA11y(label)
    : label !== undefined && label.length > 0
      ? { role: "group" as const, "aria-label": label }
      : {};
  return (
    <span className={`${styles.graphic} ${styles[size]} ${styles.claim}`} {...wrapperA11y}>
      {/* The inner row is what the container query restacks in a narrow panel (the Inspector at 248–280 px). */}
      <span className={styles.claimRow}>
        <span className={styles.bubble}>
          <span className={styles.quote}>
            <Icon name="quote" size={14} />
          </span>
          {/* The line clamp sits on this inner span so the bubble's padding never shows a clipped third line. */}
          <span className={styles.claimText}>
            <ClaimText text={claim.text} span={claim.span} />
          </span>
        </span>
        <span className={styles.neq}>
          <Icon name="neq" size={size === "md" ? 16 : 14} />
        </span>
        {onObservedClick === undefined ? (
          <span className={styles.observed}>{content}</span>
        ) : (
          <button type="button" className={styles.observed} tabIndex={observedTabIndex} onClick={onObservedClick}>
            {content}
          </button>
        )}
      </span>
    </span>
  );
}

export const ClaimVsObserved = memo(ClaimVsObservedImpl);
