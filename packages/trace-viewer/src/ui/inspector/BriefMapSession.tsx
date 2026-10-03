import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
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

const NO_ROWS: readonly SessionRow[] = [];

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
  const { explainer, overview } = session;
  // sessionRowsOf reads only the overlay (explainer highlights) and the overview.
  const rowsOfSession = useMemo(() => sessionRowsOf(session), [explainer, overview]);
  const list = mapSession === undefined ? NO_ROWS : rowsOfSession;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const heldRef = useRef<{ id: string; element: HTMLElement } | null>(null);
  // A focused row whose component leaves the list is removed; focus goes to the section heading, not to body. The
  // heading's own document is read, not the global one: the viewer can sit in a popout window.
  useLayoutEffect(() => {
    const held = heldRef.current;
    if (held === null || held.element.isConnected) return;
    heldRef.current = null;
    const heading = headingRef.current;
    if (heading === null) return;
    const doc = heading.ownerDocument;
    const active = doc.activeElement;
    if (active === null || active === doc.body) heading.focus({ preventScroll: true });
  }, [list]);
  const onMap = mapSession !== undefined && list.length > 0;
  return (
    <section className={styles.part} aria-labelledby={`${id}-architecture`}>
      <h3 ref={headingRef} tabIndex={-1} id={`${id}-architecture`} className={styles.partTitle}>
        <Icon name="route" size={14} />
        {onMap ? `This session · ${list.length} ${list.length === 1 ? "component" : "components"}` : "Architecture"}
      </h3>
      {onMap ? (
        <ul
          className={rows.list}
          aria-label="Components touched this session"
          data-brief-session=""
          onFocus={(event) => {
            const row = (event.target as HTMLElement).closest<HTMLElement>("[data-brief-session-row]");
            if (row !== null) heldRef.current = { id: row.dataset.briefSessionRow ?? "", element: row };
          }}
          onBlur={(event) => {
            // Focus moved on, or the row is still there: nothing to repair. A removed row keeps `held` for the effect.
            if (event.relatedTarget !== null || (event.target as HTMLElement).isConnected) heldRef.current = null;
          }}
        >
          {list.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className={rows.row}
                data-selected={row.id === mapSession.selectedId ? "" : undefined}
                aria-current={row.id === mapSession.selectedId ? "true" : undefined}
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
