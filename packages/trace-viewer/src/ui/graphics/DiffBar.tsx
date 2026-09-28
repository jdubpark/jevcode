import { memo, type JSX } from "react";

import styles from "./graphics.module.css";
import { compactCount, diffSidePx, graphicA11y, type GraphicBaseProps, type GraphicSize } from "./scales.js";

export interface DiffBarProps extends GraphicBaseProps {
  added: number;
  removed: number;
  files?: readonly { path: string; added: number; removed: number }[];
  moreFiles?: number;
}

const BAR_H: Record<GraphicSize, number> = { xs: 6, sm: 8, md: 10 };
const GAP = 2;
const STROKE = 1.5;

function Bars({ added, removed, h }: { added: number; removed: number; h: number }): JSX.Element {
  const a = diffSidePx(added);
  const r = diffSidePx(removed);
  const width = Math.max(1, a + (a > 0 && r > 0 ? GAP : 0) + r);
  const rx = a > 0 && r > 0 ? a + GAP : 0;
  return (
    <svg width={width} height={h} viewBox={`0 0 ${width} ${h}`} aria-hidden="true" focusable="false">
      {a > 0 ? <rect data-side="added" className={styles.added} x={0} y={0} width={a} height={h} rx={1} /> : null}
      {r > 0 ? (
        <rect
          data-side="removed"
          className={styles.removed}
          x={rx + STROKE / 2}
          y={STROKE / 2}
          width={r - STROKE}
          height={h - STROKE}
          rx={1}
        />
      ) : null}
    </svg>
  );
}

function DiffBarImpl({ size, label, added, removed, files, moreFiles }: DiffBarProps): JSX.Element {
  const rows = size !== "xs" && files !== undefined && files.length > 0 ? files.slice(0, 4) : null;
  return (
    <span className={`${styles.graphic} ${styles[size]}`} {...graphicA11y(label)}>
      {rows === null ? (
        <Bars added={added} removed={removed} h={BAR_H[size]} />
      ) : (
        <span className={styles.files}>
          {rows.map((file) => (
            <span key={file.path} className={styles.file} data-file={file.path}>
              <Bars added={file.added} removed={file.removed} h={BAR_H[size]} />
              <span className={styles.path}>{file.path}</span>
            </span>
          ))}
          {moreFiles !== undefined && moreFiles > 0 ? <span className={styles.count}>{`+${moreFiles}`}</span> : null}
        </span>
      )}
      {size !== "xs" ? <span className={styles.count}>{`+${compactCount(added)} −${compactCount(removed)}`}</span> : null}
    </span>
  );
}

export const DiffBar = memo(DiffBarImpl);
