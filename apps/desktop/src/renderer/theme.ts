import { LIGHT_TOKENS, tokenStyle } from "@jevcode/trace-viewer";
import type { ITheme } from "@xterm/xterm";

/** Spec §9: the main window loads the viewer's tokens once, at the root, so header, sidebar, dock and viewer share one palette. */
export function applyViewerTokens(root: HTMLElement): void {
  for (const [name, value] of Object.entries(tokenStyle())) root.style.setProperty(name, value);
}

/** The person's shell on the light panel (spec E6: light only). */
export const XTERM_LIGHT_THEME: ITheme = {
  background: LIGHT_TOKENS.panel,
  foreground: LIGHT_TOKENS.ink,
  cursor: LIGHT_TOKENS.ink,
  cursorAccent: LIGHT_TOKENS.panel,
  selectionBackground: LIGHT_TOKENS.accentSoft,
};
