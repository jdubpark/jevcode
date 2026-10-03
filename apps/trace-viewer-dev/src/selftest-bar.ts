// ?selftest=bar with ?chrome=embedded&gaps=N: the embedded title bar's real layout at the window's width, or at
// ?frame=<px>, the main window's workspace column (lane 03 D-6; fix wave minor 1). With ?approx=1 the bar also carries
// the approximate-joins chip. ?selftest=maphead with ?view=map: the Map header row at that width (fix wave minor 2).
// Both read only the DOM, after two stable frames of layout.
export interface BarProbeResult {
  barWidth: number;
  barScrollWidth: number;
  /** The bar's content fits: no horizontal overflow. */
  fits: boolean;
  gapsChip: boolean;
  approxChip: boolean;
  briefToggle: boolean;
  /** The Brief toggle's box lies inside the bar's box and has a size. */
  briefVisible: boolean;
}

export interface MapHeadProbeResult {
  rowWidth: number;
  rowScrollWidth: number;
  /** The header row's content fits: no horizontal overflow. */
  fits: boolean;
  /** The Overview toggle's box lies inside the row's box and has a size. */
  toggleVisible: boolean;
  /** The languages are cut (their text is wider than their box). */
  languagesCut: boolean;
}

export interface Probe {
  start(): void;
  stop(): void;
}

const BAR = '[data-chrome="embedded"]';
const BRIEF = 'button[title^="Brief"]';
const GAPS = 'button[title$="gap"], button[title$="gaps"]';
const APPROX = 'button[title="Approximate joins"]';

function inside(box: DOMRect | undefined, outer: DOMRect): boolean {
  return box !== undefined && box.width > 0 && box.height > 0 && box.left >= outer.left - 0.5 && box.right <= outer.right + 0.5;
}

export function measureBar(root: ParentNode): BarProbeResult | null {
  const bar = root.querySelector(BAR);
  if (bar === null) return null;
  const toggle = bar.querySelector(BRIEF);
  const barBox = bar.getBoundingClientRect();
  return {
    barWidth: Math.round(barBox.width),
    barScrollWidth: bar.scrollWidth,
    fits: bar.scrollWidth <= bar.clientWidth,
    gapsChip: bar.querySelector(GAPS) !== null,
    approxChip: bar.querySelector(APPROX) !== null,
    briefToggle: toggle !== null,
    briefVisible: inside(toggle?.getBoundingClientRect(), barBox),
  };
}

export function measureMapHeader(root: ParentNode): MapHeadProbeResult | null {
  const row = root.querySelector("[data-map-header] > div");
  const toggle = row?.querySelector("button[aria-expanded]");
  if (row === null || row === undefined || toggle === null || toggle === undefined) return null;
  const languages = row.querySelector("span[title]");
  const rowBox = row.getBoundingClientRect();
  return {
    rowWidth: Math.round(rowBox.width),
    rowScrollWidth: row.scrollWidth,
    fits: row.scrollWidth <= row.clientWidth,
    toggleVisible: inside(toggle.getBoundingClientRect(), rowBox),
    languagesCut: languages !== null && languages.scrollWidth > languages.clientWidth,
  };
}

/** Polls `measure` each frame until `ready` holds for two frames in a row, then writes the result once. */
function settledProbe<T>(measure: () => T | null, ready: (result: T) => boolean, write: (result: T) => void): Probe {
  let frame = 0;
  let stopped = false;
  let settle = 0;
  const tick = (): void => {
    if (stopped) return;
    const result = measure();
    if (result !== null && ready(result)) settle += 1;
    else settle = 0;
    if (settle >= 2 && result !== null) {
      write(result);
      return;
    }
    frame = requestAnimationFrame(tick);
  };
  return {
    start() {
      stopped = false;
      frame = requestAnimationFrame(tick);
    },
    stop() {
      stopped = true;
      cancelAnimationFrame(frame);
    },
  };
}

/** The chips and the toggle mount with the first committed session; the probe waits for them. */
export function createBarProbe(write: (result: BarProbeResult) => void, options: { approx: boolean }): Probe {
  return settledProbe(
    () => measureBar(document),
    (result) => result.gapsChip && result.briefToggle && (!options.approx || result.approxChip),
    write,
  );
}

export function createMapHeadProbe(write: (result: MapHeadProbeResult) => void): Probe {
  return settledProbe(() => measureMapHeader(document), () => true, write);
}
