// ?selftest=bar with ?chrome=embedded&gaps=N: the embedded title bar's real layout at the window's width (the main
// window's 880 px minimum with a gaps chip, lane 03 D-6). Reads only the DOM, after two frames of layout.
export interface BarProbeResult {
  barWidth: number;
  barScrollWidth: number;
  /** The bar's content fits: no horizontal overflow. */
  fits: boolean;
  gapsChip: boolean;
  briefToggle: boolean;
  /** The Brief toggle's box lies inside the bar's box and has a size. */
  briefVisible: boolean;
}

export interface BarProbe {
  start(): void;
  stop(): void;
}

const BAR = '[data-chrome="embedded"]';
const BRIEF = 'button[title^="Brief"]';
const GAPS = 'button[title$="gap"], button[title$="gaps"]';

export function measureBar(root: ParentNode): BarProbeResult | null {
  const bar = root.querySelector(BAR);
  if (bar === null) return null;
  const toggle = bar.querySelector(BRIEF);
  const barBox = bar.getBoundingClientRect();
  const toggleBox = toggle?.getBoundingClientRect();
  return {
    barWidth: Math.round(barBox.width),
    barScrollWidth: bar.scrollWidth,
    fits: bar.scrollWidth <= bar.clientWidth,
    gapsChip: bar.querySelector(GAPS) !== null,
    briefToggle: toggle !== null,
    briefVisible:
      toggleBox !== undefined &&
      toggleBox.width > 0 &&
      toggleBox.height > 0 &&
      toggleBox.left >= barBox.left &&
      toggleBox.right <= barBox.right + 0.5,
  };
}

export function createBarProbe(write: (result: BarProbeResult) => void): BarProbe {
  let frame = 0;
  let stopped = false;
  let settle = 0;
  const tick = (): void => {
    if (stopped) return;
    const result = measureBar(document);
    // The chip and the toggle mount with the first committed session; wait for them, then two stable frames.
    if (result !== null && result.gapsChip && result.briefToggle) settle += 1;
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
