export const PERF = {
  bundleParsed: "tv:bundle-parsed",
  firstPaint: "tv:first-paint",
  fullLoad: "tv:full-load",
  keyToPaint: "tv:key-to-paint",
  overviewPaint: "tv:overview-paint",
  viewSwitch: "tv:view-switch",
  liveTick: "tv:live-tick",
} as const;

/**
 * Spec §10 paint mark: posts a MessageChannel message from the next requestAnimationFrame
 * callback and marks `name` when it arrives, which runs after that frame's style, layout and
 * paint. With `startMark`, also records performance.measure(name, startMark, name).
 *
 * `tv:key-to-paint` starts at the keydown's own timeStamp (KeyboardLayer) and ends here, so it is
 * the time from input to the paint of the next frame. A driver must press from a macrotask, as
 * real input arrives; a press from inside a requestAnimationFrame callback spans one whole frame
 * by construction. The dev HUD records a zero-work floor beside it (`tv:key-to-paint-baseline`).
 */
export function markAfterPaint(name: string, startMark?: string): void {
  if (
    typeof performance === "undefined" ||
    typeof requestAnimationFrame === "undefined" ||
    typeof MessageChannel === "undefined"
  ) {
    return;
  }
  requestAnimationFrame(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      performance.mark(name);
      if (startMark !== undefined && performance.getEntriesByName(startMark, "mark").length > 0) {
        performance.measure(name, startMark, name);
      }
    };
    channel.port2.postMessage(null);
  });
}

/**
 * Consumes the latest `startMark` (reads it, then clears it, so a later snapshot without a new
 * start never reuses it) and records performance.measure(name) from it to the paint after the
 * next frame. No-op without a pending start mark. The spec §10 live tick uses it with the
 * DataController's LIVE_TICK_START.
 */
export function measureAfterPaint(name: string, startMark: string): void {
  if (
    typeof performance === "undefined" ||
    typeof requestAnimationFrame === "undefined" ||
    typeof MessageChannel === "undefined"
  ) {
    return;
  }
  const start = performance.getEntriesByName(startMark, "mark").at(-1);
  if (start === undefined) return;
  performance.clearMarks(startMark);
  const startTime = start.startTime;
  requestAnimationFrame(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      performance.measure(name, { start: startTime, end: performance.now() });
    };
    channel.port2.postMessage(null);
  });
}

/**
 * Spec §1 "found at once": the Shell marks this in the first requestAnimationFrame after the commit
 * that applies the initial selection; smoke.mjs reads getEntriesByName(…)[0].startTime ≤ 5000.
 * Not a PERF member: PERF names the spec §10 measures (deviation 10).
 */
export const INITIAL_SELECTION_PAINTED = "tv:initial-selection-painted";

/** Marks `name` inside the next requestAnimationFrame callback; the returned function cancels it. */
export function markNextFrame(name: string): () => void {
  if (typeof performance === "undefined" || typeof requestAnimationFrame === "undefined") return () => undefined;
  const frame = requestAnimationFrame(() => {
    performance.mark(name);
  });
  return () => cancelAnimationFrame(frame);
}
