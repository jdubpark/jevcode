// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
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
import { Inspector } from "../../inspector/Inspector.js";
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
    expect(cardOf("packages/api").getAttribute("aria-pressed")).toBe("true");
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
    expect(cardOf("packages/api").getAttribute("aria-pressed")).toBe("false");
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
});
