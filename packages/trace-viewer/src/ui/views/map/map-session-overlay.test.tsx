// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
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

function render(withOther = false) {
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
      { id: componentId("src/redis"), state: "decision", unitIds: ["u2"] },
      { id: componentId("tests"), state: "failing", unitIds: [] },
      { id: "cmp_000000000bad", state: "failing", unitIds: [] },
      { id: componentId("(other)"), state: "new", unitIds: [] },
    ],
  });
  const harness = renderWithViewer(<MapView active />, {
    session: foldRows(testMeta(), b.rows, { live: true }),
    state: { view: "map" },
  });
  act(() => resize.resize(1200, 800));
  return harness;
}

const marks = (): string[] =>
  [...document.querySelectorAll("[data-map-card] [data-state]")].map((node) => node.getAttribute("data-state") ?? "").sort();
const legend = (): HTMLElement | null => screen.queryByRole("list", { name: "Session overlay legend" });

describe("Map session overlay (spec §3.4)", () => {
  it("marks touched cards by state, emphasizes touched edges, and hides both with the Session toggle", () => {
    render();
    expect(marks()).toEqual(["changed", "decision", "failing", "new"]);
    expect(document.querySelectorAll("[data-emphasized]")).toHaveLength(2);
    expect(document.querySelector("[data-session]")).not.toBeNull();
    expect(legend()?.textContent).toBe("1 new1 changed1 decided1 failing");
    const toggle = screen.getByRole("button", { name: "Session" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(marks()).toEqual([]);
    expect(document.querySelectorAll("[data-emphasized]")).toHaveLength(0);
    expect(document.querySelector("[data-session]")).toBeNull();
    expect(legend()).toBeNull();
    fireEvent.click(toggle);
    expect(marks()).toHaveLength(4);
  });

  it("does not crash on an unknown id, and draws the (other) component's mark only when the map has it", () => {
    render(true);
    expect(marks()).toEqual(["changed", "decision", "failing", "new", "new"]);
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
});
