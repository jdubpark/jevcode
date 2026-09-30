import { useEffect, useRef } from "react";

import styles from "./Shell.module.css";

export const SHORTCUTS: ReadonlyArray<readonly [keys: string, action: string]> = [
  ["j / k", "Next or previous item"],
  ["J / K", "Next or previous chapter"],
  ["[ / ]", "Previous or next turn"],
  ["n / N", "Next or previous finding"],
  ["Enter / Esc", "Expand or collapse; Esc steps back"],
  ["1 / 2", "Canvas / Hybrid"],
  ["Alt+1 / 2 / 3", "Session / Chapter / Step"],
  [", / .", "Move the playhead one step"],
  ["g / G", "First item / last item; G follows a running session"],
  ["- / = / 0", "Zoom out / in / back to the level preset"],
  ["Shift+1 / Shift+2", "Fit all / zoom to the selection"],
  ["v / h / hold Space", "Select tool / hand tool / pan"],
  ["{ / } / b", "Brush start / end / chapter (Hybrid)"],
  ["/ / ?", "Search / this sheet"],
  ["F6", "Next region"],
  ["Cmd+C", "Copy a review note"],
];

export function ShortcutSheet({ onClose }: { onClose(): void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div role="dialog" aria-modal="false" aria-label="Keyboard shortcuts" className={styles.sheet}>
      <div className={styles.sheetHeader}>
        <h2 className={styles.sheetTitle}>Keyboard shortcuts</h2>
        <button ref={closeRef} type="button" className={styles.button} onClick={onClose}>
          Close
        </button>
      </div>
      <dl className={styles.sheetList}>
        {SHORTCUTS.map(([keys, action]) => (
          <div key={keys} className={styles.sheetRow}>
            <dt className={styles.sheetKeys}>{keys}</dt>
            <dd className={styles.sheetAction}>{action}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
