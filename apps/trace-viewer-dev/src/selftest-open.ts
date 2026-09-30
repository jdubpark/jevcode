// Spec §1 "found at once" (?selftest=open): what a reader sees after opening oauth in Hybrid with no input.
// Reads only the DOM, the URL hash the viewer writes through onLocation, and the Shell's performance mark.
import type { TraceBundle } from "@jevcode/contracts";
import { INITIAL_SELECTION_PAINTED, locationFromHash } from "@jevcode/trace-viewer";

import { claimRowOf } from "./selftest.js";

export interface OpenProbeResult {
  /** The selection the viewer last reported through ViewerHost.onLocation (read back from the URL hash). */
  selected: string | null;
  /** oauth's claim step, `step:<seq of the claim row>` (stable ids, R9). */
  claimStepId: string | null;
  /** The claim's spine row lies inside the reading spine's viewport. */
  claimRowInSpine: boolean;
  /** The overview pin that holds the selection lies inside the overview's lane viewport. */
  claimPinInOverview: boolean;
  /** performance.getEntriesByName("tv:initial-selection-painted")[0].startTime; null when the mark never came. */
  paintedAtMs: number | null;
}

export interface OpenProbe {
  start(): void;
  stop(): void;
}

interface Box {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface Sample {
  row: Box | null;
  feed: Box | null;
  pin: Box | null;
  lanes: Box | null;
}

export function claimStepIdOf(bundle: TraceBundle): string | null {
  const claim = claimRowOf(bundle);
  return claim === undefined ? null : `step:${claim.seq}`;
}

function boxOf(element: Element | null | undefined): Box | null {
  if (element === null || element === undefined) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
}

/** `inner` lies inside `outer`, allowing 1 px for subpixel rounding. */
function inside(inner: Box | null, outer: Box | null): boolean {
  return (
    inner !== null &&
    outer !== null &&
    inner.top >= outer.top - 1 &&
    inner.bottom <= outer.bottom + 1 &&
    inner.left >= outer.left - 1 &&
    inner.right <= outer.right + 1
  );
}

function sample(claimStepId: string | null): Sample {
  const view = document.querySelector('[data-view="hybrid"]');
  const feed = view?.querySelector('[role="feed"]') ?? null;
  const row =
    claimStepId === null || feed === null
      ? undefined
      : Array.from(feed.querySelectorAll<HTMLElement>("article[data-key]")).find((node) => node.dataset.key === claimStepId);
  const lanes = view?.querySelector("[data-overview-lanes]") ?? null;
  const pin = lanes?.querySelector('button[data-steps][aria-pressed="true"]') ?? null;
  return { row: boxOf(row), feed: boxOf(feed), pin: boxOf(pin), lanes: boxOf(lanes) };
}

/**
 * Waits for the Shell's tv:initial-selection-painted mark, then for three frames with the same
 * geometry (the spine's reveal and the virtualizer's measurements settle), and writes what it sees.
 * Writes at `deadlineMs` after navigation start at the latest, with paintedAtMs null when the mark
 * never came.
 */
export function createOpenProbe(options: {
  sessionId: string;
  claimStepId: string | null;
  write(result: OpenProbeResult): void;
  deadlineMs?: number;
}): OpenProbe {
  let frame: number | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let reported = false;
  let previous = "";
  let stillFrames = 0;

  const cancel = (): void => {
    if (frame !== null) cancelAnimationFrame(frame);
    if (deadline !== null) clearTimeout(deadline);
    frame = null;
    deadline = null;
  };

  const report = (): void => {
    if (reported) return;
    reported = true;
    cancel();
    const seen = sample(options.claimStepId);
    const mark = performance.getEntriesByName(INITIAL_SELECTION_PAINTED, "mark")[0];
    options.write({
      selected: locationFromHash(window.location.hash, options.sessionId).selected ?? null,
      claimStepId: options.claimStepId,
      claimRowInSpine: inside(seen.row, seen.feed),
      claimPinInOverview: inside(seen.pin, seen.lanes),
      paintedAtMs: mark === undefined ? null : mark.startTime,
    });
  };

  const onFrame = (): void => {
    frame = null;
    if (performance.getEntriesByName(INITIAL_SELECTION_PAINTED, "mark").length > 0) {
      const key = JSON.stringify(sample(options.claimStepId));
      stillFrames = key === previous ? stillFrames + 1 : 0;
      previous = key;
      if (stillFrames >= 2) {
        report();
        return;
      }
    }
    frame = requestAnimationFrame(onFrame);
  };

  return {
    start() {
      if (reported) return;
      frame = requestAnimationFrame(onFrame);
      deadline = setTimeout(report, Math.max(0, (options.deadlineMs ?? 4_800) - performance.now()));
    },
    stop: cancel,
  };
}
