import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AgentStateSchema } from "@jevcode/contracts";

const root = document.getElementById("root");
if (root === null) throw new Error("dev host: #root is missing");

createRoot(root).render(
  <StrictMode>
    <main>
      <h1>Trace viewer dev host</h1>
      <p>Agent states: {AgentStateSchema.options.join(", ")}.</p>
    </main>
  </StrictMode>,
);
