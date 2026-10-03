import type React from "react";

import { HIGHLIGHT_STATES } from "../../../model/index.js";
import { Icon } from "../../icons/Icon.js";
import type { MapCardState } from "./overlay.js";
import styles from "./MapView.module.css";

/** The approved H3 legend words (c-map-overlay.html): a decision card reads "decided". */
const LEGEND_WORD: { readonly [K in MapCardState]: string } = { new: "new", changed: "changed", decision: "decided", failing: "failing" };

export interface MapSessionToggleProps {
  counts: Readonly<Record<MapCardState, number>>;
  on: boolean;
  onToggle(): void;
}

/** The Map's session overlay switch (spec §3.4 "with the session overlay on") and its legend. */
export function MapSessionToggle({ counts, on, onToggle }: MapSessionToggleProps): React.JSX.Element {
  return (
    <>
      <button type="button" className={styles.sessionToggle} aria-pressed={on} onClick={onToggle}>
        <Icon name="jev" size={12} />
        Session
      </button>
      {on ? (
        <ul className={styles.sessionLegend} aria-label="Session overlay legend">
          {HIGHLIGHT_STATES.filter((state) => counts[state] > 0).map((state) => (
            <li key={state}>
              <span className={styles.stateDot} data-state={state} data-legend="" aria-hidden="true" />
              <span>{`${counts[state]} ${LEGEND_WORD[state]}`}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
