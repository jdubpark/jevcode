import { memo, type JSX } from "react";

import styles from "./graphics.module.css";
import { durationPx, graphicA11y, type GraphicBaseProps, type GraphicSize } from "./scales.js";

export interface DurationBarProps extends GraphicBaseProps {
  durationMs: number | null;
  running: boolean;
  /** Running: elapsed so far, drawn as the hollow extension to now. */
  elapsedMs?: number;
  end: "none" | "bad_dot" | "exit_x";
}

const BAR_H: Record<GraphicSize, number> = { xs: 6, sm: 8, md: 10 };
const STROKE = 1.5;
const END_W = 10;

function DurationBarImpl({ size, label, durationMs, running, elapsedMs, end }: DurationBarProps): JSX.Element {
  const h = BAR_H[size];
  const w = durationPx(running ? (elapsedMs ?? 0) : (durationMs ?? 0));
  const width = w + (end === "none" ? 0 : END_W);
  const cy = h / 2;
  const ex = w + END_W / 2;
  return (
    <span className={`${styles.graphic} ${styles[size]}`} {...graphicA11y(label)}>
      <svg width={width} height={h} viewBox={`0 0 ${width} ${h}`} aria-hidden="true" focusable="false">
        {running ? (
          <rect data-bar="hollow" data-tone="neutral" className={styles.hollow}
            x={STROKE / 2} y={STROKE / 2} width={w - STROKE} height={h - STROKE} rx={1} />
        ) : (
          <rect data-bar="solid" data-tone="neutral" className={styles.bar} x={0} y={0} width={w} height={h} rx={1} />
        )}
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
