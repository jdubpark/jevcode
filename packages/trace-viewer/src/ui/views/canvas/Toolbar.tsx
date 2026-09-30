import { useRef, type KeyboardEvent } from "react";
import type React from "react";

import { LEVELS, type Level } from "../../../model/index.js";
import { Icon } from "../../icons/Icon.js";
import type { Tool } from "../../state/view-state.js";
import { LEVEL_LABEL } from "../shared/LevelControl.js";
import shared from "../shared/shared.module.css";
import styles from "./chrome.module.css";

export interface ToolbarProps {
  tool: Tool;
  level: Level;
  holes: number;
  onTool(tool: Tool): void;
  onLevel(level: Level): void;
  onFit(): void;
  onTidy(): void;
}

export function Toolbar(props: ToolbarProps): React.JSX.Element {
  const radios = useRef<Array<HTMLButtonElement | null>>([]);
  // Same WAI-ARIA radiogroup keys as the shared LevelControl, which reads the store; the canvas view owns level writes.
  const onLevelKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const nextIndex = (LEVELS.indexOf(props.level) + delta + LEVELS.length) % LEVELS.length;
    const next = LEVELS[nextIndex];
    if (next === undefined) return;
    props.onLevel(next);
    radios.current[nextIndex]?.focus();
  };
  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Canvas tools">
      <button
        type="button"
        tabIndex={-1}
        className={styles.tool}
        aria-pressed={props.tool === "select"}
        aria-label="Select (V)"
        title="Select (V)"
        onClick={() => props.onTool("select")}
      >
        <Icon name="cursor" size={16} />
      </button>
      <button
        type="button"
        tabIndex={-1}
        className={styles.tool}
        aria-pressed={props.tool === "hand"}
        aria-label="Hand (H)"
        title="Hand (H)"
        onClick={() => props.onTool("hand")}
      >
        <Icon name="hand" size={16} />
      </button>
      <button type="button" tabIndex={-1} className={styles.tool} aria-label="Fit (Shift+1)" title="Fit (Shift+1)" onClick={props.onFit}>
        <Icon name="fit" size={16} />
      </button>
      <span className={styles.divider} aria-hidden="true" />
      <div className={shared.segmented} role="radiogroup" aria-label="Level" onKeyDown={onLevelKeyDown}>
        {LEVELS.map((level, index) => (
          <button
            key={level}
            ref={(node) => {
              radios.current[index] = node;
            }}
            type="button"
            role="radio"
            tabIndex={-1}
            aria-checked={props.level === level}
            className={shared.segment}
            title={`${LEVEL_LABEL[level]} (Alt+${index + 1})`}
            onClick={() => props.onLevel(level)}
          >
            {LEVEL_LABEL[level]}
          </button>
        ))}
      </div>
      {props.holes > 0 ? (
        <button type="button" tabIndex={-1} className={styles.tidy} onClick={props.onTidy}>
          Tidy layout
        </button>
      ) : null}
    </div>
  );
}
