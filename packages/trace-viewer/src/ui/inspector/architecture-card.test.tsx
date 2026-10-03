// @vitest-environment jsdom
import { act, cleanup, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OverviewSnapshot } from "@jevcode/contracts";

import { componentId, overviewSnapshot } from "../../test-support/overview-builder.js";
import { buildSession, type StepSeed } from "../../test-support/session-builder.js";
import { renderHarness } from "../../test-support/ui-harness.js";
import type { ViewerHost } from "../shell/host.js";
import type { ViewState } from "../state/view-state.js";
import { MapView } from "../views/map/MapView.js";
import type { ViewDefinition } from "../views/view-port.js";
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
  });

  it("opens the Map", async () => {
    const user = userEvent.setup();
    const { store } = renderPanel(RULE_ONLY);
    await user.click(screen.getByRole("button", { name: "Open the map" }));
    expect(store.get().view).toBe("map");
  });

  it("on the Map, a selected component takes the right panel; Esc gives it back to the Brief", () => {
    const { store } = renderPanel(RULE_ONLY, { view: "map", mapSelection: componentId("packages/api") });
    expect(document.querySelector(`[data-component-inspector="${componentId("packages/api")}"]`)).not.toBeNull();
    act(() => store.dispatch({ type: "esc" }));
    expect(document.querySelector("[data-component-inspector]")).toBeNull();
    expect(document.querySelector("[data-brief-architecture]")).not.toBeNull();
  });
});
