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

  it("no CSS module uses --tv-ink-4 as a text color or sets text below 12px", () => {
    const files = moduleCssFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const css = readFileSync(file, "utf8");
      expect(INK4_IN_COLOR.test(css), `${path.relative(SRC, file)} uses var(--tv-ink-4) in color`).toBe(false);
      for (const match of css.matchAll(FONT_SIZE_PX)) {
        expect(Number(match[1]), `${path.relative(SRC, file)} font-size`).toBeGreaterThanOrEqual(12);
      }
    }
  });
});
