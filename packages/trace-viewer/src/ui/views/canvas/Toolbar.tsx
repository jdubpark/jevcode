import type React from "react";

import type { Level } from "../../../model/index.js";
import { Icon } from "../../icons/Icon.js";
import type { Tool } from "../../state/view-state.js";
import { LevelSegmented } from "../shared/LevelControl.js";
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
      <LevelSegmented level={props.level} onLevel={props.onLevel} />
      {props.holes > 0 ? (
        <button type="button" tabIndex={-1} className={styles.tidy} onClick={props.onTidy}>
          Tidy layout
        </button>
      ) : null}
    </div>
  );
}
