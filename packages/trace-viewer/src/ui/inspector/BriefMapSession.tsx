import type { ReactNode } from "react";
import type React from "react";

import type { Role } from "@jevcode/contracts";

import { displayUntrusted, type TraceSession } from "../../model/index.js";
import { Icon } from "../icons/Icon.js";
import { ROLE_ICON } from "../icons/kind-icons.js";
import { MARK_WORD, mapOverlayOf, type MapCardState } from "../views/map/overlay.js";
import mapStyles from "../views/map/MapView.module.css";
import styles from "./Brief.module.css";
import rows from "./BriefMapSession.module.css";

/** Present while the Map is the shown view: the Brief lists the session's components instead of the thumbnail. */
export interface BriefMapSession {
  selectedId: string | null;
  onSelectComponent(id: string): void;
}

interface SessionRow {
  id: string;
  name: string;
  role: Role;
  states: readonly MapCardState[];
}

/**
 * The highlighted components that are on the map, sorted by displayed name and then id (a stable order that does not
 * change when a state does). Empty without an overlay.
 */
function sessionRowsOf(session: TraceSession): SessionRow[] {
  const overlay = mapOverlayOf(session);
  const overview = session.overview;
  if (overlay === null || overview === null) return [];
  const out: SessionRow[] = [];
  for (const [id, states] of overlay.cardState) {
    const component = overview.componentById.get(id);
    if (component !== undefined) out.push({ id, name: displayUntrusted(component.name), role: component.role, states });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The Brief's last part (spec §3.3 item 3). On the Map, with highlights, the Map is already on screen, so it lists
 * "This session" (the mockup's c-map-overlay Brief) and activating a row selects the component on the Map. Otherwise, and
 * outside the Map, it is lane 06's Architecture part, passed as children.
 */
export function BriefArchitectureSection({
  id,
  session,
  mapSession,
  children,
}: {
  id: string;
  session: TraceSession;
  mapSession: BriefMapSession | undefined;
  children: ReactNode;
}): React.JSX.Element {
  const list = mapSession === undefined ? [] : sessionRowsOf(session);
  const onMap = mapSession !== undefined && list.length > 0;
  return (
    <section className={styles.part} aria-labelledby={`${id}-architecture`}>
      <h3 id={`${id}-architecture`} className={styles.partTitle}>
        <Icon name="route" size={14} />
        {onMap ? `This session · ${list.length} ${list.length === 1 ? "component" : "components"}` : "Architecture"}
      </h3>
      {onMap ? (
        <ul className={rows.list} aria-label="Components touched this session" data-brief-session="">
          {list.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className={rows.row}
                data-selected={row.id === mapSession.selectedId ? "" : undefined}
                data-brief-session-row={row.id}
                title={row.name}
                aria-label={`${row.name}, ${row.states.map((state) => MARK_WORD[state]).join(" and ")}`}
                onClick={() => mapSession.onSelectComponent(row.id)}
              >
                <Icon name={ROLE_ICON[row.role]} size={14} />
                <span className={rows.name}>{row.name}</span>
                <span className={mapStyles.marks} aria-hidden="true">
                  {row.states.map((state) => (
                    <span key={state} className={mapStyles.stateDot} data-state={state} />
                  ))}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        children
      )}
    </section>
  );
}
