import { useEffect, useMemo, useState } from "react";

import { TRACE_LIVE_POLL_MS } from "@jevcode/contracts";

import { emptyTraceIndex } from "../../layout/trace-index.js";
import type { TraceSource } from "../../source.js";
import type { ViewerLocation } from "../state/location.js";
import { createViewStore, ViewStoreContext } from "../state/store.js";
import { initialViewState } from "../state/view-state.js";
import { createDataController } from "./data-controller.js";
import type { ViewerHost } from "./host.js";
import { Shell } from "./Shell.js";

export interface TraceViewerProps {
  source: TraceSource;
  host?: ViewerHost;
  location?: ViewerLocation;
  /** Poll interval while not terminal; default TRACE_LIVE_POLL_MS (1,000). */
  pollMs?: number;
  /** Overrides "running opens in Live"; the dev-host selftest passes false. */
  initialFollow?: boolean;
}

/** The viewer's only entry point. Reads through `source`; writes nothing. */
export function TraceViewer({ source, host, location, pollMs, initialFollow }: TraceViewerProps) {
  const [controller] = useState(() => createDataController({ source, pollMs: pollMs ?? TRACE_LIVE_POLL_MS }));
  const [store] = useState(() =>
    createViewStore(initialViewState({ live: false, location }), emptyTraceIndex(source.sessionId)),
  );
  const shellHost = useMemo<ViewerHost>(() => host ?? {}, [host]);

  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);

  return (
    <ViewStoreContext.Provider value={store}>
      <Shell
        sessionId={source.sessionId}
        host={shellHost}
        controller={controller}
        location={location}
        initialFollow={initialFollow}
      />
    </ViewStoreContext.Provider>
  );
}
