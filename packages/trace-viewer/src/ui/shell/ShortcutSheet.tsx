import { useContext, useEffect, useRef } from "react";

import { ViewDefinitionsContext, viewKeyOf, type ViewDefinition } from "../views/view-port.js";

import styles from "./Shell.module.css";

type Row = readonly [keys: string, action: string];

const BEFORE_VIEWS: readonly Row[] = [
  ["j / k", "Next or previous item"],
  ["J / K", "Next or previous chapter"],
  ["[ / ]", "Previous or next turn"],
  ["n / N", "Next or previous finding"],
  ["Enter / Esc", "Expand or collapse; Esc steps back"],
];

const AFTER_VIEWS: readonly Row[] = [
  ["Shift+B", "Brief or Inspector for the selection"],
  ["Alt+1 / 2 / 3", "Session / Chapter / Step"],
  [", / .", "Move the playhead one step"],
  ["g / G", "First item / last item; G follows a running session"],
  ["- / = / Shift+0", "Zoom out / in / back to the level preset"],
  ["Shift+1 / Shift+2", "Fit all / zoom to the selection"],
  ["v / h / hold Space", "Select tool / hand tool / pan"],
  ["{ / } / b", "Brush start / end / chapter (Hybrid)"],
  ["/ / ?", "Search / this sheet"],
  ["F6", "Next region"],
  ["Cmd+C", "Copy a review note"],
];

/** One row per registered view (number keys, spec §3.7): the sheet lists only the views this viewer has. */
function viewRows(views: readonly ViewDefinition[]): Row[] {
  const keyed = views.flatMap((view) => {
    const key = viewKeyOf(view.kind, views);
    return key === null ? [] : [{ key, label: view.label }];
  });
  const builtIn = keyed.filter(({ key }) => key < 4);
  const rows: Row[] = [];
  if (builtIn.length > 0) rows.push([builtIn.map(({ key }) => key).join(" / "), builtIn.map(({ label }) => label).join(" / ")]);
  for (const { key, label } of keyed.filter((entry) => entry.key >= 4)) rows.push([String(key), label]);
  return rows;
}

export function shortcutRows(views: readonly ViewDefinition[]): readonly Row[] {
  return [...BEFORE_VIEWS, ...viewRows(views), ...AFTER_VIEWS];
}

export function ShortcutSheet({ onClose }: { onClose(): void }) {
  const views = useContext(ViewDefinitionsContext);
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
        {shortcutRows(views).map(([keys, action]) => (
          <div key={keys} className={styles.sheetRow}>
            <dt className={styles.sheetKeys}>{keys}</dt>
            <dd className={styles.sheetAction}>{action}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
