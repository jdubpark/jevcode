// Canvas checks for the dev-host selftest (C3-12). They read only the DOM, so they run against the built viewer.

export function canvasViewport(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-tv-viewport="canvas"]');
}

function hasArea(element: Element): boolean {
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
}

export interface CanvasDriftProbe {
  sample(): void;
  stop(): number;
}

interface Camera {
  tx: number;
  ty: number;
  k: number;
}

/** The camera the overlay was last written with; CanvasView writes the world transform in the same call. */
function overlayCamera(viewport: HTMLElement): Camera | null {
  const overlay = viewport.querySelector<HTMLElement>("[data-tv-overlay]");
  if (overlay === null) return null;
  const tx = Number.parseFloat(overlay.style.getPropertyValue("--tv-tx"));
  const ty = Number.parseFloat(overlay.style.getPropertyValue("--tv-ty"));
  const k = Number.parseFloat(overlay.style.getPropertyValue("--tv-k"));
  return Number.isFinite(tx) && Number.isFinite(ty) && Number.isFinite(k) && k > 0 ? { tx, ty, k } : null;
}

/**
 * Samples the frame nearest the viewport center every intervalMs; stop() returns the largest move in px.
 * A move is measured in world coordinates, scaled by the current zoom, so a camera move (the open-time show and
 * the selection reveal) is not drift, as the spine probe does not count a scroll it can explain. That Review keeps
 * the camera still under appends is asserted in canvas-view.test.tsx.
 */
export function startCanvasDriftProbe(intervalMs = 50): CanvasDriftProbe {
  let anchor: { id: string; x: number; y: number } | null = null;
  let max = 0;
  const sample = (): void => {
    const viewport = canvasViewport();
    const camera = viewport === null ? null : overlayCamera(viewport);
    if (viewport === null || camera === null || !hasArea(viewport)) {
      anchor = null;
      return;
    }
    const view = viewport.getBoundingClientRect();
    const toWorld = (box: DOMRect): { x: number; y: number } => ({
      x: (box.left - view.left - camera.tx) / camera.k,
      y: (box.top - view.top - camera.ty) / camera.k,
    });
    const frames = [...viewport.querySelectorAll<HTMLElement>('[role="group"][data-key]')];
    if (anchor !== null) {
      const last = anchor;
      const same = frames.find((frame) => frame.dataset.key === last.id);
      if (same !== undefined) {
        const now = toWorld(same.getBoundingClientRect());
        max = Math.max(max, Math.abs(now.x - last.x) * camera.k, Math.abs(now.y - last.y) * camera.k);
      }
    }
    const cx = view.left + view.width / 2;
    const cy = view.top + view.height / 2;
    let best: { id: string; x: number; y: number } | null = null;
    let bestDistance = Infinity;
    for (const frame of frames) {
      const box = frame.getBoundingClientRect();
      const distance = Math.hypot(box.left + box.width / 2 - cx, box.top + box.height / 2 - cy);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { id: frame.dataset.key ?? "", ...toWorld(box) };
      }
    }
    anchor = best;
  };
  const timer = window.setInterval(sample, intervalMs);
  return {
    sample,
    stop: () => {
      window.clearInterval(timer);
      sample();
      return max;
    },
  };
}

export interface SwitchSelftestResult {
  switches: number;
  misses: number;
  details: string[];
}

/** Resolves after the next frame has been painted (spec §10 paint mark: rAF, then a MessageChannel post). */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(null);
    });
  });
}

function press(target: HTMLElement, digit: "1" | "2"): void {
  const init = { key: digit, code: `Digit${digit}`, bubbles: true, cancelable: true };
  target.dispatchEvent(new KeyboardEvent("keydown", init));
  target.dispatchEvent(new KeyboardEvent("keyup", init));
}

/** The camera as the overlay reads it: the camera variables live on `[data-tv-overlay]` (C3-10 fix hand-off). */
function cameraOf(viewport: HTMLElement): string {
  const overlay = viewport.querySelector<HTMLElement>("[data-tv-overlay]");
  if (overlay === null) return "no overlay";
  return ["--tv-tx", "--tv-ty", "--tv-k"].map((name) => overlay.style.getPropertyValue(name)).join(" ");
}

/** Spec §10 "View switch": presses 1/2 `count` times; each Canvas show must paint its saved camera, with a non-zero main rect. */
export async function runSwitchSelftest(count = 20): Promise<SwitchSelftestResult> {
  const main = document.querySelector<HTMLElement>("main");
  if (main === null) return { switches: 0, misses: 1, details: ["no main landmark"] };
  const details: string[] = [];
  let misses = 0;
  let saved: string | null = null;
  for (let i = 0; i < count; i += 1) {
    const toCanvas = i % 2 === 0;
    const active = document.activeElement;
    const target =
      active instanceof HTMLElement && main.contains(active) ? active : (main.querySelector<HTMLElement>('[tabindex="0"]') ?? main);
    if (!toCanvas) {
      const viewport = canvasViewport();
      saved = viewport === null ? null : cameraOf(viewport);
    }
    press(target, toCanvas ? "1" : "2");
    await nextPaint();
    if (!hasArea(main)) {
      misses += 1;
      details.push(`switch ${i + 1}: main is 0 x 0`);
      continue;
    }
    if (toCanvas && saved !== null) {
      const viewport = canvasViewport();
      const now = viewport === null ? "missing" : cameraOf(viewport);
      if (now !== saved) {
        misses += 1;
        details.push(`switch ${i + 1}: camera ${now} != ${saved}`);
      }
    }
  }
  return { switches: count, misses, details };
}

/** ?selftest=switch: waits for the Canvas, runs runSwitchSelftest and writes JSON into <pre id="selftest">. */
export async function writeSwitchSelftest(timeoutMs = 8_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (canvasViewport() === null || document.querySelector('main [tabindex="0"]') === null) {
    if (performance.now() > deadline) break;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  const result = await runSwitchSelftest();
  let pre = document.querySelector<HTMLPreElement>("pre#selftest");
  if (pre === null) {
    pre = document.createElement("pre");
    pre.id = "selftest";
    pre.hidden = true;
    document.body.append(pre);
  }
  pre.textContent = JSON.stringify(result);
}
