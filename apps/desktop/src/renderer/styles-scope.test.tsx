// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CodeDiff } from "@jevcode/ui-catalog/components/CodeDiff";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(path.join(dirname, "styles.css"), "utf8");
const source = (file: string): string => readFileSync(path.join(dirname, file), "utf8");

/** Splits a selector list at its top-level commas (`:where(a, b)` stays whole). */
function splitList(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i += 1) {
    const char = list[i];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(list.slice(start).trim());
  return parts.filter((part) => part !== "");
}

/** Every selector in the stylesheet, as written; at-rule preludes and keyframe steps are not selectors. */
function selectors(css: string): string[] {
  const out: string[] = [];
  for (const rule of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)) {
    const list = rule[1]?.trim() ?? "";
    if (list.startsWith("@") || /^(from|to|\d+%)/.test(list)) continue;
    out.push(...splitList(list));
  }
  return out;
}

/**
 * The elements a selector can style in any state: user-action pseudo-classes are dropped (a hover rule reaches what it
 * would reach under the pointer), and a pseudo-element counts as its originating element (`::selection` is `*`).
 */
function reach(selector: string): string {
  const stateless = selector
    .replace(/::[\w-]+/g, "")
    .replace(/:(?:hover|active|focus-visible|focus-within|focus)(?![\w-])/g, "")
    .trim();
  return stateless === "" || /[\s>+~]$/.test(stateless) ? `${stateless}*` : stateless;
}

const TAGS = [
  "a", "abbr", "article", "aside", "blockquote", "button", "code", "dd", "details", "div", "dl", "dt", "em",
  "fieldset", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "img", "input", "kbd", "label",
  "legend", "li", "main", "mark", "nav", "ol", "option", "p", "pre", "section", "select", "small", "span", "strong",
  "summary", "table", "tbody", "td", "textarea", "th", "thead", "time", "tr", "ul",
];

/** One of each element, carrying the attribute values host rules test (the viewer's own classes are CSS-module hashes). */
function probes(): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const tag of TAGS) {
    const element = document.createElement(tag);
    element.className = "_probe_viewer";
    for (const [name, value] of [
      ["aria-pressed", "true"],
      ["aria-selected", "true"],
      ["aria-current", "true"],
      ["aria-expanded", "true"],
      ["data-state", "active"],
      ["data-status", "passed"],
    ] as const) {
      element.setAttribute(name, value);
    }
    fragment.append(element);
  }
  const disabled = document.createElement("button");
  disabled.disabled = true;
  fragment.append(disabled);
  return fragment;
}

let viewer: HTMLElement;
let hostView: HTMLElement;
let hostChromeButton: HTMLElement;

/**
 * The main window around the embedded viewer: App (`.app > .body > main.workspace-column`), WorkspaceHost
 * (`section.workspace.workspace-session`), EmbeddedWorkspace (`.workspace-viewer`), the viewer's root
 * (`[data-trace-viewer]`, Shell.tsx) and the Surfaces host view inside it (`[data-host-view]`).
 */
