import { useRef, type KeyboardEvent } from "react";

import { LEVELS, type Level } from "../../../model/index.js";
import { useDispatch, useView } from "../../state/store.js";
import type { FocusBy } from "../../state/view-state.js";
import styles from "./shared.module.css";

export const LEVEL_LABEL: Record<Level, string> = { session: "Session", chapter: "Chapter", step: "Step" };

/**
 * Session | Chapter | Step segmented control writing the shared level (spec §7.2).
 * `by` names the view that owns the gesture so the store can decide whether to leave Live.
 * WAI-ARIA radio group: arrows move and check the neighbour (wrapping) and focus follows.
 * The radios stay out of the tab order: `Alt+1/2/3` is the keyboard path, so `main` keeps one tab stop.
 */
export function LevelControl({ by }: { by: FocusBy }) {
  const level = useView((state) => state.level);
  const dispatch = useDispatch();
  const radios = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const position = LEVELS.indexOf(level);
    const nextIndex = (position + delta + LEVELS.length) % LEVELS.length;
    const next = LEVELS[nextIndex];
    if (next === undefined) return;
    dispatch({ type: "level/set", level: next, by });
    radios.current[nextIndex]?.focus();
  };
  return (
    <div role="radiogroup" aria-label="Level" className={styles.segmented} onKeyDown={onKeyDown}>
      {LEVELS.map((item, index) => (
        <button
          key={item}
          ref={(node) => {
            radios.current[index] = node;
          }}
          type="button"
          role="radio"
          aria-checked={item === level}
          tabIndex={-1}
          className={styles.segment}
          onClick={() => dispatch({ type: "level/set", level: item, by })}
        >
          {LEVEL_LABEL[item]}
        </button>
      ))}
    </div>
  );
}
