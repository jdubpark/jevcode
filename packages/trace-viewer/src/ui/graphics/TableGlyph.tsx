import { memo, type JSX } from "react";

import styles from "./graphics.module.css";
import { graphicA11y, type GraphicBaseProps } from "./scales.js";
import { displayUntrusted } from "./untrusted.js";

export interface TableGlyphProps extends GraphicBaseProps {
  tables: readonly { name: string; role: "new" | "altered"; columns: number }[];
}

function TableGlyphImpl({ size, label, tables }: TableGlyphProps): JSX.Element {
  return (
    <span className={`${styles.graphic} ${styles[size]}`} {...graphicA11y(label)}>
      {tables.slice(0, 2).map((table) => (
        <span key={table.name} className={styles.table} data-table={table.name} data-role={table.role}>
          <svg width={14} height={12} viewBox="0 0 14 12" aria-hidden="true" focusable="false">
            <rect className={styles.hollow} x={0.75} y={0.75} width={12.5} height={10.5} rx={1.5}
              strokeDasharray={table.role === "altered" ? "2 1.5" : undefined} />
            <path className={styles.arrow} d="M0.75 4.25h12.5M5 4.25v7" />
          </svg>
          {size === "xs" ? null : <span className={styles.tableName}>{displayUntrusted(table.name)}</span>}
          {size === "xs" ? null : <span className={styles.count}>{`${table.columns} cols`}</span>}
        </span>
      ))}
    </span>
  );
}

export const TableGlyph = memo(TableGlyphImpl);
