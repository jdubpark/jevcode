import { memo, useMemo } from "react";
import type React from "react";

import type { CanvasFrame } from "../../../layout/canvas-layout.js";
import type { Level } from "../../../model/index.js";
import { Icon } from "../../icons/Icon.js";
import styles from "./Frame.module.css";
import { FrameContent } from "./frame-content.js";
import { frameModel, type FrameContext } from "./frame-label.js";

export interface FrameProps {
  frame: CanvasFrame;
  level: Level;
  ctx: FrameContext;
  selected: boolean;
  /** The one frame with tabindex 0 (roving). */
  focusTarget: boolean;
  expanded: boolean;
  /**
   * The source's now() while Live and not terminal; running duration bars grow to it. Omitted: bars stay put.
   * The parent (C3-7, C3-10) passes it only to frames with a running step (`frameRunning`), so the 1 Hz tick
   * re-renders those frames alone; it keeps `onSelect` and `onToggle` stable for the same reason.
   */
  nowMs?: number | null;
  onSelect(frame: CanvasFrame): void;
  onToggle(frame: CanvasFrame): void;
}

function FrameView(props: FrameProps): React.JSX.Element {
  const { frame, level, ctx, selected, focusTarget, expanded, nowMs, onSelect, onToggle } = props;
  // Every derivation (steps, tone, flag, graphic, label, fill) runs once per (frame, ctx, level).
  const model = useMemo(() => frameModel(frame, ctx, level), [frame, ctx, level]);
  const className = [styles.frame, level === "session" ? styles.chip : undefined, frame.kind === "noise" ? styles.noise : undefined]
    .filter((name): name is string => name !== undefined)
    .join(" ");
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // Spec §7.9: Enter expands or collapses the focused frame. Space stays the temporary hand tool.
    if (event.key !== "Enter" || event.target !== event.currentTarget || event.nativeEvent.isComposing) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    onToggle(frame);
  };
  return (
    <div
      role="group"
      aria-label={model.label}
      aria-current={selected ? "true" : undefined}
      tabIndex={focusTarget ? 0 : -1}
      data-key={frame.key}
      data-kind={frame.kind}
      data-item={frame.item}
      data-level={level}
      data-tone={model.tone}
      data-selected={selected ? "" : undefined}
      data-expanded={expanded ? "" : undefined}
      className={className}
      style={{ left: frame.card.x, top: frame.card.y, width: frame.card.w, height: frame.card.h }}
      onClick={() => onSelect(frame)}
      onDoubleClick={() => onToggle(frame)}
      onKeyDown={onKeyDown}
    >
      <span className={styles.iconOnly} aria-hidden="true">
        <Icon name={model.icon} size={16} />
      </span>
      <div className={styles.body}>
        <FrameContent frame={frame} level={level} ctx={ctx} model={model} expanded={expanded} nowMs={nowMs} />
      </div>
    </div>
  );
}

/** A canvas frame in world coordinates; its label, handles and time chip live in the screen-space overlay. */
export const Frame = memo(FrameView);
