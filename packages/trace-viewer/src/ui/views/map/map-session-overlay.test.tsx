// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type React from "react";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { foldRows } from "../../../model/index.js";
import {
  renderWithViewer,
  stubAnimationFrames,
  stubElementBox,
  stubReducedMotion,
  stubResizeObserver,
  type ResizeObserverStub,
} from "../../../test-support/canvas-view-harness.js";
import { componentId, overviewSnapshot } from "../../../test-support/overview-builder.js";
import { TraceBuilder, testMeta } from "../../../test-support/trace-builder.js";
import { Brief } from "../../inspector/Brief.js";
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

function buildRows(withOther: boolean): TraceBuilder {
  const b = new TraceBuilder();
  b.agent({ type: "agent_started", prompt: "Add a limiter" });
  b.overview(
    overviewSnapshot({
      components: [
        { rootPath: "src/server", role: "api" },
        { rootPath: "src/middleware" },
        { rootPath: "src/redis", role: "storage" },
        { rootPath: "tests", role: "tests" },
        { rootPath: "config", role: "config" },
        ...(withOther ? [{ rootPath: "(other)", role: "tooling" as const }] : []),
      ],
      edges: [
        { from: "src/server", to: "src/middleware", count: 3 },
        { from: "src/middleware", to: "src/redis", count: 2 },
        { from: "src/server", to: "config", count: 1 },
      ],
    }),
  );
  b.explainer({
    kind: "highlights",
    basisSeq: 2,
    components: [
      { id: componentId("src/server"), state: "changed", unitIds: ["u1"] },
      { id: componentId("src/middleware"), state: "new", unitIds: ["u1"] },
      { id: componentId("src/redis"), state: "decision", states: ["new", "decision"], unitIds: ["u2"] },
      { id: componentId("tests"), state: "failing", states: ["new", "failing"], unitIds: [] },
      { id: "cmp_000000000bad", state: "failing", unitIds: [] },
      { id: componentId("(other)"), state: "new", unitIds: [] },
    ],
  });
  return b;
}

function render(withOther = false, ui: React.ReactElement = <MapView active />, view: "map" | "hybrid" = "map") {
  const b = buildRows(withOther);
  const harness = renderWithViewer(ui, {
    session: foldRows(testMeta(), b.rows, { live: true }),
    state: { view },
  });
  act(() => resize.resize(1200, 800));
  return harness;
}

const marks = (): string[] =>
  [...document.querySelectorAll("[data-map-card] [data-state]")].map((node) => node.getAttribute("data-state") ?? "").sort();
const marksOf = (rootPath: string): string[] =>
  [...document.querySelectorAll(`[data-map-card="${componentId(rootPath)}"] [data-state]`)].map((node) => node.getAttribute("data-state") ?? "");
const legend = (): HTMLElement | null => screen.queryByRole("list", { name: "Session overlay legend" });

