// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OverviewSnapshot } from "@jevcode/contracts";

import { buildTraceIndex, type SelectionId } from "../../layout/trace-index.js";
import { buildOverviewModel, type TraceSession } from "../../model/index.js";
import { componentId, overviewSnapshot } from "../../test-support/overview-builder.js";
import { buildSession, type StepSeed } from "../../test-support/session-builder.js";
import { foldFixture, renderHarness, stubLayout } from "../../test-support/ui-harness.js";
import type { ViewerHost } from "../shell/host.js";
import { KeyboardLayer } from "../shell/KeyboardLayer.js";
import { Outline } from "../shell/Outline/Outline.js";
import type { ViewState } from "../state/view-state.js";
import { MapView } from "../views/map/MapView.js";
import type { ViewDefinition } from "../views/view-port.js";
import { selectionTitle } from "./finding-copy.js";
import { RightPanel } from "./RightPanel.js";

afterEach(() => cleanup());

const MAP_VIEW: ViewDefinition = { kind: "map", label: "Map", icon: "view-map", Component: () => null };
const steps: StepSeed[] = [
  { kind: "instruction", tMs: 0, text: "Fix the login" },
  { kind: "edit", tMs: 1_000, target: "packages/db/src/users.ts", edit: { added: 3, removed: 1 } },
  { kind: "edit", tMs: 2_000, target: "apps/web/src/Login.tsx", edit: { added: 10, removed: 2 } },
];
const RULE_ONLY = overviewSnapshot({
  components: [{ rootPath: "apps/web", role: "ui" }, { rootPath: "packages/api", role: "api" }, { rootPath: "packages/db", role: "storage" }],
  edges: [{ from: "apps/web", to: "packages/api", count: 4 }],
});

const FAILED = overviewSnapshot({
  components: [{ rootPath: "apps/web", role: "ui" }],
  status: { scan: { state: "failed", scanned: 0, total: 0, error: "git ls-files \u202Efailed" }, narrator: "off" },
});

/** The right panel with nothing selected shows the Brief (spec E4, §3.3). */
function renderPanel(snapshot: OverviewSnapshot | null, state: Partial<ViewState> = {}, host: ViewerHost = {}) {
  const session = buildSession({ steps, ...(snapshot === null ? {} : { overview: snapshot }) });
  return renderHarness(<RightPanel host={host} />, session, { views: [MAP_VIEW], host, state: { view: "console", selection: null, ...state } });
}

function part(): HTMLElement {
  const element = document.querySelector<HTMLElement>("[data-brief-architecture]");
  if (element === null) throw new Error("no architecture part");
  return element;
}

