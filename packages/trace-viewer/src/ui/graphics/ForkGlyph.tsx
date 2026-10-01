import { memo, type JSX } from "react";

import { displayUntrusted } from "../../model/index.js";
import styles from "./graphics.module.css";
import { graphicA11y, type GraphicBaseProps, type GraphicSize } from "./scales.js";

export interface ForkGlyphProps extends GraphicBaseProps {
  options: readonly { label: string; chosen: boolean }[];
  decidedBy: "supervisor" | "delegated" | "open";
}

const DIMS: Record<GraphicSize, { w: number; h: number }> = { xs: { w: 24, h: 12 }, sm: { w: 32, h: 16 }, md: { w: 40, h: 20 } };
const MAX_BRANCHES = 3;

function pickBranches(options: ForkGlyphProps["options"]): { label: string; chosen: boolean }[] {
  const shown = options.slice(0, MAX_BRANCHES);
  const chosenIndex = options.findIndex((o) => o.chosen);
  if (chosenIndex >= MAX_BRANCHES) {
    const chosen = options[chosenIndex];
    if (chosen !== undefined) shown[MAX_BRANCHES - 1] = chosen;
  }
  return shown;
}

function ForkGlyphImpl({ size, label, options, decidedBy }: ForkGlyphProps): JSX.Element {
  const { w, h } = DIMS[size];
  const branches = pickBranches(options);
  const extra = options.length - branches.length;
  const mid = h / 2;
  const step = branches.length > 1 ? (h - 3) / (branches.length - 1) : 0;
  return (
    <span className={`${styles.graphic} ${styles[size]}`} {...graphicA11y(label)}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" focusable="false">
        <circle className={styles.root} cx={2} cy={mid} r={1.75} />
        {branches.map((branch, i) => {
          const y = branches.length === 1 ? mid : 1.5 + i * step;
          const solid = decidedBy !== "open" && branch.chosen;
          return (
            <path
              key={`${branch.label}:${i}`}
              data-branch={displayUntrusted(branch.label)}
              data-chosen={solid ? "true" : "false"}
              className={solid ? styles.branchChosen : styles.branch}
              strokeDasharray={solid ? undefined : "2 2"}
              d={`M3.5 ${mid}C${w / 2} ${mid} ${w / 2} ${y} ${w - 1.5} ${y}`}
            />
          );
        })}
      </svg>
      {extra > 0 ? <span className={styles.count}>{`+${extra}`}</span> : null}
    </span>
  );
}

export const ForkGlyph = memo(ForkGlyphImpl);
