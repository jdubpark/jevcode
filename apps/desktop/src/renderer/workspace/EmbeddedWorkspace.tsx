import { TRACE_LIVE_POLL_MS } from "@jevcode/contracts";
import { TraceViewer } from "@jevcode/trace-viewer";
import type { ViewDefinition } from "@jevcode/trace-viewer";
import { useMemo, useRef } from "react";

import { getBridge } from "../bridge.js";
import { createIpcTraceSource } from "../trace/ipc-source.js";
import { createMainHost } from "./main-host.js";
import { paintProbe } from "./paint-probe.js";
import { surfacesView } from "./surfaces-view.js";

/** Host views after the built-in four; key 4 is Surfaces (spec §3.7, §8.6). */
export const HOST_VIEWS: readonly ViewDefinition[] = [surfacesView];

export interface EmbeddedWorkspaceProps {
  sessionId: string;
  repoRoot: string | null;
  onRequestChanges(text: string): void;
}

/**
 * The main window's center column (spec §9, E2): the trace viewer for one
 * session, Console first, in embedded chrome. The viewer's own title bar
 * carries the view switcher beside Review/Live. The parent keys this component
 * by session id, so a switch unmounts the viewer (its DataController stops and
 * drops its push subscription) and mounts a fresh one on Console. Source and
 * host are created once per session.
 */
export function EmbeddedWorkspace(props: EmbeddedWorkspaceProps) {
  const bridge = getBridge();
  const latest = useRef(props);
  latest.current = props;

  const source = useMemo(() => {
    const base = createIpcTraceSource(bridge.trace, props.sessionId);
    return paintProbe()?.wrap(base) ?? base;
  }, [bridge, props.sessionId]);
  const host = useMemo(
    () =>
      createMainHost({
        bridge,
        sessionId: props.sessionId,
        repoRoot: () => latest.current.repoRoot,
        prefill: (text) => latest.current.onRequestChanges(text),
        log: (line) => console.log(line),
        logLocations: paintProbe() !== null,
      }),
    [bridge, props.sessionId],
  );

  return (
    <div className="workspace-viewer">
      <TraceViewer
        key={props.sessionId}
        source={source}
        host={host}
        chrome="embedded"
        initialView="console"
        hostViews={HOST_VIEWS}
        pollMs={TRACE_LIVE_POLL_MS}
      />
    </div>
  );
}
