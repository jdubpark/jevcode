import { Activity } from "react";

import { useDispatch, useView } from "../state/store.js";
import type { ViewDefinition } from "../views/view-port.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { useDiagnostics } from "./session-context.js";
import styles from "./Shell.module.css";

export interface ViewSlotProps {
  views: readonly ViewDefinition[];
  /** true: hidden views stay mounted under <Activity mode="hidden"> (spec §7.8 item 4). */
  keepHiddenMounted: boolean;
}

export function ViewSlot({ views, keepHiddenMounted }: ViewSlotProps) {
  const current = useView((state) => state.view);
  const dispatch = useDispatch();
  const diagnostics = useDiagnostics();
  const shown = views.some((view) => view.kind === current) ? current : views[0]?.kind;
  if (views.length === 0) return <div className={styles.emptyView} />;
  return (
    <>
      {views.map((definition) => {
        const active = definition.kind === shown;
        if (!active && !keepHiddenMounted) return null;
        const other = views.find((view) => view.kind !== definition.kind);
        const body = (
          <div className={styles.view} data-view={definition.kind}>
            <ErrorBoundary
              region={definition.label}
              onError={(error) => diagnostics.reportError(`${definition.label}: ${error.message}`)}
              action={
                other === undefined
                  ? undefined
                  : { label: `Switch to ${other.label}`, onAction: () => dispatch({ type: "view/switch", view: other.kind }) }
              }
            >
              <definition.Component active={active} />
            </ErrorBoundary>
          </div>
        );
        return keepHiddenMounted ? (
          <Activity key={definition.kind} mode={active ? "visible" : "hidden"}>
            {body}
          </Activity>
        ) : (
          <div key={definition.kind} className={styles.view}>
            {body}
          </div>
        );
      })}
    </>
  );
}
