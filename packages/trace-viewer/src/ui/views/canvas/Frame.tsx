import { memo } from "react";
import type React from "react";

import type { CanvasFrame } from "../../../layout/canvas-layout.js";
import type { Level } from "../../../model/index.js";
import { Icon } from "../../icons/Icon.js";
import styles from "./Frame.module.css";
import { FrameContent } from "./frame-content.js";
import { frameIcon, frameLabel, frameTone, type FrameContext } from "./frame-label.js";

export interface FrameProps {
  frame: CanvasFrame;
  level: Level;
  ctx: FrameContext;
  selected: boolean;
  /** The one frame with tabindex 0 (roving). */
  focusTarget: boolean;
  expanded: boolean;
  /** The source's now() while Live and not terminal; running duration bars grow to it. Omitted: bars stay put. */
  nowMs?: number | null;
  onSelect(frame: CanvasFrame): void;
  onToggle(frame: CanvasFrame): void;
}

function FrameView(props: FrameProps): React.JSX.Element {
  const { frame, level, ctx, selected, focusTarget, expanded, nowMs, onSelect, onToggle } = props;
  const className = [styles.frame, level === "session" ? styles.chip : undefined, frame.kind === "noise" ? styles.noise : undefined]
    .filter((name): name is string => name !== undefined)
    .join(" ");
  return (
    <div
      role="group"
      aria-label={frameLabel(frame, ctx)}
      aria-current={selected ? "true" : undefined}
      tabIndex={focusTarget ? 0 : -1}
      data-key={frame.key}
      data-kind={frame.kind}
      data-item={frame.item}
      data-level={level}
      data-tone={frameTone(frame, ctx)}
      data-selected={selected ? "" : undefined}
      data-expanded={expanded ? "" : undefined}
      className={className}
      style={{ left: frame.card.x, top: frame.card.y, width: frame.card.w, height: frame.card.h }}
      onClick={() => onSelect(frame)}
      onDoubleClick={() => onToggle(frame)}
    >
      <span className={styles.iconOnly} aria-hidden="true">
        <Icon name={frameIcon(frame, ctx)} size={16} />
      </span>
      <div className={styles.body}>
        <FrameContent frame={frame} level={level} ctx={ctx} expanded={expanded} nowMs={nowMs} />
      </div>
    </div>
  );
}

/** A canvas frame in world coordinates; its label, handles and time chip live in the screen-space overlay. */
export const Frame = memo(FrameView);
