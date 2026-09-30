// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStaticBundleSource } from "../../sources/static-bundle.js";
import {
  fixtureBundle,
  foldFixture,
  renderHarness,
  stubLayout,
  type LayoutStub,
} from "../../test-support/ui-harness.js";
import type { ViewerLocation } from "../state/location.js";
import type { ViewDefinition } from "../views/view-port.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { useAnnounce } from "./LiveRegion.js";
import { INITIAL_SELECTION_PAINTED } from "./perf.js";
import { appendCapped, MAX_REPORTED_ERRORS } from "./Shell.js";
import { TraceViewer } from "./TraceViewer.js";
import { ViewSlot } from "./ViewSlot.js";

let layout: LayoutStub;

beforeEach(() => {
  layout = stubLayout();
});

afterEach(() => {
  cleanup();
  layout.restore();
  vi.restoreAllMocks();
});

function Broken(): never {
  throw new Error("boom");
}

describe("Shell", () => {
  it("renders header, nav, main and aside landmarks with inline tokens", () => {
    const { container } = render(<TraceViewer source={createStaticBundleSource(fixtureBundle("oauth"))} />);
    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Outline" })).toBeTruthy();
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Inspector" })).toBeTruthy();
    const root = container.querySelector<HTMLElement>("[data-trace-viewer]");
    expect(root?.style.getPropertyValue("--tv-accent")).toBe("#2F6BFF");
    expect(root?.style.getPropertyValue("--tv-ink-3")).toBe("#676D78");
  });

  it("calls onReady once with the row count after the first committed fold", async () => {
    const bundle = fixtureBundle("oauth");
    const onReady = vi.fn();
    render(<TraceViewer source={createStaticBundleSource(bundle)} host={{ onReady }} />);
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(onReady).toHaveBeenCalledWith({ rows: bundle.rows.length, loadedThroughSeq: bundle.rows.at(-1)?.seq });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("resolves a decision: location to the decision step", async () => {
    const bundle = fixtureBundle("oauth");
    const decisionStep = foldFixture("oauth").steps.find((step) => step.kind === "decision");
    const decisionId = decisionStep?.decision?.decisionId;
    expect(decisionId).toBeDefined();
    const location: ViewerLocation = {
      v: 1,
      sessionId: bundle.session.sessionId,
      view: "hybrid",
      level: "chapter",
      brush: { kind: "session" },
      selected: `decision:${decisionId ?? ""}`,
    };
    const onLocation = vi.fn();
    render(<TraceViewer source={createStaticBundleSource(bundle)} location={location} host={{ onLocation }} />);
    await waitFor(() => expect(onLocation.mock.calls.at(-1)?.[0]?.selected).toBe(decisionStep?.id));
  });

  it("marks tv:initial-selection-painted in the first frame after the commit that applies the initial selection", async () => {
    performance.clearMarks(INITIAL_SELECTION_PAINTED);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => frames.push(callback));
    const runFrame = (): void => {
      for (const callback of frames.splice(0)) callback(performance.now());
    };
    // Spec §1: oauth opens with its claim step selected.
    const claim = foldFixture("oauth").steps.find((step) => step.text === "OAuth implementation complete; all checks pass.");
    expect(claim).toBeDefined();
    const onLocation = vi.fn();
    render(<TraceViewer source={createStaticBundleSource(fixtureBundle("oauth"))} host={{ onLocation }} />);
    await waitFor(() => expect(onLocation.mock.calls.at(-1)?.[0]?.selected).toBe(claim?.id));
    expect(performance.getEntriesByName(INITIAL_SELECTION_PAINTED, "mark")).toHaveLength(0);
    act(runFrame);
    expect(performance.getEntriesByName(INITIAL_SELECTION_PAINTED, "mark")).toHaveLength(1);
    act(runFrame);
    expect(performance.getEntriesByName(INITIAL_SELECTION_PAINTED, "mark")).toHaveLength(1);
  });

  it("sets no initial-selection mark when the session opens in Live", async () => {
    performance.clearMarks(INITIAL_SELECTION_PAINTED);
    const source = createStaticBundleSource(fixtureBundle("oauth"), {
      drip: { rowsPerTick: 5, intervalMs: 50, manual: true, startAtSeq: 30 },
    });
    const onReady = vi.fn();
    const onLocation = vi.fn();
    render(<TraceViewer source={source} pollMs={50} host={{ onReady, onLocation }} />);
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(onLocation.mock.calls.at(-1)?.[0]?.selected).toBeUndefined();
    expect(performance.getEntriesByName(INITIAL_SELECTION_PAINTED, "mark")).toHaveLength(0);
  });

  it("an Inspector render error shows the Inspector boundary and keeps the selection", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const session = foldFixture("oauth");
    const selected = session.steps[1]?.id ?? null;
    const h = renderHarness(
      <ErrorBoundary region="Inspector">
        <Broken />
      </ErrorBoundary>,
      session,
      { state: { selection: selected } },
    );
    expect(screen.getByRole("alert").textContent).toContain("Inspector failed to render");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(h.store.get().selection).toBe(selected);
  });

  it("a view boundary offers a switch to the other view", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const views: readonly ViewDefinition[] = [
      { kind: "canvas", label: "Canvas", icon: "view-canvas", Component: () => <p>canvas body</p> },
      { kind: "hybrid", label: "Hybrid", icon: "view-hybrid", Component: Broken },
    ];
    const h = renderHarness(<ViewSlot views={views} keepHiddenMounted={false} />, foldFixture("oauth"), {
      state: { view: "hybrid" },
    });
    expect(screen.getByRole("alert").textContent).toContain("Hybrid failed to render");
    fireEvent.click(screen.getByRole("button", { name: "Switch to Canvas" }));
    expect(h.store.get().view).toBe("canvas");
    expect(screen.getByText("canvas body")).toBeTruthy();
  });

  it("announces through one polite live region and throttles by key", () => {
    let announce: ReturnType<typeof useAnnounce> = () => undefined;
    function Grab(): null {
      announce = useAnnounce();
      return null;
    }
    const h = renderHarness(<Grab />, null);
    act(() => {
      announce("Live follow paused");
      announce("3 new steps", { key: "new", minIntervalMs: 10_000 });
      announce("4 new steps", { key: "new", minIntervalMs: 10_000 });
    });
    expect(h.announcements).toEqual(["Live follow paused", "3 new steps"]);
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
    expect(screen.getByRole("status").textContent).toBe("3 new steps");
  });

  it("does not re-run the open logic when a parent passes a new but equal location", async () => {
    const bundle = fixtureBundle("oauth");
    const source = createStaticBundleSource(bundle);
    const onDiagnostics = vi.fn();
    const host = { onDiagnostics };
    const makeLocation = (): ViewerLocation => ({
      v: 1,
      sessionId: bundle.session.sessionId,
      view: "hybrid",
      level: "chapter",
      brush: { kind: "session" },
    });
    const view = render(<TraceViewer source={source} host={host} location={makeLocation()} />);
    await waitFor(() => expect(onDiagnostics.mock.calls.length).toBeGreaterThan(0));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    const before = onDiagnostics.mock.calls.length;
    view.rerender(<TraceViewer source={source} host={host} location={makeLocation()} />);
    view.rerender(<TraceViewer source={source} host={host} location={makeLocation()} />);
    expect(onDiagnostics.mock.calls.length).toBe(before);
  });

  it("caps reported errors at 50, dropping the oldest", () => {
    let list: readonly string[] = [];
    for (let i = 0; i < MAX_REPORTED_ERRORS + 10; i += 1) list = appendCapped(list, `e${i}`, MAX_REPORTED_ERRORS);
    expect(MAX_REPORTED_ERRORS).toBe(50);
    expect(list).toHaveLength(50);
    expect(list[0]).toBe("e10");
    expect(list.at(-1)).toBe("e59");
  });
});