beforeEach(() => {
  document.body.innerHTML = `
    <div id="root">
      <div class="app">
        <header class="header"><div class="header-actions"><button type="button" id="host-chrome">Trace</button></div></header>
        <div class="body">
          <aside class="sidebar"><button type="button">repo</button></aside>
          <main class="workspace-column">
            <section class="workspace workspace-session">
              <div class="workspace-viewer">
                <div data-trace-viewer="">
                  <div id="viewer-probes"></div>
                  <div id="viewer-diff"></div>
                  <div class="jevcode-code-diff" id="viewer-diff-fallback"><pre>raw diff</pre></div>
                  <section class="surfaces-view" data-host-view="">
                    <nav class="workspace-tabs"><button type="button" aria-pressed="true">Overview</button></nav>
                    <button type="button" id="host-view-button">Keep</button>
                  </section>
                </div>
              </div>
              <section class="prompt-dock"><button type="button" class="dock-send">Send</button></section>
            </section>
          </main>
        </div>
      </div>
    </div>`;
  viewer = document.querySelector("[data-trace-viewer]") as HTMLElement;
  hostView = document.querySelector("[data-host-view]") as HTMLElement;
  hostChromeButton = document.getElementById("host-chrome") as HTMLElement;
  document.getElementById("viewer-probes")?.append(probes());
  // The viewer's Inspector renders ui-catalog's CodeDiff (Evidence.tsx): diff2html markup here, and #viewer-diff-fallback
  // stands for its <pre> fallback, which diff2html output that lacks code lines selects.
  render(<CodeDiff props={{ file: "src/a.ts", diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-a\n+b\n c" }} />, {
    container: document.getElementById("viewer-diff") as HTMLElement,
  });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function inViewerScope(element: Element): boolean {
  return element.closest("[data-trace-viewer]") !== null && element.closest("[data-host-view]") === null;
}

function matching(element: Element): string[] {
  return selectors(CSS).filter((selector) => element.matches(reach(selector)));
}

describe("the main window's stylesheet never reaches the embedded viewer (lane 03 fix wave I-1)", () => {
  it("renders the frame this test assumes", () => {
    expect(source("App.tsx")).toContain('className="app"');
    expect(source("App.tsx")).toContain('className="body"');
    expect(source("App.tsx")).toContain('className="workspace-column"');
    expect(source("components/WorkspaceHost.tsx")).toContain('className="workspace workspace-session"');
    expect(source("workspace/EmbeddedWorkspace.tsx")).toContain('className="workspace-viewer"');
    expect(source("workspace/surfaces-view.tsx")).toMatch(/className="surfaces-view"[^>]*data-host-view=""/);
    expect(viewer.querySelectorAll("#viewer-diff .d2h-code-line").length).toBeGreaterThan(0);
    expect(source("../../../../packages/ui-catalog/src/components/CodeDiff.tsx")).toMatch(/className="jevcode-code-diff"[\s\S]*<pre>/);
  });

  it("has no selector that matches an element inside [data-trace-viewer] outside a host view", () => {
    const leaks: string[] = [];
    for (const selector of selectors(CSS)) {
      let hits: Element[];
      try {
        hits = [...document.querySelectorAll(reach(selector))];
      } catch (error) {
        throw new Error(`cannot read selector ${JSON.stringify(selector)} as ${JSON.stringify(reach(selector))}: ${String(error)}`);
      }
      const inside = hits.filter(inViewerScope);
      if (inside.length > 0) leaks.push(`${selector} → <${inside[0]?.tagName.toLowerCase() ?? "?"}>`);
    }
    expect(leaks).toEqual([]);
  });

  it("scopes every selector: each carries the viewer guard, names a class or id, or is :root, html or body", () => {
    // The probes above cover 52 tags; this covers selectors they cannot enumerate (`[aria-checked]`, `[role]`,
    // `[data-tone]`, `details[open]`, `input[type]`, `:checked`) that would reach the viewer if written bare.
    const GUARD = ":where(:not([data-trace-viewer]";
    const hasClassOrId = (selector: string): boolean => /[.#][_a-zA-Z-]/.test(selector.replace(/\[[^\]]*\]/g, ""));
    const isRoot = (selector: string): boolean => /^(?::root|html|body)(?::{1,2}[\w-]+)*$/.test(selector);
    const unscoped = selectors(CSS).filter(
      (selector) => !selector.includes(GUARD) && !hasClassOrId(selector) && !isRoot(selector),
    );
    expect(unscoped).toEqual([]);
  });

  it("still styles host chrome and the Surfaces host view with the same element rules", () => {
    const elementRules = (element: Element): string[] =>
      matching(element).filter((selector) => /^(button|:where)/.test(selector));
    const chrome = elementRules(hostChromeButton);
    expect(chrome.some((selector) => selector.startsWith("button"))).toBe(true);
    expect(elementRules(document.getElementById("host-view-button") as HTMLElement)).toEqual(chrome);
    // The generic pressed-button rule, not only the Surfaces tabs' own.
    const pressed = matching(hostView.querySelector(".workspace-tabs button") as HTMLElement);
    expect(pressed.some((selector) => /^button(:where\(.*\))?\[aria-pressed="true"\]$/.test(selector))).toBe(true);
  });
});
