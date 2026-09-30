export interface Rgba { r: number; g: number; b: number; a: number }

const HEX = /^#([0-9a-f]{6})$/i;
const RGB = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})\s*(?:[/,]\s*([\d.]+%?)\s*)?\)$/i;

/** "#RRGGBB" or "rgb(r g b / a)". */
export function parseColor(value: string): Rgba {
  const text = value.trim();
  const hex = HEX.exec(text);
  if (hex !== null) {
    const n = Number.parseInt(hex[1] ?? "0", 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const rgb = RGB.exec(text);
  if (rgb !== null) {
    const alphaText = rgb[4];
    const a = alphaText === undefined ? 1
      : alphaText.endsWith("%") ? Number.parseFloat(alphaText) / 100
      : Number.parseFloat(alphaText);
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a };
  }
  throw new Error(`unsupported color: ${value}`);
}

function hex2(value: number): string {
  return Math.round(value).toString(16).padStart(2, "0").toUpperCase();
}

/** Alpha-composites fg over an opaque bg; returns "#RRGGBB". */
export function composite(fg: string, bg: string): string {
  const f = parseColor(fg);
  const b = parseColor(bg);
  if (b.a !== 1) throw new Error(`composite needs an opaque background, got ${bg}`);
  const mix = (top: number, bottom: number): number => top * f.a + bottom * (1 - f.a);
  return `#${hex2(mix(f.r, b.r))}${hex2(mix(f.g, b.g))}${hex2(mix(f.b, b.b))}`;
}

function channel(value: number): number {
  const s = value / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(color: string): number {
  const c = parseColor(color);
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** WCAG 2.x ratio; a translucent fg is composited over bg first. */
export function contrastRatio(fg: string, bg: string): number {
  const solid = parseColor(fg).a < 1 ? composite(fg, bg) : fg;
  const a = luminance(solid);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
