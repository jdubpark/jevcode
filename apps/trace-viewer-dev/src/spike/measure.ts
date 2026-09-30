export interface Drops { frames: number; p95Rounded: number; droppedFraction: number; pass: boolean }
export interface Rect { x: number; y: number; width: number; height: number }
export interface Risk1 { events: number; maxAnchorDriftPx: number; maxVisualScale: number; maxScroll: number }
export interface Risk5 { frames: number; maxDriftPx: number; redraws: number; dprChanges: number }
export interface SpikeResults { csp: string[]; scrollResets: number; risk1?: Risk1; risk5?: Risk5 }
export interface SpikeRun {
  sweep?(willChange: boolean): Promise<Drops & { willChange: boolean }>;
  settleAt?(k: number): Promise<{ k: number; dpr: number; frame: Rect; reference: Rect }>;
  hideReference?(): Promise<void>;
  strokeCheck?(): Promise<{ k: number; renderedPx: number }[]>;
  rulerSync?(): Promise<{ maxTickDriftPx: number }>;
  keyboardWalk?(presses: number): Promise<{ presses: number; failures: number; scrollResets: number }>;
  overviewDrift?(): Promise<Risk5>;
  switchCheck?(): Promise<{ toggles: number; storeEqual: boolean; maxCenterDriftPx: number; hiddenRafCallbacks: number; zeroFits: number }>;
}

declare global {
  interface Window { __spike?: SpikeResults; __spikeRun?: SpikeRun }
}

export function results(): SpikeResults {
  window.__spike ??= { csp: [], scrollResets: 0 };
  return window.__spike;
}

export function spikeRun(): SpikeRun {
  window.__spikeRun ??= {};
  return window.__spikeRun;
}

export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0;
}

/** Spec §10: each rAF interval rounded to whole refresh intervals; pass = ≤ 5% dropped and p95 ≤ 1 interval. */
export function roundedDrops(stamps: readonly number[], refreshMs = 1_000 / 60): Drops {
  const rounded: number[] = [];
  for (let i = 1; i < stamps.length; i += 1) {
    const a = stamps[i - 1] ?? 0;
    const b = stamps[i] ?? 0;
    rounded.push(Math.max(1, Math.round((b - a) / refreshMs)));
  }
  const total = rounded.reduce((sum, r) => sum + r, 0);
  const dropped = rounded.reduce((sum, r) => sum + (r - 1), 0);
  const p95Rounded = percentile(rounded, 0.95);
  const droppedFraction = total === 0 ? 0 : dropped / total;
  return { frames: rounded.length, p95Rounded, droppedFraction, pass: droppedFraction <= 0.05 && p95Rounded <= 1 };
}

export function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

export async function frames(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await nextFrame();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function rectOf(r: DOMRect): Rect {
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}
