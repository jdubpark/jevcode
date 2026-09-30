import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { DevHost } from "./host.js";
import { writeSwitchSelftest } from "./selftest-canvas.js";

const root = document.getElementById("root");
if (root === null) throw new Error("dev host: #root is missing");

createRoot(root).render(
  <StrictMode>
    <DevHost search={window.location.search} hash={window.location.hash} />
  </StrictMode>,
);

// C3-12 (spec §10 "View switch"): waits for the Canvas, presses 1/2 twenty times, writes <pre id="selftest">.
if (new URLSearchParams(window.location.search).get("selftest") === "switch") void writeSwitchSelftest();
