export const TOKEN_NAMES = [
  "canvas", "panel", "ink", "ink2", "ink3", "ink4", "mark", "hair", "fill", "fill2",
  "accent", "accentSoft", "accentInk", "bad", "badSoft", "badInk", "good", "shadow",
] as const;
export type TokenName = (typeof TOKEN_NAMES)[number];
export type Tokens = { readonly [K in TokenName]: string };

/** Light tokens (D8, R24). Canvas2D painters read this object directly. */
export const LIGHT_TOKENS: Tokens = {
  canvas: "#F4F5F7", panel: "#FFFFFF", ink: "#16181D", ink2: "#5B616E", ink3: "#676D78",
  ink4: "#9AA0AB", mark: "#7C828E", hair: "rgb(16 24 40 / 0.07)", fill: "rgb(16 24 40 / 0.04)",
  fill2: "rgb(16 24 40 / 0.07)", accent: "#2F6BFF", accentSoft: "rgb(47 107 255 / 0.10)",
  accentInk: "#1F5EF0", bad: "#E5484D", badSoft: "rgb(229 72 77 / 0.09)", badInk: "#CE2C31",
  good: "#2E9E6A", shadow: "0 1px 2px rgb(16 24 40 / 0.06), 0 4px 12px rgb(16 24 40 / 0.05)",
};

export const TOKEN_VARS: { readonly [K in TokenName]: `--tv-${string}` } = {
  canvas: "--tv-canvas", panel: "--tv-panel", ink: "--tv-ink", ink2: "--tv-ink-2", ink3: "--tv-ink-3",
  ink4: "--tv-ink-4", mark: "--tv-mark", hair: "--tv-hair", fill: "--tv-fill", fill2: "--tv-fill-2",
  accent: "--tv-accent", accentSoft: "--tv-accent-soft", accentInk: "--tv-accent-ink", bad: "--tv-bad",
  badSoft: "--tv-bad-soft", badInk: "--tv-bad-ink", good: "--tv-good", shadow: "--tv-shadow",
};

/** Inline style object for the Shell root: { "--tv-canvas": "#F4F5F7", … }. */
export function tokenStyle(tokens: Tokens = LIGHT_TOKENS): Readonly<Record<`--tv-${string}`, string>> {
  const style: Record<`--tv-${string}`, string> = {};
  for (const name of TOKEN_NAMES) style[TOKEN_VARS[name]] = tokens[name];
  return style;
}

export const FONT_SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
export const FONT_MONO = 'ui-monospace, "SF Mono", Menlo, monospace';
export const TYPE = {
  meta: { size: 12, line: 16 }, base: { size: 13, line: 18 }, prose: { size: 15, line: 20 },
  numeral: { size: 20, line: 24 }, mono: { size: 12, line: 18 },
} as const;
