import { memo, type JSX } from "react";

import styles from "./graphics.module.css";
import { durationPx, graphicA11y, type GraphicBaseProps, type GraphicSize } from "./scales.js";

export interface DurationBarProps extends GraphicBaseProps {
  durationMs: number | null;
  running: boolean;
  /** Running: elapsed so far. Extends any known durationMs (drawn solid) with a hollow bar out to now (spec §7.12); with no known durationMs the whole running bar is hollow. */
  elapsedMs?: number;
  end: "none" | "bad_dot" | "exit_x";
}

const BAR_H: Record<GraphicSize, number> = { xs: 6, sm: 8, md: 10 };
const STROKE = 1.5;
const END_W = 10;

function DurationBarImpl({ size, label, durationMs, running, elapsedMs, end }: DurationBarProps): JSX.Element {
  const h = BAR_H[size];
  // Running: durationMs (when known) is the solid, already-confirmed portion; the growth from
  // there out to elapsedMs ("now") is the hollow extension (spec §7.12). No known durationMs
  // yet (null) means nothing is confirmed, so the whole bar to elapsedMs stays hollow.
  const knownW = running && durationMs !== null ? durationPx(durationMs) : 0;
  const w = running ? durationPx(Math.max(elapsedMs ?? 0, durationMs ?? 0)) : durationPx(durationMs ?? 0);
  // hollowW is 0 (and the hollow rect below is omitted) when elapsedMs does not exceed the
  // known durationMs: nothing has grown past what is already confirmed, so only the solid
  // bar is drawn. That keeps every rendered rect's x + width within the viewBox.
  const hollowW = Math.max(0, w - knownW - STROKE);
  const width = w + (end === "none" ? 0 : END_W);
  const cy = h / 2;
  const ex = w + END_W / 2;
  return (
    <span className={`${styles.graphic} ${styles[size]}`} {...graphicA11y(label)}>
      <svg width={width} height={h} viewBox={`0 0 ${width} ${h}`} aria-hidden="true" focusable="false">
        {running && knownW > 0 ? (
          <rect data-bar="solid" data-tone="neutral" className={styles.bar} x={0} y={0} width={knownW} height={h} rx={1} />
        ) : null}
        {running && hollowW > 0 ? (
          <rect data-bar="hollow" data-tone="neutral" className={styles.hollow}
            x={knownW + STROKE / 2} y={STROKE / 2} width={hollowW} height={h - STROKE} rx={1} />
        ) : null}
        {!running ? (
          <rect data-bar="solid" data-tone="neutral" className={styles.bar} x={0} y={0} width={w} height={h} rx={1} />
        ) : null}
        {end === "bad_dot" ? (
          <circle data-end="bad_dot" data-tone="bad" className={styles.badDot} cx={ex} cy={cy} r={Math.min(3, h / 2)} />
        ) : null}
        {end === "exit_x" ? (
          <path data-end="exit_x" data-tone="neutral" className={styles.exitX}
            d={`M${ex - 2.5} ${cy - 2.5}l5 5M${ex + 2.5} ${cy - 2.5}l-5 5`} />
        ) : null}
      </svg>
    </span>
  );
}

export const DurationBar = memo(DurationBarImpl);
