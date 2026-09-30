import { StrictMode, useState, type JSX } from "react";
import { createRoot } from "react-dom/client";

import { CanvasHarness } from "./CanvasHarness";
import { results } from "./measure";
import { OverviewHarness } from "./OverviewHarness";
import styles from "./spike.module.css";
import { SwitchHarness } from "./SwitchHarness";
import { buildScene, parseBench } from "./synthetic";

const params = new URLSearchParams(window.location.search);
const scene = buildScene(parseBench(params.get("bench")));
const roundK = params.get("roundK");
const settleRoundK = roundK === null ? null : Number(roundK);
type HarnessId = "canvas" | "overview" | "switch";
const HARNESSES: readonly HarnessId[] = ["canvas", "overview", "switch"];
const requested = params.get("harness");
const initialHarness: HarnessId = HARNESSES.find((h) => h === requested) ?? "canvas";

document.addEventListener("securitypolicyviolation", (event) => {
  results().csp.push(`${event.violatedDirective} ${event.blockedURI}`);
});
results();

function App(): JSX.Element {
  const [harness, setHarness] = useState<HarnessId>(initialHarness);
  return (
    <div className={styles.app}>
      <nav className={styles.bar} aria-label="Spike harness">
        {HARNESSES.map((id) => (
          <button key={id} type="button" aria-pressed={harness === id} onClick={() => setHarness(id)}>{id}</button>
        ))}
        <span className={styles.meta}>{`${scene.frames.length} frames · ${scene.edges.length} edges · ${scene.marks.length} marks`}</span>
      </nav>
      {harness === "overview" ? <OverviewHarness scene={scene} /> : null}
      {harness === "switch" ? <SwitchHarness scene={scene} /> : null}
      {harness === "canvas" ? <CanvasHarness scene={scene} settleRoundK={settleRoundK} /> : null}
    </div>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("spike: #root is missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
