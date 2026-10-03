import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { composite, contrastRatio, parseColor } from "./contrast.js";
import { LIGHT_TOKENS, TOKEN_NAMES, TOKEN_VARS, tokenStyle } from "./tokens.js";

const T = LIGHT_TOKENS;
const fill2OnPanel = composite(T.fill2, T.panel);
const BASES = { panel: T.panel, canvas: T.canvas, fill2OnPanel } as const;

describe("tokens", () => {
  it("text tokens reach 4.5:1 on panel, canvas and fill-2 over panel (R24, spec §7.13)", () => {
    for (const name of ["ink", "ink2", "ink3", "accentInk", "badInk"] as const) {
      for (const [baseName, base] of Object.entries(BASES)) {
        expect(contrastRatio(T[name], base), `${name} on ${baseName}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrastRatio(T.accentInk, composite(T.accentSoft, T.panel))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(T.badInk, composite(T.badSoft, T.panel))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#FFFFFF", T.accentInk)).toBeGreaterThanOrEqual(4.5);
  });

  it("mark tokens reach 3:1 on the same bases and mark on both band composites", () => {
    for (const name of ["mark", "bad", "accent"] as const) {
      for (const [baseName, base] of Object.entries(BASES)) {
        expect(contrastRatio(T[name], base), `${name} on ${baseName}`).toBeGreaterThanOrEqual(3);
      }
    }
    expect(contrastRatio(T.mark, composite(T.fill, T.canvas))).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(T.mark, composite(T.fill2, T.canvas))).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(T.good, T.panel)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(T.good, T.canvas)).toBeGreaterThanOrEqual(3);
  });

  it("matches the spec's measured anchors", () => {
    expect(contrastRatio("#676D78", "#FFFFFF").toFixed(2)).toBe("5.20");
    expect(contrastRatio("#FFFFFF", "#2F6BFF")).toBeLessThan(4.5);
  });

  it("parses hex and space-separated rgb with alpha, and composites over an opaque base", () => {
    expect(parseColor("#2F6BFF")).toEqual({ r: 47, g: 107, b: 255, a: 1 });
    expect(parseColor("rgb(16 24 40 / 0.07)")).toEqual({ r: 16, g: 24, b: 40, a: 0.07 });
    expect(composite("rgb(0 0 0 / 0.5)", "#FFFFFF")).toBe("#808080");
    expect(() => composite("#000000", "rgb(0 0 0 / 0.5)")).toThrow(/opaque/);
  });

  it("exposes every token as an inline --tv-* property", () => {
    const style = tokenStyle();
    expect(Object.keys(style)).toHaveLength(TOKEN_NAMES.length);
    expect(style["--tv-ink-3"]).toBe("#676D78");
    expect(style[TOKEN_VARS.accentSoft]).toBe("rgb(47 107 255 / 0.10)");
  });
});

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const INK4_IN_COLOR = /(?<![-\w])color\s*:\s*[^;}]*var\(\s*--tv-ink-4\s*\)/;
const FONT_SIZE_PX = /font-size\s*:\s*(\d+(?:\.\d+)?)px/g;

/**
 * World-scaled text, the one exemption from the 12 px guard (lane 06 P-3 fix round 1; the approved H2 Map, map.html):
 * inside the Map's world the camera scales every size by k, so a font size there is in world px and reads size × k on
 * screen, and the Map picks each card's content by zoom band. Only rules of MapView.module.css whose every selector
 * starts at a `.world[data-level="…"]` qualify; the Map's header and notes keep the guard.
 */
const WORLD_SCALED = {
  file: path.join("ui", "views", "map", "MapView.module.css"),
  selector: /^\.world\[data-level="(?:chip|card|detail)"\](?:\s|$)/,
};

/** The selector list of the rule that holds `index` (comments already blanked out). */
function selectorAt(css: string, index: number): string {
  const open = css.lastIndexOf("{", index);
  const close = css.lastIndexOf("}", open);
  return css.slice(close + 1, open).trim();
}

/** Font sizes below 12 px in `css` (a module at `file`, relative to src), minus the world-scaled Map rules. */
function smallFontSizes(file: string, css: string): { size: number; selector: string }[] {
  // Comments become spaces of the same length, so braces in a comment never end a selector and indices stay put.
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => " ".repeat(comment.length));
  const found: { size: number; selector: string }[] = [];
  for (const match of plain.matchAll(FONT_SIZE_PX)) {
    const size = Number(match[1]);
    if (size >= 12) continue;
    const selector = selectorAt(plain, match.index ?? 0);
    const worldScaled = file === WORLD_SCALED.file && selector.split(",").every((part) => WORLD_SCALED.selector.test(part.trim()));
    if (!worldScaled) found.push({ size, selector });
  }
  return found;
}

function moduleCssFiles(): string[] {
  return readdirSync(SRC, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".module.css"))
    .map((file) => path.join(SRC, file));
}

describe("CSS module guards (spec §7.13 lint rule, D8 12px minimum)", () => {
  it("the ink-4 guard catches color and ignores other properties", () => {
    expect(INK4_IN_COLOR.test(".a { color: var(--tv-ink-4); }")).toBe(true);
    expect(INK4_IN_COLOR.test(".a{color:var( --tv-ink-4 )}")).toBe(true);
    expect(INK4_IN_COLOR.test(".a { background-color: var(--tv-ink-4); }")).toBe(false);
    expect(INK4_IN_COLOR.test(".a { border-color: var(--tv-ink-4); fill: var(--tv-ink-4); }")).toBe(false);
  });

  it("exempts only the Map's world-scaled rules from the 12 px guard", () => {
    const map = WORLD_SCALED.file;
    expect(smallFontSizes(map, '.world[data-level="detail"] .name { font-size: 10.5px; }')).toEqual([]);
    expect(smallFontSizes(map, '/* a } note */\n.world[data-level="chip"] .band { font-size: 8px; }')).toEqual([]);
    expect(smallFontSizes(map, ".note { font-size: 11px; }")).toEqual([{ size: 11, selector: ".note" }]);
    expect(smallFontSizes(map, '.world[data-level="detail"] .a, .note { font-size: 9px; }')).toHaveLength(1);
    expect(smallFontSizes(map, ".world .name { font-size: 9px; }")).toHaveLength(1);
    expect(smallFontSizes(path.join("ui", "views", "canvas", "Frame.module.css"), '.world[data-level="detail"] .name { font-size: 10.5px; }')).toHaveLength(1);
  });

  it("no CSS module uses --tv-ink-4 as a text color or sets text below 12px", () => {
    const files = moduleCssFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const css = readFileSync(file, "utf8");
      const relative = path.relative(SRC, file);
      expect(INK4_IN_COLOR.test(css), `${relative} uses var(--tv-ink-4) in color`).toBe(false);
      expect(smallFontSizes(relative, css), `${relative} font-size below 12px`).toEqual([]);
    }
  });
});
