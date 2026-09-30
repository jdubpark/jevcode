import { memo, type JSX } from "react";

import styles from "./graphics.module.css";
import { graphicA11y, testDotsMode, type GraphicBaseProps, type GraphicSize } from "./scales.js";

export interface TestDotsProps extends GraphicBaseProps { passed: number; failed: number; skipped: number }

const R: Record<GraphicSize, { pass: number; fail: number }> = {
  xs: { pass: 2, fail: 3 },
  sm: { pass: 2.5, fail: 3.5 },
  md: { pass: 3, fail: 4 },
};
const BAR_W = 60;

function TestDotsImpl({ size, label, passed, failed, skipped }: TestDotsProps): JSX.Element {
  const total = passed + failed + skipped;
  const r = R[size];
  const h = r.fail * 2;
  if (testDotsMode(total) === "dots") {
    const states: ("failed" | "passed" | "skipped")[] = [
      ...Array<"failed">(failed).fill("failed"),
      ...Array<"passed">(passed).fill("passed"),
      ...Array<"skipped">(skipped).fill("skipped"),
    ];
    const pitch = r.pass * 2 + 2;
    let x = 0;
    const dots = states.map((state, i) => {
      const radius = state === "failed" ? r.fail : r.pass;
      const cx = x + radius;
      x += radius * 2 + (pitch - r.pass * 2);
      const cls = state === "failed" ? styles.fail : state === "passed" ? styles.pass : styles.skip;
      return <circle key={i} data-state={state} className={cls} cx={cx} cy={h / 2} r={radius} />;
    });
    const width = Math.max(1, x);
    return (
      <span className={`${styles.graphic} ${styles[size]}`} {...graphicA11y(label)}>
        <svg width={width} height={h} viewBox={`0 0 ${width} ${h}`} aria-hidden="true" focusable="false">{dots}</svg>
      </span>
    );
  }
  const segments = [
    { state: "passed", n: passed, cls: styles.pass },
    { state: "failed", n: failed, cls: styles.fail },
    { state: "skipped", n: skipped, cls: styles.skip },
  ] as const;
  let x = 0;
  const rects = segments.filter((s) => s.n > 0).map((s) => {
    const w = Math.max(2, (s.n / total) * BAR_W);
    const rect = <rect key={s.state} data-state={s.state} className={s.cls} x={x} y={h / 2 - 2} width={w} height={4} />;
    x += w;
    return rect;
  });
  return (
    <span className={`${styles.graphic} ${styles[size]}`} {...graphicA11y(label)}>
      <svg width={x} height={h} viewBox={`0 0 ${x} ${h}`} aria-hidden="true" focusable="false">{rects}</svg>
      <span className={styles.count}>{`${passed}/${total}`}</span>
    </span>
  );
}

export const TestDots = memo(TestDotsImpl);
