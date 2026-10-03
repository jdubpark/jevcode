import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LIGHT_TOKENS, TOKEN_VARS } from "@jevcode/trace-viewer";
import { describe, expect, it } from "vitest";

import { XTERM_LIGHT_THEME } from "./theme.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(path.join(dirname, "styles.css"), "utf8");
// Read as text: the renderer project does not compile main-process files.
const TRACE_WINDOW_TS = readFileSync(path.join(dirname, "../main/trace-window.ts"), "utf8");
const MAIN_WINDOW_BACKGROUND = /MAIN_WINDOW_BACKGROUND = "(#[0-9A-Fa-f]{6})"/.exec(TRACE_WINDOW_TS)?.[1];
const MAIN_WINDOW_MIN_WIDTH = /MAIN_WINDOW_MIN_WIDTH = (\d+)/.exec(TRACE_WINDOW_TS)?.[1];
const UI_CATALOG_SRC = path.resolve(dirname, "../../../../packages/ui-catalog/src");

function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules" && entry !== "test-support") files.push(...sourceFiles(full));
      continue;
    }
    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) files.push(full);
  }
  return files;
}

const CORPUS = [...sourceFiles(dirname), ...sourceFiles(UI_CATALOG_SRC)]
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");
/** Classes built at run time, e.g. `surface-kind-${meta.group}` → "surface-kind-". */
const DYNAMIC_PREFIXES = [...CORPUS.matchAll(/([a-z][\w-]*-)\$\{/g)].map((match) => match[1] ?? "");
/** Markup that diff2html, xterm and React Flow own. */
const FOREIGN_PREFIXES = ["d2h-", "xterm", "react-flow"];

function classNames(css: string): string[] {
  const names = new Set<string>();
  for (const rule of withoutComments(css).matchAll(/([^{}]+)\{/g)) {
    const selector = rule[1]?.trim() ?? "";
    if (selector.startsWith("@") || /^(from|to|\d+%)/.test(selector)) continue;
    for (const match of selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) names.add(match[1] ?? "");
  }
  return [...names];
}

describe("main window styles use the viewer's light tokens (spec E6, §3.6, §9)", () => {
  it("is a light stylesheet", () => {
    expect(CSS).not.toMatch(/color-scheme:\s*dark/);
    expect(CSS).toMatch(/color-scheme:\s*light/);
  });

  it("has no color literals: every color is a --tv-* token", () => {
    const literals = withoutComments(CSS).match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g) ?? [];
    expect(literals).toEqual([]);
  });

  it("references only real tokens or variables it defines itself", () => {
    const css = withoutComments(CSS);
    const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1] ?? ""));
    const known = new Set<string>([...Object.values(TOKEN_VARS), "--tv-dur", "--tv-dur-fast"]);
    const used = [...new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1] ?? ""))];
    expect(used.filter((name) => !known.has(name) && !defined.has(name))).toEqual([]);
  });

  it("keeps no rule for a class nothing renders", () => {
    const dead = classNames(CSS).filter(
      (name) =>
        !FOREIGN_PREFIXES.some((prefix) => name.startsWith(prefix)) &&
        !CORPUS.includes(name) &&
        !DYNAMIC_PREFIXES.some((prefix) => name.startsWith(prefix)),
    );
    expect(dead).toEqual([]);
  });

  it("never sets readable text in --tv-ink-4 (2.4:1 on canvas); only decorative separators may", () => {
    const DECORATIVE = [".jevcode-evidence-count + .jevcode-evidence-count::before"];
    const offenders = [...withoutComments(CSS).matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter((rule) => /(^|[;\s])color:\s*var\(--tv-ink-4\)/.test(rule[2] ?? ""))
      .map((rule) => (rule[1] ?? "").trim())
      .filter((selector) => !DECORATIVE.includes(selector));
    expect(offenders).toEqual([]);
  });

  it("sets no text below 10 px: the 9 px labels moved to 11 px (final review C M-3, D-4 minor)", () => {
    const sizes = [...withoutComments(CSS).matchAll(/font-size:\s*([\d.]+)px/g)].map((match) => Number(match[1]));
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.filter((size) => size < 10)).toEqual([]);
  });

  it("paints the terminal container with the same panel color as xterm", () => {
    expect(/\.terminal-container\s*\{[^}]*background:\s*var\(--tv-panel\)/.test(CSS)).toBe(true);
  });

  it("paints the native window, the page and the shell from the same light tokens", () => {
    expect(MAIN_WINDOW_BACKGROUND).toBe(LIGHT_TOKENS.canvas);
    expect(XTERM_LIGHT_THEME.background).toBe(LIGHT_TOKENS.panel);
    expect(XTERM_LIGHT_THEME.foreground).toBe(LIGHT_TOKENS.ink);
  });

  it("holds the page to the main window's minimum width, where the embedded viewer bar still fits (D-6 ruling: 880 px)", () => {
    expect(MAIN_WINDOW_MIN_WIDTH).toBe("880");
    const app = /(?:^|\n)\.app\s*\{([^}]*)\}/.exec(withoutComments(CSS))?.[1] ?? "";
    expect(/min-width:\s*(\d+)px/.exec(app)?.[1]).toBe(MAIN_WINDOW_MIN_WIDTH);
  });
});
