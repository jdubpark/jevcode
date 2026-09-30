export type GraphicSize = "xs" | "sm" | "md";

export interface GraphicBaseProps {
  size: GraphicSize;
  /** Accessible name (describeGraphic); omitted → aria-hidden. */
  label?: string;
}

const clamp = (lo: number, hi: number, v: number): number => Math.min(hi, Math.max(lo, v));

export const DIFF_SIDE_MAX_PX = 56;

/** 0 when lines = 0, else clamp(2, 56, 8 · log2(1 + lines)). */
export function diffSidePx(lines: number): number {
  if (!(lines > 0)) return 0;
  return clamp(2, DIFF_SIDE_MAX_PX, 8 * Math.log2(1 + lines));
}

/** Exact below 1,000; one decimal with k from 1,000 ("1.2k"); M from 1,000,000. */
export function compactCount(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1_000) return String(n);
  if (abs < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export const TEST_DOTS_MAX = 15;

export function testDotsMode(total: number): "dots" | "bar" {
  return total <= TEST_DOTS_MAX ? "dots" : "bar";
}

/** clamp(4, 120, 20 + 40 · log10(seconds)); 1 s = 20, 10 s = 60, 100 s = 100. */
export function durationPx(ms: number): number {
  if (!(ms > 0)) return 4;
  return clamp(4, 120, 20 + 40 * Math.log10(ms / 1_000));
}

export function graphicA11y(label?: string): { role: "img"; "aria-label": string } | { "aria-hidden": true } {
  return label !== undefined && label.length > 0 ? { role: "img", "aria-label": label } : { "aria-hidden": true };
}
