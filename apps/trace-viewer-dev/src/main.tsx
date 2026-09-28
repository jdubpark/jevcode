import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { TRACE_ROW_TYPES } from "@jevcode/contracts";
import { TRACE_SCHEMA_VERSION } from "@jevcode/trace-viewer/model";

const root = document.getElementById("root");
if (root === null) throw new Error("dev host: #root is missing");

createRoot(root).render(
  <StrictMode>
    <main>
      <h1>Trace viewer dev host</h1>
      <p>
        Model schema v{TRACE_SCHEMA_VERSION}. Row types: {TRACE_ROW_TYPES.join(", ")}.
      </p>
    </main>
  </StrictMode>,
);
