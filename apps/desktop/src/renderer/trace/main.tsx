import { TRACE_LIVE_POLL_MS } from "@jevcode/contracts";
import { PERF, TraceViewer } from "@jevcode/trace-viewer";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { getBridge } from "../bridge.js";
import { createDesktopViewerHost, sessionIdFromSearch, traceConsoleLine } from "./host.js";
import { createIpcTraceSource } from "./ipc-source.js";

// Chromium logs CSP violations itself; this line also names the directive, and
// main/smoke.ts fails the run on either (spec §8.7).
document.addEventListener("securitypolicyviolation", (event) => {
  console.error(`CSP_VIOLATION ${event.violatedDirective} ${event.blockedURI}`);
});

// The viewer's paint and live-tick entries reach main as console lines
// (TRACE_LOADED for the smoke, TRACE_PERF for docs/perf.md).
if (typeof PerformanceObserver !== "undefined") {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const line = traceConsoleLine(entry);
      if (line !== null) console.log(line);
    }
  }).observe({ entryTypes: ["mark", "measure"] });
}

// The viewer measures tv:first-paint and tv:full-load from this mark; the dev host sets it
// the same way, and without it the measures (and TRACE_PERF lines) are skipped.
performance.mark(PERF.bundleParsed);

const container = document.getElementById("root");
if (!container) {
  throw new Error("missing #root element");
}

const root = createRoot(container);
const sessionId = sessionIdFromSearch(window.location.search);

if (sessionId === null) {
  root.render(<p>No session was given to this trace window.</p>);
} else {
  const bridge = getBridge();
  const source = createIpcTraceSource(bridge.trace, sessionId);
  const host = createDesktopViewerHost(bridge, (line) => console.log(line));
  root.render(
    <StrictMode>
      <TraceViewer key={sessionId} source={source} host={host} pollMs={TRACE_LIVE_POLL_MS} />
    </StrictMode>,
  );
}
