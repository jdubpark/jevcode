// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { Activity, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OverviewSnapshot } from "@jevcode/contracts";

import { layoutMap, mapHubIds } from "../../../layout/map-layout.js";
import { buildOverviewModel, type TraceSession } from "../../../model/index.js";
import {
  renderWithViewer,
  stubAnimationFrames,
  stubElementBox,
  stubReducedMotion,
  stubResizeObserver,
  type ResizeObserverStub,
} from "../../../test-support/canvas-view-harness.js";
import { componentId, overviewSnapshot, syntheticOverview } from "../../../test-support/overview-builder.js";
import { buildSession } from "../../../test-support/session-builder.js";
import { Brief } from "../../inspector/Brief.js";
import { Inspector } from "../../inspector/Inspector.js";
import { KeyboardLayer } from "../../shell/KeyboardLayer.js";
import { MapEdges } from "./MapEdges.js";
import { MapHeader } from "./MapHeader.js";
import { planMapFit } from "./map-camera.js";
import { MapView } from "./MapView.js";

let resize: ResizeObserverStub;

beforeEach(() => {
  resize = stubResizeObserver();
  stubElementBox(1200, 800);
  stubAnimationFrames();
  stubReducedMotion(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function sessionWith(snapshot: OverviewSnapshot | null): TraceSession {
  return buildSession({
    steps: [{ kind: "instruction", tMs: 0, text: "Map the repo" }],
    ...(snapshot === null ? {} : { overview: snapshot }),
  });
}

function renderMap(snapshot: OverviewSnapshot | null) {
  const harness = renderWithViewer(
    <>
      <MapView active />
      <Inspector host={{}} />
    </>,
    { session: sessionWith(snapshot), state: { view: "map" } },
  );
  act(() => resize.resize(1200, 800));
  return harness;
}

function cardOf(rootPath: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-map-card="${componentId(rootPath)}"]`);
  if (element === null) throw new Error(`no card for ${rootPath}`);
  return element;
}

const edgeOf = (from: string, to: string): Element | null =>
  document.querySelector(`[data-map-edge="${componentId(from)}>${componentId(to)}"]`);

const WEB_API_DB = overviewSnapshot({
  components: [
    { rootPath: "apps/web", role: "ui", purpose: "Browser app.", provenance: "model" },
    { rootPath: "packages/api", role: "api" },
    { rootPath: "packages/db", role: "storage" },
    { rootPath: "scripts", role: "tooling" },
  ],
  edges: [
    { from: "apps/web", to: "packages/api", count: 3 },
    { from: "packages/api", to: "packages/db", count: 12 },
    { from: "apps/web", to: "packages/db", count: 1 },
  ],
});

describe("MapView (spec §3.4, E13)", () => {
  it("renders every component as a card in its role band, with its edges", () => {
    renderMap(WEB_API_DB);
    expect(document.querySelectorAll("[data-map-card]")).toHaveLength(4);
    expect([...document.querySelectorAll("[data-map-band]")].map((element) => element.getAttribute("data-map-band"))).toEqual([
      "ui",
      "api",
      "storage",
      "side",
    ]);
    expect(document.querySelectorAll("[data-map-lane]")).toHaveLength(4);
    expect(document.querySelector("[data-map-band='side']")?.textContent).toContain("Support");
    expect(document.querySelectorAll("[data-map-edge]")).toHaveLength(3);
    expect(screen.getByRole("group", { name: "Codebase map, 4 components" })).toBeTruthy();
    // The card face is name and footer; the purpose (or the root path) is in its accessible name and tooltip, and on the detail level.
    expect(cardOf("apps/web").getAttribute("aria-label")).toContain("Browser app.");
    expect(cardOf("packages/api").getAttribute("aria-label")).toContain("packages/api");
    expect(document.querySelector("[data-map-external]")).toBeNull();
  });

  it("Fit centers the map and refits when the viewport resizes", () => {
    renderMap(WEB_API_DB);
    const transform = (): string | undefined => document.querySelector<HTMLElement>("[data-tv-world]")?.style.transform;
    const expected = (w: number, h: number): string => {
      const plan = planMapFit(buildOverviewModel(WEB_API_DB, 1), { w, h });
      if (plan === null) throw new Error("no fit");
      return `translate(${plan.camera.tx}px, ${plan.camera.ty}px) scale(${plan.camera.k})`;
    };
    expect(transform()).toBe(expected(1200, 800));
    act(() => resize.resize(800, 600));
    expect(transform()).toBe(expected(800, 600));
  });

  it("a scan that starts with no components fits once the first components arrive", () => {
    const transform = (): string | undefined => document.querySelector<HTMLElement>("[data-tv-world]")?.style.transform;
    const harness = renderMap(
      overviewSnapshot({ components: [], status: { scan: { state: "running", scanned: 10, total: 900 }, narrator: "pending" } }),
    );
    act(() => harness.setSession(sessionWith(WEB_API_DB)));
    const plan = planMapFit(buildOverviewModel(WEB_API_DB, 1), { w: 1200, h: 800 });
    if (plan === null) throw new Error("no fit");
    expect(transform()).toBe(`translate(${plan.camera.tx}px, ${plan.camera.ty}px) scale(${plan.camera.k})`);
  });

  it("the Brief thumbnail shows the Map's arrangement card for card after a component is added (lane 06 fix I-2)", () => {
    const crossing = {
      components: [
        { rootPath: "apps/a1", role: "ui" as const },
        { rootPath: "apps/a2", role: "ui" as const },
        { rootPath: "pkg/x", role: "domain" as const },
        { rootPath: "pkg/y", role: "domain" as const },
      ],
      edges: [{ from: "apps/a1", to: "pkg/y", count: 2 }, { from: "apps/a2", to: "pkg/x", count: 2 }],
    };
    const grown = overviewSnapshot({ ...crossing, components: [...crossing.components, { rootPath: "pkg/a", role: "domain" }] });
    const harness = renderWithViewer(
      <>
        <MapView active />
        <Brief />
      </>,
      { session: sessionWith(overviewSnapshot(crossing)), state: { view: "map" } },
    );
    act(() => resize.resize(1200, 800));
    act(() => harness.setSession(sessionWith(grown)));
    const onMap = new Map(
      [...document.querySelectorAll<HTMLElement>("[data-map-card]")].map((element) => [element.dataset.mapCard, `${element.style.left} ${element.style.top}`]),
    );
    const onThumb = new Map(
      [...document.querySelectorAll("[data-thumb-card]")].map((rect) => [rect.getAttribute("data-thumb-card") ?? "", `${rect.getAttribute("x")}px ${rect.getAttribute("y")}px`]),
    );
    expect(onMap.size).toBe(5);
    expect(onThumb).toEqual(onMap);
    // The grown snapshot's fresh arrangement differs, so only a shared sticky layout keeps the two in step.
    const fresh = layoutMap(buildOverviewModel(grown, 1), { level: "card" });
    expect(fresh.cards.some((card) => onMap.get(card.id) !== `${card.x}px ${card.y}px`)).toBe(true);
  });

  it("shows a quiet empty state without a snapshot", () => {
    renderMap(null);
    expect(screen.getByText("No codebase map yet")).toBeTruthy();
    expect(document.querySelector("[role='alert']")).toBeNull();
  });

  it("selecting a card lights its one-hop edges, dims the rest and opens the component Inspector", async () => {
    const user = userEvent.setup();
    const { store } = renderMap(WEB_API_DB);
    await user.click(cardOf("packages/api"));
    expect(store.get().mapSelection).toBe(componentId("packages/api"));
    // The selected card is the current one; a card is not a toggle (it never unpresses).
    expect(cardOf("packages/api").getAttribute("aria-current")).toBe("true");
    expect(cardOf("packages/api").hasAttribute("aria-pressed")).toBe(false);
    expect(edgeOf("apps/web", "packages/api")?.hasAttribute("data-lit")).toBe(true);
    expect(edgeOf("packages/api", "packages/db")?.hasAttribute("data-lit")).toBe(true);
    expect(edgeOf("apps/web", "packages/db")?.hasAttribute("data-dim")).toBe(true);
    expect(document.querySelector(`[data-component-inspector="${componentId("packages/api")}"]`)).not.toBeNull();
  });

  it("hovering a card lights its edges like a selection, without selecting it", async () => {
    const user = userEvent.setup();
    const { store } = renderMap(WEB_API_DB);
    await user.hover(cardOf("packages/api"));
    expect(edgeOf("apps/web", "packages/api")?.hasAttribute("data-lit")).toBe(true);
    expect(edgeOf("apps/web", "packages/db")?.hasAttribute("data-dim")).toBe(true);
    expect(store.get().mapSelection).toBeNull();
    await user.unhover(cardOf("packages/api"));
    expect(document.querySelector("[data-lit], [data-dim]")).toBeNull();
  });

  it("a stale hover or selection never leaves the edges dimmed (lane 06 fix, minor 1)", async () => {
    const user = userEvent.setup();
    const told = overviewSnapshot({
      components: [
        { rootPath: "apps/web", role: "ui" },
        { rootPath: "packages/api", role: "api" },
        { rootPath: "packages/db", role: "storage" },
        { rootPath: "scripts", role: "tooling" },
      ],
      edges: [
        { from: "apps/web", to: "packages/api", count: 3 },
        { from: "packages/api", to: "packages/db", count: 12 },
        { from: "apps/web", to: "packages/db", count: 1 },
      ],
      narrative: { provenance: "model", sentences: [{ text: "web talks to api.", citations: [{ kind: "component", id: componentId("packages/api") }] }] },
    });
    const harness = renderMap(told);
    const quiet = (): boolean => document.querySelector("[data-map-edge][data-dim], [data-map-edge][data-lit]") === null;
    // A hovered narrative link that unmounts (the Overview collapses under it) ends its hover.
    const link = document.querySelector<HTMLElement>(`[data-map-cite="${componentId("packages/api")}"]`);
    if (link === null) throw new Error("no api link");
    await user.hover(link);
    expect(quiet()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    expect(document.querySelector("[data-map-narrative]")).toBeNull();
    expect(quiet()).toBe(true);
    // A hovered card that leaves the snapshot.
    await user.hover(cardOf("packages/db"));
    expect(quiet()).toBe(false);
    const withoutDb = overviewSnapshot({
      components: [{ rootPath: "apps/web", role: "ui" }, { rootPath: "packages/api", role: "api" }, { rootPath: "scripts", role: "tooling" }],
      edges: [{ from: "apps/web", to: "packages/api", count: 3 }],
    });
    act(() => harness.setSession(sessionWith(withoutDb)));
    expect(quiet()).toBe(true);
    // A hover when the Map is hidden the way the view switcher hides it (<Activity mode="hidden"> runs no effect bodies).
    harness.setUi(
      <>
        <Activity mode="visible">
          <MapView active />
        </Activity>
        <Inspector host={{}} />
      </>,
    );
    await user.hover(cardOf("packages/api"));
    expect(quiet()).toBe(false);
    harness.setUi(
      <>
        <Activity mode="hidden">
          <MapView active={false} />
        </Activity>
        <Inspector host={{}} />
      </>,
    );
    harness.setUi(
      <>
        <Activity mode="visible">
          <MapView active />
        </Activity>
        <Inspector host={{}} />
      </>,
    );
    expect(quiet()).toBe(true);
    // A selected component that leaves the snapshot.
    act(() => harness.store.dispatch({ type: "map/select", componentId: componentId("packages/api") }));
    expect(quiet()).toBe(false);
    act(() => harness.setSession(sessionWith(overviewSnapshot({ components: [{ rootPath: "apps/web", role: "ui" }, { rootPath: "packages/db", role: "storage" }], edges: [{ from: "apps/web", to: "packages/db", count: 1 }] }))));
    expect(harness.store.get().mapSelection).toBe(componentId("packages/api"));
    expect(document.querySelectorAll("[data-map-edge]")).toHaveLength(1);
    expect(quiet()).toBe(true);
  });

  it("at rest draws band-to-band edges that do not enter a hub; a hub shows a stub, and its edges and same-band edges join on selection", async () => {
    const user = userEvent.setup();
    const importers = ["apps/web", "srv/api", "pkg/agent", "pkg/store", "pkg/a", "pkg/b"];
    renderMap(
      overviewSnapshot({
        components: [
          { rootPath: "pkg/contracts", name: "contracts", role: "domain" },
          { rootPath: "apps/web", role: "ui" },
          { rootPath: "srv/api", role: "api" },
          { rootPath: "pkg/agent", role: "agent" },
          { rootPath: "pkg/store", role: "storage" },
          { rootPath: "pkg/a", role: "domain" },
          { rootPath: "pkg/b", role: "domain" },
        ],
        edges: [
          ...importers.map((from) => ({ from, to: "pkg/contracts", count: 2 })),
          { from: "apps/web", to: "srv/api", count: 3 },
          { from: "pkg/a", to: "pkg/b", count: 1 },
        ],
      }),
    );
    const stub = `[data-map-hub-stub="${componentId("pkg/contracts")}"]`;
    expect(document.querySelectorAll("[data-map-edge]")).toHaveLength(1);
    expect(edgeOf("apps/web", "srv/api")).not.toBeNull();
    expect(document.querySelector(stub)).not.toBeNull();
    await user.click(cardOf("pkg/contracts"));
    expect(document.querySelectorAll("[data-map-edge][data-lit]")).toHaveLength(6);
    expect(edgeOf("apps/web", "srv/api")?.hasAttribute("data-dim")).toBe(true);
    expect(document.querySelector(stub)).toBeNull();
    expect(edgeOf("pkg/a", "pkg/b")).toBeNull();
    await user.click(cardOf("pkg/a"));
    expect(edgeOf("pkg/a", "pkg/b")?.hasAttribute("data-lit")).toBe(true);
  });

  it("Esc and a background click clear the map selection; the Inspector leaves the component", async () => {
    const user = userEvent.setup();
    const { store } = renderMap(WEB_API_DB);
    await user.click(cardOf("packages/api"));
    act(() => store.dispatch({ type: "esc" }));
    expect(store.get().mapSelection).toBeNull();
    expect(document.querySelector("[data-component-inspector]")).toBeNull();
    expect(cardOf("packages/api").hasAttribute("aria-current")).toBe(false);
    await user.click(cardOf("packages/db"));
    const viewport = document.querySelector<HTMLElement>("[data-tv-viewport='map']");
    if (viewport === null) throw new Error("no map viewport");
    await user.click(viewport);
    expect(store.get().mapSelection).toBeNull();
  });

  it("moves focus between cards with the arrow keys, Home and End, and selects with Enter", async () => {
    const user = userEvent.setup();
    const { store } = renderMap(WEB_API_DB);
    const web = cardOf("apps/web");
    expect(web.tabIndex).toBe(0);
    expect(cardOf("packages/api").tabIndex).toBe(-1);
    act(() => web.focus());
    fireEvent.keyDown(web, { key: "ArrowRight" });
    expect(document.activeElement).toBe(cardOf("packages/api"));
    expect(cardOf("packages/api").tabIndex).toBe(0);
    fireEvent.keyDown(cardOf("packages/api"), { key: "End" });
    expect(document.activeElement).toBe(cardOf("scripts"));
    fireEvent.keyDown(cardOf("scripts"), { key: "Home" });
    expect(document.activeElement).toBe(web);
    await user.keyboard("{Enter}");
    expect(store.get().mapSelection).toBe(componentId("apps/web"));
  });

  it("a new snapshot keeps focus, the selection and the placed order", async () => {
    const user = userEvent.setup();
    const harness = renderMap(WEB_API_DB);
    await user.click(cardOf("packages/api"));
    act(() => cardOf("packages/api").focus());
    const next = overviewSnapshot({
      components: [
        { rootPath: "apps/web", role: "ui", purpose: "Browser app and dashboard.", provenance: "model" },
        { rootPath: "packages/api", role: "api" },
        { rootPath: "packages/auth", role: "api" },
        { rootPath: "packages/db", role: "storage" },
        { rootPath: "scripts", role: "tooling" },
      ],
      edges: [{ from: "apps/web", to: "packages/api", count: 3 }, { from: "packages/api", to: "packages/db", count: 12 }],
    });
    act(() => harness.setSession(sessionWith(next)));
    expect(document.activeElement).toBe(cardOf("packages/api"));
    expect(harness.store.get().mapSelection).toBe(componentId("packages/api"));
    expect(Number.parseFloat(cardOf("packages/api").style.top)).toBeLessThan(Number.parseFloat(cardOf("packages/auth").style.top));
    // At the card level the purpose is in the accessible name and the tooltip (the detail level shows it on the face).
    expect(cardOf("apps/web").getAttribute("aria-label")).toContain("Browser app and dashboard.");
  });

  it("registers a map view port with a zoom label and no reading order", () => {
    const { registry } = renderMap(WEB_API_DB);
    const port = registry.get("map");
    expect(port).toBeDefined();
    expect(port?.zoom.label()).toMatch(/^\d+%$/);
    expect(port?.readingOrder()).toEqual([]);
    expect(port?.captureCamera()).toBeNull();
  });

  it("Review Focus 2: hostile purpose, name and narrative render as plain text", async () => {
    const hostile = "Ships builds\u202Etxt.exe **now** [docs](https://evil.example) <img src=x onerror=alert(1)>";
    const shown = "Ships builds⟨U+202E⟩txt.exe **now** [docs](https://evil.example) <img src=x onerror=alert(1)>";
    const evil = componentId("packages/evil");
    const user = userEvent.setup();
    const { result } = renderMap(
      overviewSnapshot({
        components: [
          { rootPath: "packages/evil", name: "evil\u202Ename", role: "domain", purpose: hostile, provenance: "model", language: "Type\u202EScript" },
        ],
        narrative: {
          provenance: "model",
          sentences: [{ text: "Overview \u202E**bold** https://evil.example", citations: [{ kind: "component", id: evil }] }],
        },
      }),
    );
    const card = cardOf("packages/evil");
    // The purpose shows on the detail-level card (map-card.test.tsx); here it is in the tooltip and the accessible name.
    expect(card.textContent).toContain("evil⟨U+202E⟩name");
    for (const value of [card.getAttribute("aria-label"), card.getAttribute("title")]) {
      expect(value).toContain("⟨U+202E⟩");
      expect(value).toContain(shown);
      expect(value).not.toContain("\u202E");
    }
    expect(screen.getByText(/^Overview ⟨U\+202E⟩\*\*bold\*\* https:\/\/evil\.example$/)).toBeTruthy();
    expect(document.querySelector(`[data-map-cite="${evil}"]`)?.textContent).toBe("evil⟨U+202E⟩name");
    await user.click(card);
    const inspector = document.querySelector(`[data-component-inspector="${evil}"]`);
    expect(inspector?.textContent).toContain(shown);
    expect(inspector?.textContent).toContain("evil⟨U+202E⟩name");
    expect(inspector?.textContent).toContain("Type⟨U+202E⟩Script");
    expect(result.container.querySelectorAll("strong, em, a, img")).toHaveLength(0);
    expect(result.container.textContent).not.toContain("\u202E");
  });

  it("Review Focus 1: a Python repo shows its components and a quiet imports-not-analyzed note, with no edges", () => {
    renderMap(
      overviewSnapshot({
        components: [
          { rootPath: "app", role: "api", language: "Python", importsAnalyzed: false },
          { rootPath: "lib", role: "domain", language: "Python", importsAnalyzed: false },
          { rootPath: "tests", role: "tests", language: "Python", importsAnalyzed: false },
        ],
      }),
    );
    expect(document.querySelectorAll("[data-map-card]")).toHaveLength(3);
    expect(screen.getByText("Imports not analyzed for Python")).toBeTruthy();
    expect(document.querySelectorAll("[data-map-edge]")).toHaveLength(0);
    expect(document.querySelector("[role='alert']")).toBeNull();
  });

  it("Review Focus 1: a partial map says so with its file count", () => {
    renderMap(overviewSnapshot({ components: [{ rootPath: "src", role: "domain" }], partial: true, files: 20_000 }));
    expect(screen.getByText("Partial map · 20,000 files mapped")).toBeTruthy();
    expect(document.querySelectorAll("[data-map-card]")).toHaveLength(1);
  });

  it("Review Focus 1: a 200-component partial snapshot renders every card", () => {
    const snapshot = syntheticOverview({ components: 200, edges: 1_000, seed: 3, partial: true });
    renderMap(snapshot);
    // At rest only band-to-band edges that do not enter a hub are drawn, one line per pair of components.
    const layout = layoutMap(buildOverviewModel(snapshot, 1), { level: "card" });
    const hubs = mapHubIds(layout.edges, layout.cards.length);
    const pairs = new Set(
      layout.edges.filter((edge) => edge.kind !== "same" && !hubs.has(edge.to)).map((edge) => [edge.from, edge.to].sort().join("|")),
    );
    expect(document.querySelectorAll("[data-map-card]")).toHaveLength(200);
    expect(pairs.size).toBeGreaterThan(0);
    expect(document.querySelectorAll("[data-map-edge]")).toHaveLength(pairs.size);
    expect(screen.getByText(/^Partial map · /)).toBeTruthy();
  });

  it("Review Focus 1: a partial map with the repository's total says how much it mapped", () => {
    renderMap(overviewSnapshot({ components: [{ rootPath: "src", role: "domain" }], partial: true, files: 20_000, totalFiles: 25_310 }));
    expect(screen.getByText("Partial map · 20,000 of 25,310 files")).toBeTruthy();
  });

  it("Review Focus 5: the Map says the narrator is off, quietly", () => {
    renderMap(
      overviewSnapshot({ components: [{ rootPath: "src", role: "domain" }], status: { scan: { state: "done", scanned: 1, total: 1 }, narrator: "off" } }),
    );
    expect(screen.getByText("Descriptions off")).toBeTruthy();
    expect(screen.queryByText("Descriptions pending")).toBeNull();
    expect(document.querySelector("[role='alert']")).toBeNull();
  });

  it("shows the narrative as plain sentences with component links: two sentences, then More; a link hovers and selects like its card", async () => {
    const user = userEvent.setup();
    const web = { kind: "component" as const, id: componentId("apps/web") };
    const api = { kind: "component" as const, id: componentId("packages/api") };
    const db = { kind: "component" as const, id: componentId("packages/db") };
    const { store } = renderMap(
      overviewSnapshot({
        components: [
          { rootPath: "apps/web", name: "web", role: "ui" },
          { rootPath: "packages/api", name: "api", role: "api" },
          { rootPath: "packages/db", name: "db", role: "storage" },
        ],
        edges: [{ from: "apps/web", to: "packages/api", count: 3 }, { from: "packages/api", to: "packages/db", count: 12 }],
        narrative: {
          provenance: "model",
          sentences: [
            { text: "web talks to api.", citations: [web, api] },
            { text: "api stores data in db.", citations: [api, db] },
            { text: "A third sentence stays behind More.", citations: [db] },
          ],
        },
      }),
    );
    expect(document.querySelectorAll("[data-map-narrative] [data-map-cite]")).toHaveLength(4);
    expect(screen.queryByText(/third sentence/)).toBeNull();
    const apiLink = document.querySelector<HTMLElement>(`[data-map-narrative] [data-map-cite="${api.id}"]`);
    if (apiLink === null) throw new Error("no api link");
    await user.hover(apiLink);
    expect(edgeOf("apps/web", "packages/api")?.hasAttribute("data-lit")).toBe(true);
    await user.unhover(apiLink);
    await user.click(apiLink);
    expect(store.get().mapSelection).toBe(api.id);
    expect(document.querySelector(`[data-map-narrative] [data-map-cite="${api.id}"]`)?.hasAttribute("data-selected")).toBe(true);
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByText(/third sentence/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Overview" }));
    expect(document.querySelector("[data-map-narrative]")).toBeNull();
  });

  it("a running scan shows its progress; a failed scan says the map is unavailable, quietly", () => {
    const harness = renderMap(
      overviewSnapshot({ components: [], status: { scan: { state: "running", scanned: 3_200, total: 9_800 }, narrator: "pending" } }),
    );
    expect(screen.getAllByText("Mapping codebase · 3,200 / 9,800 files")).toHaveLength(2);
    // A quiet bar beside the words: 3,200 of 9,800 files is 33%.
    const progress = document.querySelector<HTMLElement>("[data-map-note='scan-running'] [role='progressbar']");
    expect(progress?.getAttribute("aria-valuenow")).toBe("3200");
    expect(progress?.getAttribute("aria-valuemax")).toBe("9800");
    expect(progress?.querySelector<HTMLElement>("i")?.style.width).toBe("33%");
    act(() =>
      harness.setSession(
        sessionWith(
          overviewSnapshot({
            components: [{ rootPath: "src", role: "domain" }],
            status: { scan: { state: "failed", scanned: 0, total: 0, error: "git ls-files \u202Efailed" }, narrator: "off" },
          }),
        ),
      ),
    );
    const note = document.querySelector("[data-map-note='scan-failed']");
    expect(note?.textContent).toBe("Codebase map unavailable");
    expect(note?.getAttribute("title")).toBe("git ls-files ⟨U+202E⟩failed");
    expect(document.querySelectorAll("[data-map-card]")).toHaveLength(1);
    expect(document.querySelector("[role='alert']")).toBeNull();
  });

  it("a lit edge that lane 07 also emphasizes keeps its accent (lane 06 fix, minor 4)", () => {
    const layout = layoutMap(buildOverviewModel(WEB_API_DB, 1), { level: "card" });
    const key = `${componentId("packages/api")}>${componentId("packages/db")}`;
    renderWithViewer(<MapEdges layout={layout} hubs={new Set()} activeId={componentId("packages/api")} emphasized={new Set([key])} />, { session: null });
    const path = document.querySelector(`[data-map-edge="${key}"]`);
    expect(path?.hasAttribute("data-lit")).toBe(true);
    expect(path?.hasAttribute("data-emphasized")).toBe(true);
    // The two selectors weigh the same, so the stroke of the later rule wins: it must be the lit (accent) one.
    const css = readFileSync(nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "MapView.module.css"), "utf8");
    const strokes = [...css.matchAll(/^\.edge\[data-(lit|emphasized)\] \{([^}]*)\}/gm)].filter((rule) => /\bstroke:/.test(rule[2] ?? ""));
    expect(strokes.map((rule) => rule[1])).toEqual(["emphasized", "lit"]);
    expect(strokes.at(-1)?.[2]).toContain("stroke: var(--tv-accent)");
  });

  it("draws a two-way import as one line with the summed weight, lit from either end", async () => {
    const user = userEvent.setup();
    renderMap(
      overviewSnapshot({
        components: [
          { rootPath: "apps/web", role: "ui" },
          { rootPath: "packages/api", role: "api" },
        ],
        edges: [
          { from: "apps/web", to: "packages/api", count: 3 },
          { from: "packages/api", to: "apps/web", count: 2 },
        ],
      }),
    );
    const edges = document.querySelectorAll("[data-map-edge]");
    expect(edges).toHaveLength(1);
    expect(edges[0]?.hasAttribute("data-two-way")).toBe(true);
    // 3 + 2 imports reach the middle stroke (1.6 px); either direction alone would draw 1 px.
    expect(edges[0]?.getAttribute("stroke-width")).toBe("1.6");
    await user.hover(cardOf("packages/api"));
    expect(edges[0]?.hasAttribute("data-lit")).toBe(true);
  });

  describe("a relayout from a new snapshot (spec E12: the map never jumps)", () => {
    const withAgent = overviewSnapshot({
      components: [
        { rootPath: "apps/web", role: "ui", purpose: "Browser app.", provenance: "model" },
        { rootPath: "packages/api", role: "api" },
        { rootPath: "packages/worker", role: "agent" },
        { rootPath: "packages/db", role: "storage" },
        { rootPath: "scripts", role: "tooling" },
      ],
      edges: [
        { from: "apps/web", to: "packages/api", count: 3 },
        { from: "packages/api", to: "packages/db", count: 12 },
        { from: "apps/web", to: "packages/db", count: 1 },
      ],
    });
    const world = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-tv-world]");

    it("glides the cards that moved and fades the edges back in", () => {
      stubReducedMotion(false);
      const harness = renderMap(WEB_API_DB);
      expect(world()?.hasAttribute("data-relayout")).toBe(false);
      const before = Number.parseFloat(cardOf("packages/db").style.left);
      act(() => harness.setSession(sessionWith(withAgent)));
      // A new Agents band opens between API and Storage, so the Storage column shifts right by one column and gutter.
      expect(Number.parseFloat(cardOf("packages/db").style.left)).toBe(before + 140 + 22);
      expect(world()?.hasAttribute("data-relayout")).toBe(true);
      const first = world()?.getAttribute("data-relayout");
      act(() => harness.setSession(sessionWith(WEB_API_DB)));
      // Back-to-back relayouts alternate the value, so the edge fade replays.
      expect(world()?.getAttribute("data-relayout")).not.toBe(first);
      act(() => harness.setSession(sessionWith(withAgent)));
      // A snapshot that moves no card (a new purpose) glides nothing.
      const described = overviewSnapshot({
        components: [
          { rootPath: "apps/web", role: "ui", purpose: "Browser app and dashboard.", provenance: "model" },
          { rootPath: "packages/api", role: "api" },
          { rootPath: "packages/worker", role: "agent" },
          { rootPath: "packages/db", role: "storage" },
          { rootPath: "scripts", role: "tooling" },
        ],
        edges: [
          { from: "apps/web", to: "packages/api", count: 3 },
          { from: "packages/api", to: "packages/db", count: 12 },
          { from: "apps/web", to: "packages/db", count: 1 },
        ],
      });
      act(() => harness.setSession(sessionWith(described)));
      expect(world()?.hasAttribute("data-relayout")).toBe(false);
    });

    it("moves cards without gliding under reduced motion", () => {
      stubReducedMotion(true);
      const harness = renderMap(WEB_API_DB);
      const before = Number.parseFloat(cardOf("packages/db").style.left);
      act(() => harness.setSession(sessionWith(withAgent)));
      expect(Number.parseFloat(cardOf("packages/db").style.left)).toBe(before + 140 + 22);
      expect(world()?.hasAttribute("data-relayout")).toBe(false);
    });
  });

  it("Esc from the component Inspector returns focus to the inspected card and leaves the camera", async () => {
    const user = userEvent.setup();
    function WithKeys() {
      const [root, setRoot] = useState<HTMLDivElement | null>(null);
      return (
        <div ref={setRoot}>
          <main data-region="main">
            <MapView active />
          </main>
          <aside data-region="inspector" tabIndex={-1}>
            <Inspector host={{}} />
          </aside>
          <KeyboardLayer root={root} />
        </div>
      );
    }
    const harness = renderWithViewer(<WithKeys />, { session: sessionWith(WEB_API_DB), state: { view: "map" } });
    act(() => resize.resize(1200, 800));
    const transform = (): string | undefined => document.querySelector<HTMLElement>("[data-tv-world]")?.style.transform;
    await user.click(cardOf("packages/db"));
    const before = transform();
    const aside = document.querySelector<HTMLElement>("aside[data-region='inspector']");
    if (aside === null) throw new Error("no inspector region");
    act(() => aside.focus());
    fireEvent.keyDown(aside, { code: "Escape", key: "Escape" });
    expect(harness.store.get().mapSelection).toBeNull();
    expect(document.activeElement).toBe(cardOf("packages/db"));
    expect(transform()).toBe(before);
  });

  it("after a Fit below 10%, zooming out keeps the Fit zoom", () => {
    const frames = stubAnimationFrames();
    // One band of 200 cards is 18,460 world px tall: Fit in 1,200 × 800 needs k = 712 / 18,460, below 10%.
    const tall = overviewSnapshot({
      components: Array.from({ length: 200 }, (_, i) => ({ rootPath: `pkg/c${String(i).padStart(3, "0")}`, role: "domain" as const })),
    });
    const { registry } = renderMap(tall);
    act(() => frames.flush());
    const plan = planMapFit(buildOverviewModel(tall, 1), { w: 1200, h: 800 });
    if (plan === null) throw new Error("no fit");
    expect(plan.camera.k).toBeLessThan(0.1);
    const scale = (): number => Number(/scale\(([^)]+)\)/.exec(document.querySelector<HTMLElement>("[data-tv-world]")?.style.transform ?? "")?.[1]);
    expect(scale()).toBeCloseTo(plan.camera.k, 10);
    act(() => registry.get("map")?.zoom.zoomOut());
    act(() => frames.flush());
    expect(scale()).toBeCloseTo(plan.camera.k, 10);
  });

  it("promotes the world only while it moves, and sizes rings by 1 / k at rest", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const frames = stubAnimationFrames();
      const { registry } = renderMap(WEB_API_DB);
      // The jump's frame, then its settle write once the controller's promise resolves.
      await act(async () => frames.flush());
      const world = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-tv-world]");
      const plan = planMapFit(buildOverviewModel(WEB_API_DB, 1), { w: 1200, h: 800 });
      if (plan === null) throw new Error("no fit");
      expect(world()?.style.willChange).toBe("");
      expect(Number(world()?.style.getPropertyValue("--map-inv-k"))).toBeCloseTo(1 / plan.camera.k, 10);
      act(() => registry.get("map")?.zoom.zoomIn());
      act(() => frames.flush());
      expect(world()?.style.willChange).toBe("transform");
      act(() => vi.advanceTimersByTime(200));
      expect(world()?.style.willChange).toBe("");
      expect(Number(world()?.style.getPropertyValue("--map-inv-k"))).toBeCloseTo(1 / (plan.camera.k * 1.25), 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cuts the languages with an ellipsis, never the Overview toggle, in a narrow Map column (lane 03 fix wave minor 2)", () => {
    const overview = buildOverviewModel(
      overviewSnapshot({
        components: [{ rootPath: "apps/web", name: "web", role: "ui" }],
        languages: ["TypeScript", "JavaScript", "Markdown"],
        narrative: { provenance: "model", sentences: [{ text: "web is the app.", citations: [{ kind: "component", id: componentId("apps/web") }] }] },
      }),
      1,
    );
    renderWithViewer(<MapHeader overview={overview} onSelectComponent={() => undefined} />, { session: null });
    // The whole list stays readable as the tooltip when the row cuts it.
    expect(screen.getByText("TypeScript · JavaScript · Markdown").getAttribute("title")).toBe("TypeScript · JavaScript · Markdown");
    // jsdom has no layout: the row's rules are what keep the toggle whole (the dev-host smoke measures it at 396 px).
    const css = readFileSync(nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "MapView.module.css"), "utf8");
    const rule = (selector: string): string => new RegExp(`\\n\\.${selector} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    expect(rule("languages")).toMatch(/min-width: 0;/);
    expect(rule("languages")).toMatch(/overflow: hidden;/);
    expect(rule("languages")).toMatch(/text-overflow: ellipsis;/);
    expect(rule("toggle")).toMatch(/flex: none;/);
    expect(rule("headline")).toMatch(/flex: none;/);
  });

  it("each header's Overview toggle controls its own narrative, and only while it is open", async () => {
    const user = userEvent.setup();
    const overview = buildOverviewModel(
      overviewSnapshot({
        components: [{ rootPath: "apps/web", name: "web", role: "ui" }],
        narrative: { provenance: "model", sentences: [{ text: "web is the app.", citations: [{ kind: "component", id: componentId("apps/web") }] }] },
      }),
      1,
    );
    renderWithViewer(
      <>
        <MapHeader overview={overview} onSelectComponent={() => undefined} />
        <MapHeader overview={overview} onSelectComponent={() => undefined} />
      </>,
      { session: null },
    );
    const toggles = screen.getAllByRole("button", { name: "Overview" });
    const ids = toggles.map((toggle) => toggle.getAttribute("aria-controls"));
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id !== null && document.getElementById(id)?.hasAttribute("data-map-narrative")).toBe(true);
    const first = toggles[0];
    if (first === undefined) throw new Error("no toggle");
    await user.click(first);
    expect(first.hasAttribute("aria-controls")).toBe(false);
    expect(first.getAttribute("aria-expanded")).toBe("false");
  });

  describe("the first frame of a gesture (fix round 2: zoom performance)", () => {
    const viewportOf = (): HTMLElement => {
      const element = document.querySelector<HTMLElement>("[data-tv-viewport='map']");
      if (element === null) throw new Error("no map viewport");
      return element;
    };
    const world = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-tv-world]");
    const zoomWheel = (): void => {
      viewportOf().dispatchEvent(new WheelEvent("wheel", { deltaY: -10, ctrlKey: true, clientX: 600, clientY: 400, bubbles: true, cancelable: true }));
    };
    const panWheel = (): void => {
      viewportOf().dispatchEvent(new WheelEvent("wheel", { deltaX: 30, deltaY: 20, bubbles: true, cancelable: true }));
    };

    it("starts a zoom gesture with no layout read: the viewport's client origin is kept at rest", () => {
      const frames = stubAnimationFrames();
      renderMap(WEB_API_DB);
      act(() => frames.flush());
      const measure = vi.mocked(Element.prototype.getBoundingClientRect);
      measure.mockClear();
      act(() => zoomWheel());
      act(() => frames.flush());
      expect(measure).not.toHaveBeenCalled();
    });

    it("promotes the world while the pointer is over the map or focus is inside it, so a gesture's first frame changes no will-change", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const frames = stubAnimationFrames();
        renderMap(WEB_API_DB);
        await act(async () => frames.flush());
        expect(world()?.style.willChange).toBe("");
        fireEvent.pointerEnter(viewportOf());
        expect(world()?.style.willChange).toBe("transform");
        const writes: string[] = [];
        const observer = new MutationObserver(() => writes.push(world()?.style.willChange ?? ""));
        const target = world();
        if (target === null) throw new Error("no world");
        observer.observe(target, { attributes: true, attributeFilter: ["style"] });
        act(() => zoomWheel());
        act(() => frames.flush());
        act(() => vi.advanceTimersByTime(200));
        await act(async () => undefined);
        observer.disconnect();
        // The transform changed; will-change never left "transform".
        expect(writes.length).toBeGreaterThan(0);
        expect(new Set(writes)).toEqual(new Set(["transform"]));
        // Leaving during a gesture keeps it until the gesture settles.
        act(() => panWheel());
        act(() => frames.flush());
        fireEvent.pointerLeave(viewportOf());
        expect(world()?.style.willChange).toBe("transform");
        act(() => vi.advanceTimersByTime(200));
        expect(world()?.style.willChange).toBe("");
        // Focus inside the map promotes it too; blur away drops it at rest.
        act(() => cardOf("apps/web").focus());
        expect(world()?.style.willChange).toBe("transform");
        act(() => cardOf("apps/web").blur());
        expect(world()?.style.willChange).toBe("");
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps the ring variable when the world element remounts (overview, then none, then overview)", async () => {
      const frames = stubAnimationFrames();
      const harness = renderMap(WEB_API_DB);
      await act(async () => frames.flush());
      const k = (): string => world()?.style.getPropertyValue("--map-inv-k") ?? "";
      expect(k()).not.toBe("");
      act(() => harness.setSession(sessionWith(null)));
      expect(world()).toBeNull();
      act(() => harness.setSession(sessionWith(WEB_API_DB)));
      act(() => resize.resize(1200, 800));
      await act(async () => frames.flush());
      expect(k()).not.toBe("");
    });

    it("measures the client origin again when the map becomes active and once at settle, so a moved map keeps its zoom anchor", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const frames = stubAnimationFrames();
        const harness = renderMap(WEB_API_DB);
        harness.setUi(
          <>
            <MapView active={false} />
            <Inspector host={{}} />
          </>,
        );
        await act(async () => frames.flush());
        const measure = vi.mocked(Element.prototype.getBoundingClientRect);
        measure.mockClear();
        harness.setUi(
          <>
            <MapView active />
            <Inspector host={{}} />
          </>,
        );
        expect(measure).toHaveBeenCalled();
        await act(async () => frames.flush());
        measure.mockClear();
        act(() => zoomWheel());
        act(() => frames.flush());
        expect(measure).not.toHaveBeenCalled();
        act(() => vi.advanceTimersByTime(200));
        await act(async () => frames.flush());
        expect(measure).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("drops the focus promotion when the focused card unmounts", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const frames = stubAnimationFrames();
        const harness = renderMap(WEB_API_DB);
        await act(async () => frames.flush());
        act(() => cardOf("scripts").focus());
        expect(world()?.style.willChange).toBe("transform");
        const without = overviewSnapshot({
          components: [
            { rootPath: "apps/web", role: "ui" },
            { rootPath: "packages/api", role: "api" },
            { rootPath: "packages/db", role: "storage" },
          ],
          edges: [{ from: "apps/web", to: "packages/api", count: 3 }],
        });
        act(() => harness.setSession(sessionWith(without)));
        expect(document.querySelector(`[data-map-card="${componentId("scripts")}"]`)).toBeNull();
        expect(world()?.style.willChange).toBe("");
      } finally {
        vi.useRealTimers();
      }
    });

    it("writes --map-inv-k only when k changed", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const frames = stubAnimationFrames();
        renderMap(WEB_API_DB);
        act(() => frames.flush());
        const setProperty = vi.spyOn(CSSStyleDeclaration.prototype, "setProperty");
        const invWrites = (): number => setProperty.mock.calls.filter(([name]) => name === "--map-inv-k").length;
        act(() => panWheel());
        act(() => frames.flush());
        act(() => vi.advanceTimersByTime(200));
        expect(invWrites()).toBe(0);
        act(() => zoomWheel());
        act(() => frames.flush());
        act(() => vi.advanceTimersByTime(200));
        expect(invWrites()).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
