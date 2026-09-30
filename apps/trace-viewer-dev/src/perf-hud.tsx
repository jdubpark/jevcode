import { useEffect, useState } from "react";

import { PERF } from "@jevcode/trace-viewer";

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

function readStats(): Stat[] {
  return Object.values(PERF).map((name) => {
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

function press(code: string, key: string, init: KeyboardEventInit = {}): void {
  document.body.dispatchEvent(new KeyboardEvent("keydown", { code, key, bubbles: true, cancelable: true, ...init }));
}

/** Spec §10 "j to painted": 300 presses at Chapter level, alternating runs of j and k. */
async function runKeys(): Promise<void> {
  performance.clearMeasures(PERF.keyToPaint);
  press("Digit2", "2", { altKey: true });
  await nextFrame();
  for (let i = 0; i < 300; i += 1) {
    const forward = i % 100 < 50;
    press(forward ? "KeyJ" : "KeyK", forward ? "j" : "k");
    await nextFrame();
    await nextFrame();
  }
}

/** Spec §10 "Overview layout + paint": a scripted pan and zoom sweep at Session level. */
async function runSweep(): Promise<void> {
  const lanes = document.querySelector<HTMLElement>("[data-overview-lanes]");
  if (lanes === null) return;
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
}

function overlayNodes(): number {
  return document.querySelectorAll("[data-overlay-node]").length;
}

export function PerfHud({ autorun }: { autorun: boolean }) {
  const [stats, setStats] = useState<Stat[]>(readStats);
  const [nodes, setNodes] = useState({ overlay: 0, total: 0, maxOverlay: 0 });
  const [result, setResult] = useState<string>("");
  const [busy, setBusy] = useState(false);

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

  const run = async (task: () => Promise<void>): Promise<void> => {
    setBusy(true);
    await task();
    setBusy(false);
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
        await runSweep();
        clearInterval(sampler);
        if (!cancelled) setResult(JSON.stringify({ stats: readStats(), maxOverlayNodes: maxOverlay }));
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
            for (const name of Object.values(PERF)) performance.clearMeasures(name);
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
