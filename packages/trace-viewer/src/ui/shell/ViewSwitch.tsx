import { useContext, useRef, type CSSProperties, type KeyboardEvent } from "react";

import { Icon } from "../icons/Icon.js";
import { useDispatch, useView, ViewStoreContext, type ViewStore } from "../state/store.js";
import { tokenStyle } from "../tokens/tokens.js";
import { viewKeyOf, ViewDefinitionsContext, type ViewDefinition } from "../views/view-port.js";
import styles from "./TitleBar.module.css";

/** WAI-ARIA radio group: the checked view is the one tab stop; arrows (wrapping), Home and End check and focus. */
export function ViewSwitch() {
  const views = useContext(ViewDefinitionsContext);
  const dispatch = useDispatch();
  const view = useView((state) => state.view);
  const radios = useRef<Array<HTMLButtonElement | null>>([]);
  if (views.length < 2) return null;
  const checked = Math.max(0, views.findIndex((definition) => definition.kind === view));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const count = views.length;
    let target: number;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") target = (checked + 1) % count;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") target = (checked - 1 + count) % count;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = count - 1;
    else return;
    event.preventDefault();
    const next = views[target];
    if (next === undefined) return;
    if (next.kind !== view) dispatch({ type: "view/switch", view: next.kind });
    radios.current[target]?.focus();
  };
  return (
    <div role="radiogroup" aria-label="View" className={styles.segmented} onKeyDown={onKeyDown}>
      {views.map((definition, position) => {
        const key = viewKeyOf(definition.kind, views);
        return (
          <button
            key={definition.kind}
            ref={(node) => {
              radios.current[position] = node;
            }}
            type="button"
            role="radio"
            aria-checked={definition.kind === view}
            aria-keyshortcuts={key === null ? undefined : String(key)}
            tabIndex={position === checked ? 0 : -1}
            className={styles.segment}
            title={key === null ? definition.label : `${definition.label} (${key})`}
            onClick={() => dispatch({ type: "view/switch", view: definition.kind })}
          >
            <Icon name={definition.icon} size={14} />
            <span>{definition.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The viewer store each host-placed switcher belongs to, so a viewer's key layer accepts only its own switcher. */
const switchOwners = new WeakMap<Element, ViewStore>();

export function isOwnSwitchTarget(target: Element, store: ViewStore): boolean {
  const wrapper = target.closest("[data-trace-viewer-switch]");
  return wrapper !== null && switchOwners.get(wrapper) === store;
}

/**
 * The switcher a host places itself (TraceViewerProps.renderSwitch, deviation 8). It carries the viewer's store, view
 * list and tokens, so it works anywhere in the host's tree; its icons resolve against the Shell's sprite. It is marked
 * data-trace-viewer like the Shell's root, so a host's style guard skips it as it skips the viewer (E M-4).
 */
export function HostViewSwitch({ store, views }: { store: ViewStore; views: readonly ViewDefinition[] }) {
  return (
    <ViewStoreContext.Provider value={store}>
      <ViewDefinitionsContext.Provider value={views}>
        <div
          className={styles.hostSwitch}
          style={tokenStyle() as CSSProperties}
          data-trace-viewer=""
          data-trace-viewer-switch=""
          ref={(node) => {
            if (node !== null) switchOwners.set(node, store);
          }}
        >
          <ViewSwitch />
        </div>
      </ViewDefinitionsContext.Provider>
    </ViewStoreContext.Provider>
  );
}
