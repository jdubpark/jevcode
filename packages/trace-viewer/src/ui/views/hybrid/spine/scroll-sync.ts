export const COMFORT_INSET_PX = 32;

export interface Span {
  start: number;
  end: number;
}

export interface ScrollWindow {
  offset: number;
  height: number;
}

export function comfortBand(win: ScrollWindow): Span {
  return { start: win.offset + COMFORT_INSET_PX, end: win.offset + win.height - COMFORT_INSET_PX };
}

/** "none" inside the comfort band; "center" when the row lies more than one viewport outside; else "auto". */
export function revealAlign(row: Span, win: ScrollWindow): "none" | "auto" | "center" {
  const band = comfortBand(win);
  if (row.start >= band.start && row.end <= band.end) return "none";
  const far = row.start < win.offset - win.height || row.start > win.offset + 2 * win.height;
  return far ? "center" : "auto";
}

export interface PushCandidate {
  index: number;
  start: number;
  end: number;
  /** Rows the playhead may land on (steps, chapters, groups); separators are not targets. */
  target: boolean;
}

/** After a user scroll: the first (playhead above) or last (below) target row inside the band, else null. */
export function pushTarget(playhead: Span | null, candidates: readonly PushCandidate[], win: ScrollWindow): number | null {
  if (playhead === null) return null;
  const band = comfortBand(win);
  const inside = candidates.filter((row) => row.target && row.start >= band.start && row.end <= band.end);
  if (inside.length === 0) return null;
  if (playhead.start < band.start) return inside[0]?.index ?? null;
  if (playhead.end > band.end) return inside[inside.length - 1]?.index ?? null;
  return null;
}

export function spineVirtualOptions(follow: boolean): {
  anchorTo: "end";
  followOnAppend: "auto" | false;
  scrollEndThreshold: 24;
  overscan: 10;
} {
  return { anchorTo: "end", followOnAppend: follow ? "auto" : false, scrollEndThreshold: 24, overscan: 10 };
}

/** Adds the rows that must stay mounted (playhead, focus, selection) to the virtualizer's range, sorted and unique. */
export function extendRange(base: readonly number[], extra: readonly number[], count: number): number[] {
  const set = new Set(base);
  for (const value of extra) if (value >= 0 && value < count) set.add(value);
  return [...set].sort((a, b) => a - b);
}
