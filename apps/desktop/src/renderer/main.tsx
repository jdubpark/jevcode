import { PERF } from "@jevcode/trace-viewer";
import React from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";
import { App } from "./App.js";
import { applyViewerTokens } from "./theme.js";
import { createPaintProbe, installPaintProbe } from "./workspace/paint-probe.js";

// The embedded viewer measures first paint, full load and live ticks from this mark (as trace/main.tsx does).
performance.mark(PERF.bundleParsed);

// Smoke only: main loads the window with ?smoke=1 for JEVCODE_SMOKE_WORKSPACE (D-6).
if (new URLSearchParams(window.location.search).get("smoke") === "1" && typeof PerformanceObserver !== "undefined") {
  const probe = createPaintProbe({
    now: () => performance.now(),
    timeOrigin: performance.timeOrigin,
    log: (line) => console.log(line),
  });
  installPaintProbe(probe);
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) probe.onEntry(entry);
  }).observe({ entryTypes: ["measure"] });
}

applyViewerTokens(document.documentElement);

const container = document.getElementById("root");
if (!container) {
  throw new Error("missing #root element");
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
