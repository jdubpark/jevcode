import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { DevHost } from "./host.js";

const root = document.getElementById("root");
if (root === null) throw new Error("dev host: #root is missing");

createRoot(root).render(
  <StrictMode>
    <DevHost search={window.location.search} hash={window.location.hash} />
  </StrictMode>,
);