describe("Brief architecture part (spec §3.3 item 3)", () => {
  it("Review Focus 5: narrative null shows rule-based data and a quiet pending note", () => {
    renderPanel(RULE_ONLY);
    const text = part().textContent ?? "";
    expect(text).toContain("3 components · 2 touched");
    expect(text).toContain("Descriptions pending");
    expect(text).not.toMatch(/error|unavailable|retry|failed/i);
    expect(document.querySelector("[role='alert']")).toBeNull();
    expect(part().querySelectorAll("[data-map-thumbnail] rect[data-thumb-card]")).toHaveLength(3);
    expect(part().querySelectorAll("[data-map-thumbnail] rect[data-thumb-lane]").length).toBeGreaterThan(0);
    expect(part().querySelectorAll("[data-map-thumbnail] rect[data-touched]")).toHaveLength(2);
    expect(part().querySelector("[data-map-thumbnail] path")).toBeNull();
  });

  it("Review Focus 5: narrator off or unavailable reads quietly", () => {
    for (const narrator of ["off", "unavailable"] as const) {
      renderPanel(overviewSnapshot({ components: [{ rootPath: "apps/web", role: "ui" }], status: { scan: { state: "done", scanned: 3, total: 3 }, narrator } }));
      const text = part().textContent ?? "";
      expect(text).toContain(narrator === "off" ? "Descriptions off" : "Descriptions unavailable");
      expect(text).not.toContain("Descriptions pending");
      expect(text).not.toMatch(/error|failed|retry/i);
      expect(document.querySelector("[role='alert']")).toBeNull();
      cleanup();
    }
  });

  it("a failed scan says the map is unavailable and offers Retry, quietly", async () => {
    const user = userEvent.setup();
    const rescanOverview = vi.fn();
    renderPanel(FAILED, {}, { rescanOverview });
    const text = part().textContent ?? "";
    expect(text).toContain("Codebase map unavailable");
    expect(text).not.toContain("\u202E");
    await user.click(within(part()).getByRole("button", { name: "Retry" }));
    expect(rescanOverview).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[role='alert']")).toBeNull();
  });

  it("a failed scan without a host rescan offers no Retry", () => {
    renderPanel(FAILED);
    expect(within(part()).queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("the Map header offers the same Retry through the host", async () => {
    const user = userEvent.setup();
    const rescanOverview = vi.fn();
    renderHarness(<MapView active />, buildSession({ steps, overview: FAILED }), { host: { rescanOverview }, state: { view: "map" } });
    const note = document.querySelector<HTMLElement>("[data-map-note='scan-failed']");
    if (note === null) throw new Error("no scan note");
    await user.click(within(note).getByRole("button", { name: "Retry" }));
    expect(rescanOverview).toHaveBeenCalledTimes(1);
  });

  it("no snapshot: the quiet empty state, no thumbnail and no alert", () => {
    renderPanel(null);
    expect(screen.getByText("Appears here once this repository is scanned.")).toBeTruthy();
    expect(document.querySelector("[data-map-thumbnail]")).toBeNull();
    expect(document.querySelector("[role='alert']")).toBeNull();
  });

  it("shows the narrator's overview as plain text beside the thumbnail", () => {
    renderPanel(
      overviewSnapshot({
        components: [{ rootPath: "apps/web", role: "ui" }],
        narrative: {
          provenance: "model",
          sentences: [{ text: "A web ‮app **with** [a link](https://evil.example).", citations: [{ kind: "component", id: componentId("apps/web") }] }],
        },
      }),
    );
    const text = part().textContent ?? "";
    expect(text).toContain("A web ⟨U+202E⟩app **with** [a link](https://evil.example).");
    expect(text).not.toContain("‮");
    expect(text).not.toContain("Descriptions pending");
    expect(part().querySelectorAll("strong, em, a")).toHaveLength(0);
    expect(part().querySelector("[data-map-thumbnail]")).not.toBeNull();
    // Clamped to four lines on screen, so the full sanitized text is the tooltip.
    expect(part().querySelector("p[title]")?.getAttribute("title")).toBe("A web ⟨U+202E⟩app **with** [a link](https://evil.example).");
  });

  it("a scan that found no components draws no thumbnail but keeps the counts and Retry", () => {
    renderPanel(
      overviewSnapshot({ components: [], status: { scan: { state: "failed", scanned: 0, total: 0, error: "git ls-files failed" }, narrator: "off" } }),
      {},
      { rescanOverview: vi.fn() },
    );
    expect(part().querySelector("[data-map-thumbnail]")).toBeNull();
    expect(part().textContent ?? "").toContain("0 components");
    expect(within(part()).getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("a first scan with no components yet shows only the progress box (lane 06 fix I-4)", () => {
    renderPanel(overviewSnapshot({ components: [], status: { scan: { state: "running", scanned: 3_200, total: 9_800 }, narrator: "pending" } }));
    expect(screen.getByText("Mapping codebase · 3,200 / 9,800 files")).toBeTruthy();
    expect(document.querySelector("[data-brief-architecture]")).toBeNull();
    expect(document.querySelector("[data-map-thumbnail]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open the map" })).toBeNull();
    expect(document.querySelector("[role='alert']")).toBeNull();
  });

  it("a rescan keeps the map, the counts and Open the map, with a quiet progress line (lane 06 fix I-4)", () => {
    renderPanel(
      overviewSnapshot({
        components: [{ rootPath: "apps/web", role: "ui" }, { rootPath: "packages/api", role: "api" }, { rootPath: "packages/db", role: "storage" }],
        status: { scan: { state: "running", scanned: 3_200, total: 9_800 }, narrator: "ready" },
      }),
    );
    expect(part().querySelectorAll("[data-map-thumbnail] rect[data-thumb-card]")).toHaveLength(3);
    expect(part().textContent ?? "").toContain("3 components · 2 touched");
    const line = part().querySelector<HTMLElement>("[data-brief-scan]");
    expect(line?.textContent).toBe("Mapping codebase · 3,200 / 9,800 files");
    expect(line?.querySelector("[aria-hidden='true'] > span")?.getAttribute("style")).toContain("width: 33%");
    expect(within(part()).getByRole("button", { name: "Open the map" })).toBeTruthy();
    expect(part().querySelector("[role='alert'], [role='status'], [role='progressbar']")).toBeNull();
    expect(document.querySelector("[role='alert']")).toBeNull();
  });

  it("opens the Map", async () => {
    const user = userEvent.setup();
    const { store } = renderPanel(RULE_ONLY);
    await user.click(screen.getByRole("button", { name: "Open the map" }));
    expect(store.get().view).toBe("map");
    // Already on the Map, the button goes (lane 06 fix, minor 6); the thumbnail and counts stay.
    expect(screen.queryByRole("button", { name: "Open the map" })).toBeNull();
    expect(part().querySelector("[data-map-thumbnail]")).not.toBeNull();
    act(() => store.dispatch({ type: "view/switch", view: "console" }));
    expect(screen.getByRole("button", { name: "Open the map" })).toBeTruthy();
  });

  it("on the Map, a selected component takes the right panel; Esc gives it back to the Brief", () => {
    const { store } = renderPanel(RULE_ONLY, { view: "map", mapSelection: componentId("packages/api") });
    expect(document.querySelector(`[data-component-inspector="${componentId("packages/api")}"]`)).not.toBeNull();
    act(() => store.dispatch({ type: "esc" }));
    expect(document.querySelector("[data-component-inspector]")).toBeNull();
    expect(document.querySelector("[data-brief-architecture]")).not.toBeNull();
  });

  it("Shift+B on the Map toggles a selected component's Inspector and the Brief, and says which (lane 06 fix, minor 3)", () => {
    function Viewer() {
      const [root, setRoot] = useState<HTMLDivElement | null>(null);
      return (
        <div ref={setRoot}>
          <aside data-region="inspector">
            <RightPanel host={{}} />
          </aside>
          <KeyboardLayer root={root} />
        </div>
      );
    }
    const card = componentId("packages/api");
    const session = buildSession({ steps, overview: RULE_ONLY });
    const { store, announcements } = renderHarness(<Viewer />, session, { views: [MAP_VIEW], state: { view: "map", selection: null, mapSelection: card } });
    const shiftB = (): void => {
      fireEvent.keyDown(document.body, { code: "KeyB", key: "B", shiftKey: true });
    };
    const showing = (): string => (document.querySelector("[data-component-inspector]") !== null ? "component" : document.querySelector("[data-brief]") !== null ? "brief" : "other");
    expect(showing()).toBe("component");
    act(shiftB);
    expect([showing(), announcements.at(-1)]).toEqual(["brief", "Brief"]);
    act(shiftB);
    expect([showing(), announcements.at(-1)]).toEqual(["component", "Inspector"]);
    // With a step selected under the component, B still toggles what the panel shows.
    const step = session.steps.find((item) => item.kind === "edit")?.id;
    if (step === undefined) throw new Error("no edit step");
    act(() => store.dispatch({ type: "select", id: step, by: "shell" }));
    act(() => store.dispatch({ type: "map/select", componentId: card }));
    act(shiftB);
    expect([showing(), announcements.at(-1)]).toEqual(["brief", "Brief"]);
    act(shiftB);
    expect([showing(), announcements.at(-1)]).toEqual(["component", "Inspector"]);
  });

  it("a session change in the component Inspector opens its step and keeps focus in the panel (lane 06 fix, minor 2)", async () => {
    const user = userEvent.setup();
    const { store } = renderPanel(RULE_ONLY, { view: "map", mapSelection: componentId("packages/db") });
    const change = document.querySelector<HTMLElement>("[data-component-change]");
    if (change === null) throw new Error("no session change row");
    await user.click(change);
    expect(store.get().selection).not.toBeNull();
    expect(document.querySelector("[data-component-inspector]")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.getAttribute("role")).toBe("tabpanel");
  });

  it("on the Map with a card selected, n and an Outline step show that step's Inspector (lane 06 fix I-1)", async () => {
    const layout = stubLayout({ height: 2_000, rowHeight: 28 });
    try {
      const session: TraceSession = { ...foldFixture("oauth"), overview: buildOverviewModel(RULE_ONLY, 1) };
      const index = buildTraceIndex(session);
      function Viewer() {
        const [root, setRoot] = useState<HTMLDivElement | null>(null);
        return (
          <div ref={setRoot}>
            <nav data-region="outline">
              <Outline hiddenRows={0} />
            </nav>
            <aside data-region="inspector">
              <RightPanel host={{}} />
            </aside>
            <KeyboardLayer root={root} />
          </div>
        );
      }
      const card = componentId("packages/api");
      const { store } = renderHarness(<Viewer />, session, { views: [MAP_VIEW], state: { view: "map", selection: null, mapSelection: card } });
      await act(async () => undefined);
      const shownTitle = (): string | null | undefined => document.querySelector("aside [data-slot='title']")?.textContent;
      expect(document.querySelector(`[data-component-inspector="${card}"]`)).not.toBeNull();

      fireEvent.keyDown(document.body, { code: "KeyN", key: "n" });
      const finding = store.get().selection;
      expect(finding).not.toBeNull();
      expect(document.querySelector("[data-component-inspector]")).toBeNull();
      expect(shownTitle()).toBe(selectionTitle(session, index, finding as SelectionId));

      act(() => store.dispatch({ type: "map/select", componentId: card }));
      expect(document.querySelector(`[data-component-inspector="${card}"]`)).not.toBeNull();
      const entity = session.entities.find((item) => item.stepIds.at(-1) !== finding);
      const step = entity?.stepIds.at(-1);
      if (entity === undefined || step === undefined) throw new Error("the oauth fixture has no second edited file");
      fireEvent.click(document.querySelector<HTMLElement>(`[data-key="${entity.id}"]`) as HTMLElement);
      expect(store.get().selection).toBe(step);
      expect(document.querySelector("[data-component-inspector]")).toBeNull();
      expect(shownTitle()).toBe(selectionTitle(session, index, step));
    } finally {
      layout.restore();
    }
  });
});
