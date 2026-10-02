import { useEffect, useLayoutEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";

import { TRACE_LIVE_POLL_MS } from "@jevcode/contracts";

import { emptyTraceIndex } from "../../layout/trace-index.js";
import type { TraceSource } from "../../source.js";
import type { ViewerLocation } from "../state/location.js";
import { createViewStore, ViewStoreContext } from "../state/store.js";
import { initialViewState, type ViewKind } from "../state/view-state.js";
import base from "../tokens/base.module.css";
import { tokenStyle } from "../tokens/tokens.js";
import { composeViews, openingView } from "../views/registry.js";
import type { ViewDefinition } from "../views/view-port.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { createDataController } from "./data-controller.js";
import type { ViewerHost } from "./host.js";
import { Shell } from "./Shell.js";
import { HostViewSwitch } from "./ViewSwitch.js";

export type ViewerChrome = "full" | "embedded";

export interface TraceViewerProps {
  source: TraceSource;
  host?: ViewerHost;
  location?: ViewerLocation;
  /** Poll interval while not terminal; default TRACE_LIVE_POLL_MS (1,000). */
  pollMs?: number;
  /** Overrides "running opens in Live"; the dev-host selftest passes false. */
  initialFollow?: boolean;
  /** "embedded": the main window places the viewer under its own header: no title, no Outline (spec §8.5). Default "full". */
  chrome?: ViewerChrome;
  /** Host-registered views, appended after the built-in views (spec §8.5). Pass a stable array. */
  hostViews?: readonly ViewDefinition[];
  /** The opening view when the location names none; default "console" when embedded, else "hybrid". */
  initialView?: ViewKind;
  /** Embedded only: receives the view switcher (deviation 8), and null on unmount. Pass a stable function. */
  renderSwitch?: (switcher: ReactNode) => void;
}

/** The viewer's only entry point. Reads through `source`; writes nothing. */
export function TraceViewer({
  source,
  host,
  location,
  pollMs,
  initialFollow,
  chrome = "full",
  hostViews,
  initialView,
  renderSwitch,
}: TraceViewerProps) {
  const views = useMemo(() => composeViews(hostViews), [hostViews]);
  const [controller] = useState(() => createDataController({ source, pollMs: pollMs ?? TRACE_LIVE_POLL_MS }));
  const [store] = useState(() =>
    createViewStore(
      initialViewState({ live: false, location, view: openingView(views, chrome, location?.view, initialView) }),
      emptyTraceIndex(source.sessionId),
    ),
  );
  const shellHost = useMemo<ViewerHost>(() => host ?? {}, [host]);
  const hostPlacesSwitch = chrome === "embedded" && renderSwitch !== undefined;

  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);

  useLayoutEffect(() => {
    if (!hostPlacesSwitch || renderSwitch === undefined) return undefined;
    renderSwitch(<HostViewSwitch store={store} views={views} />);
    return () => renderSwitch(null);
  }, [hostPlacesSwitch, renderSwitch, store, views]);

  return (
    <ViewStoreContext.Provider value={store}>
      <ErrorBoundary
        region="Trace viewer"
        onError={(error) =>
          shellHost.onDiagnostics?.({ errors: [`Trace viewer: ${error.message}`], maxAnchorDriftPx: 0, selectedTitle: null })
        }
        fallbackClassName={base.root}
        fallbackStyle={tokenStyle() as CSSProperties}
      >
        <Shell
          sessionId={source.sessionId}
          host={shellHost}
          controller={controller}
          location={location}
          initialFollow={initialFollow}
          chrome={chrome}
          views={views}
          showSwitch={!hostPlacesSwitch}
        />
      </ErrorBoundary>
    </ViewStoreContext.Provider>
  );
}
