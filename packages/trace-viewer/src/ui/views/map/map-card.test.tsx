// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MapCard as MapCardBox, MapLevel } from "../../../layout/map-layout.js";
import { buildOverviewModel } from "../../../model/index.js";
import { componentId, overviewSnapshot } from "../../../test-support/overview-builder.js";
import { MapCard, type MapCardProps } from "./MapCard.js";

afterEach(() => cleanup());

// One component, 61 of 122 files at most: the file bar is round(100 · √(61 ÷ 122)) = 71%.
const MAIN = "apps/desktop/src/main";
const overview = buildOverviewModel(
  overviewSnapshot({
    components: [
      {
        rootPath: MAIN,
        name: "desktop main",
        role: "api",
        purpose: "Electron main process: IPC handlers and the event pipeline.",
        provenance: "model",
        fileCount: 61,
        externalDeps: [{ name: "node-pty", count: 2 }, { name: "electron", count: 9 }, { name: "zod", count: 1 }],
      },
      {
        rootPath: "packages/evil",
        name: "evil\u202Ename",
        role: "domain",
        purpose: "Ships builds\u202Etxt.exe **now** [docs](https://evil.example) <img src=x onerror=alert(1)>",
        provenance: "model",
        externalDeps: [{ name: "pkg\u202Ex", count: 3 }],
      },
      { rootPath: "pkg/long-component-name-without-spaces", name: "long-component-name-without-spaces", role: "domain" },
    ],
  }),
  1,
);

function renderCard(level: MapLevel, rootPath = MAIN, overrides: Partial<MapCardProps> = {}) {
  const component = overview.componentById.get(componentId(rootPath));
  if (component === undefined) throw new Error("no component");
  const box: MapCardBox = { id: component.id, band: "api", x: 0, y: 0, w: 140, h: 76 };
  const props: MapCardProps = {
    box, component, level, selected: false, tabStop: true, maxFiles: 122, hubImporters: null, state: null, onSelect: () => undefined, onHover: () => undefined, ...overrides,
  };
  return render(<MapCard {...props} />);
}

const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);

describe("MapCard content by level (revised Map mockup)", () => {
  it("chip: the name and a footer of role icon and file bar, no count, purpose or packages", () => {
    renderCard("chip");
    expect(q("button")?.textContent).toContain("desktop main");
    expect(q("[data-map-bar]")?.style.width).toBe("71%");
    expect(q("[data-map-count]")).toBeNull();
    expect(q("[data-map-purpose]")).toBeNull();
    expect(q("[data-map-packages]")).toBeNull();
  });

  it("card: adds the right-aligned file count", () => {
    renderCard("card");
    expect(q("[data-map-count]")?.textContent).toBe("61");
    expect(q("[data-map-purpose]")).toBeNull();
    expect(q("[data-map-bar]")?.style.width).toBe("71%");
  });

  it("detail: the purpose, the top two packages, 'n files' and, for a hub, the glyph with its importer count", () => {
    renderCard("detail", MAIN, { hubImporters: 13 });
    expect(q("[data-map-purpose]")?.textContent).toBe("Electron main process: IPC handlers and the event pipeline.");
    expect(q("[data-map-packages]")?.textContent).toBe("electron · node-pty");
    expect(q("[data-map-count]")?.textContent).toBe("61 files");
    expect(q("[data-map-hub]")?.textContent).toBe("13");
    expect(q("[data-map-hub]")?.getAttribute("title")).toBe("Imported by 13 components");
  });

  it("names the detail card's packages in full in its tooltip and accessible name, since the row is ellipsized (lane 06 fix, minor 5)", () => {
    renderCard("detail", MAIN);
    expect(q("button")?.getAttribute("aria-label")).toContain("packages electron · node-pty");
    expect(q("button")?.getAttribute("title")).toBe("desktop main: Electron main process: IPC handlers and the event pipeline.\nPackages: electron · node-pty");
    cleanup();
    renderCard("detail", "packages/evil");
    for (const value of [q("button")?.getAttribute("aria-label"), q("button")?.getAttribute("title")]) {
      expect(value).toContain("pkg⟨U+202E⟩x");
      expect(value).not.toContain("\u202E");
    }
    cleanup();
    // Levels that show no packages name none.
    renderCard("card", MAIN);
    expect(q("button")?.getAttribute("aria-label")).not.toContain("packages");
    expect(q("button")?.getAttribute("title")).not.toContain("Packages");
  });

  it("shows the hub glyph on the detail level only, but names the hub in the accessible name at every level", () => {
    renderCard("card", MAIN, { hubImporters: 13 });
    expect(q("[data-map-hub]")).toBeNull();
    expect(q("button")?.getAttribute("aria-label")).toContain("imported by 13 components");
  });

  it("gives a name its full text and falls back to the root path as the purpose", () => {
    renderCard("detail", "pkg/long-component-name-without-spaces");
    expect(q("button")?.textContent).toContain("long-component-name-without-spaces");
    expect(q("[data-map-purpose][data-fallback]")?.textContent).toBe("pkg/long-component-name-without-spaces");
  });

  it("a session state mark takes the place of the count", () => {
    renderCard("card", MAIN, { state: "changed" });
    expect(q("[data-state='changed']")).not.toBeNull();
    expect(q("[data-map-count]")).toBeNull();
    expect(q("button")?.getAttribute("aria-label")).toContain("changed in this session");
  });

  it("Review Focus 2: a hostile purpose, name and package render as plain text on the detail card", () => {
    const { container } = renderCard("detail", "packages/evil");
    expect(q("[data-map-purpose]")?.textContent).toBe(
      "Ships builds⟨U+202E⟩txt.exe **now** [docs](https://evil.example) <img src=x onerror=alert(1)>",
    );
    expect(q("[data-map-packages]")?.textContent).toBe("pkg⟨U+202E⟩x");
    expect(container.querySelectorAll("strong, em, a, img")).toHaveLength(0);
    expect(container.textContent).not.toContain("\u202E");
  });

  it("reports hover and click by id, and is a tab stop only when told", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onHover = vi.fn();
    renderCard("card", MAIN, { onSelect, onHover, tabStop: false });
    const card = q("button");
    if (card === null) throw new Error("no card");
    expect(card.tabIndex).toBe(-1);
    await user.hover(card);
    await user.unhover(card);
    expect(onHover.mock.calls).toEqual([[componentId(MAIN)], [null]]);
    // The click moves the pointer back onto the card, which reports a hover again.
    await user.click(card);
    expect(onSelect).toHaveBeenCalledWith(componentId(MAIN));
  });
});
