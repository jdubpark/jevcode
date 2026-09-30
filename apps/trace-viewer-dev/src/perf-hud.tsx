import { useEffect, useState } from "react";

import { markAfterPaint, PERF } from "@jevcode/trace-viewer";

import styles from "./host.module.css";

interface Stat {
  name: string;
  count: number;
  median: number | null;
  p95: number | null;
}

function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? null;
}

/**
 * Zero-work floor for "j to painted" (orchestrator ruling, 2026-09-30): a key the viewer ignores, measured the same way
 * as j (keydown timeStamp to the paint of the next frame). The difference between the two is the viewer's own cost.
 */
export const KEY_BASELINE = "tv:key-to-paint-baseline";
const BASELINE_START = "tv:key-start-baseline";
/** Unbound in the keymap, so the viewer does no work for it. */
export const BASELINE_CODE = "KeyQ";

const MEASURES = [...Object.values(PERF), KEY_BASELINE];

function readStats(): Stat[] {
  return MEASURES.map((name) => {
    const durations = performance
      .getEntriesByName(name, "measure")
      .map((entry) => entry.duration)
      .sort((a, b) => a - b);
    return { name, count: durations.length, median: quantile(durations, 0.5), p95: quantile(durations, 0.95) };
  });
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function measureCount(name: string): number {
  return performance.getEntriesByName(name, "measure").length;
}

/** Resolves once `name` has one more measure than `before` (or after 1 s, so a dropped sample never hangs the run). */
async function nextMeasure(name: string, before: number): Promise<void> {
  const deadline = performance.now() + 1_000;
  while (measureCount(name) <= before && performance.now() < deadline) await sleep(4);
}

/** Records the zero-work floor for every press of BASELINE_CODE, wherever it comes from (HUD or a CDP driver). */
function installBaseline(): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== BASELINE_CODE || event.altKey || event.metaKey || event.ctrlKey) return;
    try {
      performance.mark(BASELINE_START, { startTime: event.timeStamp });
    } catch {
      return;
    }
    markAfterPaint(KEY_BASELINE, BASELINE_START);
  };
  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}

function press(code: string, key: string, init: KeyboardEventInit = {}): void {
  document.body.dispatchEvent(new KeyboardEvent("keydown", { code, key, bubbles: true, cancelable: true, ...init }));
}

/**
 * One press the way input arrives (orchestrator ruling): from a macrotask at a random phase of the frame, never inside a
 * requestAnimationFrame callback, which would make every sample span one whole frame by construction. The measure runs
 * from the keydown's timeStamp to the paint of the next frame; the next press waits for it.
 */
async function pressAndWait(code: string, key: string, measure: string): Promise<void> {
  await sleep(Math.random() * 17);
  const before = measureCount(measure);
  press(code, key);
  await nextMeasure(measure, before);
}

/** Spec §10 "j to painted": 300 presses at Chapter level, alternating runs of j and k, then 300 zero-work presses. */
async function runKeys(): Promise<void> {
  performance.clearMeasures(PERF.keyToPaint);
  performance.clearMeasures(KEY_BASELINE);
  press("Digit2", "2", { altKey: true });
  await nextFrame();
  await nextFrame();
  for (let i = 0; i < 300; i += 1) {
    const forward = i % 100 < 50;
    await pressAndWait(forward ? "KeyJ" : "KeyK", forward ? "j" : "k", PERF.keyToPaint);
  }
  for (let i = 0; i < 300; i += 1) await pressAndWait(BASELINE_CODE, "q", KEY_BASELINE);
}

const MISSING_LANES = JSON.stringify({ error: "overview lanes are not mounted; the sweep did not run" });

/** Spec §10 "Overview layout + paint": a scripted pan and zoom sweep at Session level. */
/** Resolves false when the overview lanes are not mounted, so the caller can say so. */
async function runSweep(): Promise<boolean> {
  const lanes = document.querySelector<HTMLElement>("[data-overview-lanes]");
  if (lanes === null) return false;
  press("Digit1", "1", { altKey: true });
  await nextFrame();
  await nextFrame();
  performance.clearMeasures(PERF.overviewPaint);
  const rect = lanes.getBoundingClientRect();
  for (let i = 0; i < 180; i += 1) {
    lanes.dispatchEvent(new WheelEvent("wheel", { deltaX: i % 60 < 30 ? 40 : -40, bubbles: true, cancelable: true }));
    await nextFrame();
  }
  for (let i = 0; i < 180; i += 1) {
    lanes.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: i % 60 < 30 ? -12 : 12,
        ctrlKey: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + 100,
        bubbles: true,
        cancelable: true,
      }),
    );
    await nextFrame();
  }
  return true;
}

function overlayNodes(): number {
  return document.querySelectorAll("[data-overlay-node]").length;
}

export function PerfHud({ autorun }: { autorun: boolean }) {
  const [stats, setStats] = useState<Stat[]>(readStats);
  const [nodes, setNodes] = useState({ overlay: 0, total: 0, maxOverlay: 0 });
  const [result, setResult] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => installBaseline(), []);

  useEffect(() => {
    const id = setInterval(() => {
      setStats(readStats());
      setNodes((current) => {
        const overlay = overlayNodes();
        return { overlay, total: document.getElementsByTagName("*").length, maxOverlay: Math.max(current.maxOverlay, overlay) };
      });
    }, 500);
    return () => clearInterval(id);
  }, []);

  const run = async (task: () => Promise<void | boolean>): Promise<void> => {
    setBusy(true);
    try {
      if ((await task()) === false) setResult(MISSING_LANES);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!autorun) return undefined;
    let cancelled = false;
    const id = setTimeout(() => {
      void (async () => {
        await runKeys();
        let maxOverlay = 0;
        const sampler = setInterval(() => {
          maxOverlay = Math.max(maxOverlay, overlayNodes());
        }, 50);
        const swept = await runSweep();
        clearInterval(sampler);
        if (cancelled) return;
        setResult(swept ? JSON.stringify({ stats: readStats(), maxOverlayNodes: maxOverlay }) : MISSING_LANES);
      })();
    }, 2_500);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [autorun]);

  return (
    <aside className={styles.hud} aria-label="Performance HUD">
      {stats.map((stat) => (
        <div key={stat.name} className={styles.hudRow}>
          <span>{stat.name}</span>
          <span>
            {stat.count === 0
              ? "–"
              : `n ${stat.count} · med ${stat.median?.toFixed(1) ?? "–"} · p95 ${stat.p95?.toFixed(1) ?? "–"} ms`}
          </span>
        </div>
      ))}
      <div className={styles.hudRow}>
        <span>overlay nodes</span>
        <span>{`${nodes.overlay} (max ${nodes.maxOverlay}) · DOM ${nodes.total}`}</span>
      </div>
      <div className={styles.hudActions}>
        <button type="button" className={styles.hudButton} disabled={busy} onClick={() => void run(runKeys)}>
          300 × j/k
        </button>
        <button type="button" className={styles.hudButton} disabled={busy} onClick={() => void run(runSweep)}>
          Overview sweep
        </button>
        <button
          type="button"
          className={styles.hudButton}
          onClick={() => {
            for (const name of MEASURES) performance.clearMeasures(name);
            setStats(readStats());
          }}
        >
          Clear
        </button>
      </div>
      <pre id="perf-result" className={styles.result}>
        {result}
      </pre>
    </aside>
  );
}