describe("Map session overlay (spec §3.4)", () => {
  it("marks touched cards by state, emphasizes touched edges, and hides both with the Session toggle", () => {
    render();
    expect(marks()).toEqual(["changed", "decision", "failing", "new", "new", "new"]);
    expect(marksOf("src/redis")).toEqual(["new", "decision"]);
    expect(marksOf("tests")).toEqual(["new", "failing"]);
    expect(document.querySelectorAll("[data-emphasized]")).toHaveLength(2);
    expect(document.querySelector("[data-session]")).not.toBeNull();
    expect(legend()?.textContent).toBe("3 new1 changed1 decided1 failing");
    const toggle = screen.getByRole("button", { name: "Session" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(marks()).toEqual([]);
    expect(document.querySelectorAll("[data-emphasized]")).toHaveLength(0);
    expect(document.querySelector("[data-session]")).toBeNull();
    expect(legend()).toBeNull();
    fireEvent.click(toggle);
    expect(marks()).toHaveLength(6);
  });

  it("does not crash on an unknown id, and draws the (other) component's mark only when the map has it", () => {
    render(true);
    expect(marks()).toEqual(["changed", "decision", "failing", "new", "new", "new", "new"]);
    expect(document.querySelector(`[data-map-card="${componentId("(other)")}"] [data-state="new"]`)).not.toBeNull();
  });

  it("puts the toggle in the tab order before the cards", async () => {
    render();
    const toggle = screen.getByRole("button", { name: "Session" });
    toggle.focus();
    await userEvent.tab();
    expect(document.activeElement).not.toBe(toggle);
    expect(toggle.compareDocumentPosition(document.activeElement as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the Brief on the Map lists this session's components with their marks, and a row selects the component", () => {
    const harness = render(
      false,
      <>
        <MapView active />
        <Brief />
      </>,
    );
    expect(screen.getByRole("heading", { name: "This session · 4 components" })).not.toBeNull();
    expect(document.querySelector("[data-brief-architecture]")).toBeNull();
    const rows = [...document.querySelectorAll("[data-brief-session-row]")];
    // Sorted by name: middleware, redis, server, tests.
    expect(rows.map((row) => row.getAttribute("data-brief-session-row"))).toEqual(
      ["src/middleware", "src/redis", "src/server", "tests"].map(componentId),
    );
    expect(rows.map((row) => row.getAttribute("title"))).toEqual(["middleware", "redis", "server", "tests"]);
    expect(screen.getByRole("button", { name: "redis, new in this session and touched by a decision" })).not.toBeNull();
    expect([...(rows[3]?.querySelectorAll("[data-state]") ?? [])].map((node) => node.getAttribute("data-state"))).toEqual(["new", "failing"]);
    fireEvent.click(rows[2] as Element);
    expect(harness.store.get().mapSelection).toBe(componentId("src/server"));
  });

  it("marks the selected row aria-current and activates a focused row with Enter", async () => {
    const harness = render(false, <><MapView active /><Brief /></>);
    const row = document.querySelector<HTMLElement>(`[data-brief-session-row="${componentId("src/redis")}"]`);
    expect(row?.getAttribute("aria-current")).toBeNull();
    row?.focus();
    await userEvent.keyboard("{Enter}");
    expect(harness.store.get().mapSelection).toBe(componentId("src/redis"));
    expect(document.querySelector(`[data-brief-session-row="${componentId("src/redis")}"]`)?.getAttribute("aria-current")).toBe("true");
    expect(document.querySelectorAll("[data-brief-session-row][aria-current]")).toHaveLength(1);
  });

  it("moves focus to the section heading when the focused row's component leaves the list", async () => {
    const harness = render(false, <><MapView active /><Brief /></>);
    const row = document.querySelector<HTMLElement>(`[data-brief-session-row="${componentId("src/redis")}"]`);
    row?.focus();
    expect(document.activeElement).toBe(row);
    const b = buildRows(false);
    b.explainer({
      kind: "highlights",
      basisSeq: 3,
      components: [{ id: componentId("src/server"), state: "changed", unitIds: ["u1"] }],
    });
    act(() => harness.setSession(foldRows(testMeta(), b.rows, { live: true })));
    expect(document.querySelector(`[data-brief-session-row="${componentId("src/redis")}"]`)).toBeNull();
    const heading = screen.getByRole("heading", { name: "This session · 1 component" });
    expect(heading.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(heading);
  });

  it("repairs focus in the Brief's own document, not the global one (a popout window, lane review minor 1)", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const popout = frame.contentDocument as Document;
    // The main window keeps a focus of its own while the popout's row has the popout's focus.
    const outside = document.createElement("input");
    document.body.append(outside);
    const harness = renderWithViewer(createPortal(<Brief />, popout.body), {
      session: foldRows(testMeta(), buildRows(false).rows, { live: true }),
      state: { view: "map" },
    });
    const row = popout.querySelector<HTMLElement>(`[data-brief-session-row="${componentId("src/redis")}"]`);
    row?.focus();
    outside.focus();
    expect(popout.activeElement).toBe(row);
    expect(document.activeElement).toBe(outside);
    const b = buildRows(false);
    b.explainer({
      kind: "highlights",
      basisSeq: 3,
      components: [{ id: componentId("src/server"), state: "changed", unitIds: ["u1"] }],
    });
    act(() => harness.setSession(foldRows(testMeta(), b.rows, { live: true })));
    expect(popout.querySelector(`[data-brief-session-row="${componentId("src/redis")}"]`)).toBeNull();
    const heading = popout.querySelector<HTMLElement>("h3[tabindex='-1']");
    expect(heading?.textContent).toContain("This session · 1 component");
    expect(popout.activeElement).toBe(heading);
    expect(document.activeElement).toBe(outside);
    frame.remove();
    outside.remove();
  });

  it("outside the Map the Brief keeps its Architecture part", () => {
    render(false, <Brief />, "hybrid");
    expect(screen.getByRole("heading", { name: "Architecture" })).not.toBeNull();
    expect(document.querySelector("[data-brief-session]")).toBeNull();
  });
});
