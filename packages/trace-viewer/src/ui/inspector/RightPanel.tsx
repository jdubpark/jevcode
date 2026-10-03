import { useContext, useEffect, useLayoutEffect, useRef, type JSX } from "react";

import type { ViewerHost } from "../shell/host.js";
import { ErrorBoundary } from "../shell/ErrorBoundary.js";
import { useView, useViewStore } from "../state/store.js";
import type { ViewState } from "../state/view-state.js";
import { ViewPortRegistryContext } from "../views/view-port.js";
import { Brief } from "./Brief.js";
import { Inspector } from "./Inspector.js";

/** Spec §3.3, E4: the panel shows the Brief whenever nothing is selected or Shift+B pinned it. */
export function showsBrief(state: ViewState): boolean {
  return state.selection === null || state.brief;
}

function isNowhere(doc: Document): boolean {
  const active = doc.activeElement;
  return active === null || active === doc.body || active === doc.documentElement;
}

/**
 * Spec §3.3, E4: the Brief whenever nothing is selected or Shift+B pinned it; the Inspector for a selection. The two are
 * different trees, so a switch while focus is inside the panel (Esc, Shift+B, a Brief item that selects) would drop
 * focus to <body>: it moves to the Brief, or to the active view's tab stop when the Inspector comes back (lane fix I-5).
 */
export function RightPanel({ host }: { host: ViewerHost }): JSX.Element {
  const showBrief = useView(showsBrief);
  const store = useViewStore();
  const registry = useContext(ViewPortRegistryContext);
  const wrapper = useRef<HTMLDivElement>(null);
  /** Focus was last inside the panel. Focus that drops when its element is removed fires no event, so this stays set. */
  const focusInside = useRef(false);

  useEffect(() => {
    const node = wrapper.current;
    const doc = node?.ownerDocument;
    if (node === null || doc === undefined) return undefined;
    focusInside.current = node.contains(doc.activeElement);
    const onFocusIn = (event: FocusEvent): void => {
      focusInside.current = event.target instanceof Node && node.contains(event.target);
    };
    doc.addEventListener("focusin", onFocusIn);
    return () => doc.removeEventListener("focusin", onFocusIn);
  }, []);

  const shown = useRef(showBrief);
  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = showBrief;
    const node = wrapper.current;
    const doc = node?.ownerDocument;
    if (before === showBrief || !focusInside.current || node === null || doc === undefined || !isNowhere(doc)) return;
    if (showBrief) {
      node.querySelector<HTMLElement>("[data-brief]")?.focus({ preventScroll: true });
      return;
    }
    registry?.get(store.get().view)?.focusSelected();
    if (isNowhere(doc)) {
      const scope: ParentNode = node.closest("[data-trace-viewer]") ?? doc;
      scope.querySelector<HTMLElement>('[data-region="main"]')?.focus({ preventScroll: true });
    }
  }, [showBrief]);

  return (
    // display: contents keeps the panel's layout as it was; the element only scopes the focus bookkeeping.
    <div ref={wrapper} style={{ display: "contents" }}>
      {showBrief ? (
        <ErrorBoundary region="Brief">
          <Brief />
        </ErrorBoundary>
      ) : (
        <Inspector host={host} />
      )}
    </div>
  );
}
