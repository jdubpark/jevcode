import { Fragment, memo, type JSX } from "react";

import styles from "./graphics.module.css";
import { graphicA11y, type GraphicBaseProps } from "./scales.js";
import { displayUntrusted } from "../../model/index.js";

export interface FlowGlyphProps extends GraphicBaseProps { nodes: readonly string[]; focus: number }

const MAX_NODES = 3;

function Arrow(): JSX.Element {
  return (
    <svg width={10} height={8} viewBox="0 0 10 8" aria-hidden="true" focusable="false">
      <path className={styles.arrow} d="M1 4h7M5.5 1.5 8 4 5.5 6.5" />
    </svg>
  );
}

function FlowGlyphImpl({ size, label, nodes, focus }: FlowGlyphProps): JSX.Element {
  const shown = nodes.slice(0, MAX_NODES);
  return (
    <span className={`${styles.graphic} ${styles[size]} ${styles.flow}`} {...graphicA11y(label)}>
      {shown.map((node, i) => (
        <Fragment key={`${node}:${i}`}>
          {i > 0 ? <Arrow /> : null}
          <span data-node={node} data-focus={i === focus ? "true" : "false"} className={i === focus ? `${styles.node} ${styles.nodeFocus}` : styles.node}>
            {size === "xs" ? "" : displayUntrusted(node)}
          </span>
        </Fragment>
      ))}
      {nodes.length > MAX_NODES ? <span className={styles.count}>…</span> : null}
    </span>
  );
}

export const FlowGlyph = memo(FlowGlyphImpl);
