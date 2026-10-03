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
  // On the Map a selected component takes the panel (lane 06 deviation 4).
  if (state.view === "map" && state.mapSelection !== null) return false;
  return state.selection === null || state.brief;
}

/** What the panel shows: the Brief, a Map component's Inspector or the step and unit Inspector. */
type PanelContent = "brief" | "component" | "inspector";

function panelContentOf(state: ViewState): PanelContent {
  if (showsBrief(state)) return "brief";
  return state.view === "map" && state.mapSelection !== null ? "component" : "inspector";
}

function isNowhere(doc: Document): boolean {
  const active = doc.activeElement;
  return active === null || active === doc.body || active === doc.documentElement;
}

/**
 * Spec §3.3, E4: the Brief whenever nothing is selected or Shift+B pinned it; the Inspector for a selection. The two are
 * different trees, so a switch while focus is inside the panel (Esc, Shift+B, a Brief item that selects) would drop
 * focus to <body>: it moves to the Brief, or to the active view's tab stop when the Inspector comes back (lane fix I-5).
 * A Map component's Inspector is a third tree: a change row that opens its step keeps focus in the panel, on the step
 * Inspector's tab panel (lane 06 fix, minor 2).
 */
export function RightPanel({ host }: { host: ViewerHost }): JSX.Element {
  const content = useView(panelContentOf);
  const showBrief = content === "brief";
  const store = useViewStore();
  const registry = useContext(ViewPortRegistryContext);
  const wrapper = useRef<HTMLDivElement>(null);
  /** Focus was last inside the panel. Focus that drops because its element was removed leaves this set (see below). */
  const focusInside = useRef(false);

  useEffect(() => {
    const node = wrapper.current;
    const doc = node?.ownerDocument;
    if (node === null || doc === undefined) return undefined;
    focusInside.current = node.contains(doc.activeElement);
    const onFocusIn = (event: FocusEvent): void => {
      focusInside.current = event.target instanceof Node && node.contains(event.target);
    };
    // Focus that leaves for nowhere (a click on empty space) fires no focusin. It is forgotten when the blurred node is
    // still in the document a moment later; a node the panel switch removed (Chrome may fire focusout for it) is gone by
    // then, and that loss is the one the switch effect repairs.
    const onFocusOut = (event: FocusEvent): void => {
      const target = event.target;
      if (!(target instanceof Node) || !node.contains(target)) return;
      if (event.relatedTarget instanceof Node && node.contains(event.relatedTarget)) return;
      queueMicrotask(() => {
        if (target.isConnected) focusInside.current = false;
      });
    };
    doc.addEventListener("focusin", onFocusIn);
    doc.addEventListener("focusout", onFocusOut);
    return () => {
      doc.removeEventListener("focusin", onFocusIn);
      doc.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  const shown = useRef(content);
  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = content;
    const node = wrapper.current;
    const doc = node?.ownerDocument;
    if (before === content || !focusInside.current || node === null || doc === undefined || !isNowhere(doc)) return;
    if (content === "brief") {
      node.querySelector<HTMLElement>("[data-brief]")?.focus({ preventScroll: true });
      return;
    }
    if (before === "component" && content === "inspector") {
      node.querySelector<HTMLElement>('[role="tabpanel"]')?.focus({ preventScroll: true });
      if (!isNowhere(doc)) return;
    }
    registry?.get(store.get().view)?.focusSelected();
    if (isNowhere(doc)) {
      const scope: ParentNode = node.closest("[data-trace-viewer]") ?? doc;
      scope.querySelector<HTMLElement>('[data-region="main"]')?.focus({ preventScroll: true });
    }
  }, [content]);

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
