// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStaticBundleSource } from "../../sources/static-bundle.js";
import { buildTraceIndex } from "../../layout/trace-index.js";
import { foldRows, type TraceSession } from "../../model/index.js";
import { TraceBuilder, testMeta } from "../../test-support/trace-builder.js";
import {
  createHarness,
  fixtureBundle,
  foldFixture,
  renderHarness,
  stubLayout,
  type LayoutStub,
} from "../../test-support/ui-harness.js";
import type { ViewerLocation } from "../state/location.js";
import type { ViewDefinition } from "../views/view-port.js";
import { ViewStoreContext } from "../state/store.js";
import { DecisionAnnouncer } from "./DecisionAnnouncer.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { LiveRegion, useAnnounce } from "./LiveRegion.js";
import { SessionContext } from "./session-context.js";
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
  vi.useRealTimers();
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
    // The right panel is named after what it shows (lane fix m3): the Brief until a selection opens the Inspector.
    expect(screen.getByRole("complementary", { name: /^(Brief|Inspector)$/ })).toBeTruthy();
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

  it("cancels the pending initial-selection frame when the viewer unmounts", async () => {
    performance.clearMarks(INITIAL_SELECTION_PAINTED);
    const frames = new Map<number, FrameRequestCallback>();
    let nextId = 1;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.set(nextId, callback);
      return nextId++;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    const onLocation = vi.fn();
    const view = render(<TraceViewer source={createStaticBundleSource(fixtureBundle("oauth"))} host={{ onLocation }} />);
    await waitFor(() => expect(onLocation.mock.calls.at(-1)?.[0]?.selected).toBeDefined());
    view.unmount();
    act(() => {
      for (const callback of [...frames.values()]) callback(performance.now());
    });
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

  it("a region boundary reports its error through the diagnostics sink", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reportError = vi.fn();
    renderHarness(
      <ErrorBoundary region="Outline">
        <Broken />
      </ErrorBoundary>,
      foldFixture("oauth"),
      { diagnostics: { enabled: true, reportDrift: () => undefined, reportError, flush: () => undefined } },
    );
    expect(reportError).toHaveBeenCalledWith("Outline: boom");
  });

  it("a throw in the Shell's own work shows a top-level boundary, reports through onDiagnostics, and Retry recovers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onDiagnostics = vi.fn();
    let armed = true;
    const onReady = vi.fn(() => {
      if (armed) throw new Error("shell exploded");
    });
    render(<TraceViewer source={createStaticBundleSource(fixtureBundle("oauth"))} host={{ onReady, onDiagnostics }} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Trace viewer failed to render");
    expect(onDiagnostics.mock.calls.some(([d]) => d.errors.some((e: string) => e.includes("shell exploded")))).toBe(true);
    armed = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("banner")).toBeTruthy());
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

  describe("trailing throttle", () => {
    function grabAnnounce() {
      const ref: { announce: ReturnType<typeof useAnnounce> } = { announce: () => undefined };
      function Grab(): null {
        ref.announce = useAnnounce();
        return null;
      }
      return { ref, Grab };
    }
    const options = { key: "new", minIntervalMs: 10_000 };

    it("speaks the update held inside the window when the window ends", () => {
      vi.useFakeTimers();
      const { ref, Grab } = grabAnnounce();
      const h = renderHarness(<Grab />, null);
      act(() => ref.announce("3 new steps", options));
      vi.advanceTimersByTime(2_000);
      act(() => ref.announce("3 new steps, 1 problem", options));
      expect(h.announcements).toEqual(["3 new steps"]);
      vi.advanceTimersByTime(7_999);
      expect(h.announcements).toEqual(["3 new steps"]);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(h.announcements).toEqual(["3 new steps", "3 new steps, 1 problem"]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("keeps only the latest of several updates inside the window", () => {
      vi.useFakeTimers();
      const { ref, Grab } = grabAnnounce();
      const h = renderHarness(<Grab />, null);
      act(() => ref.announce("a", options));
      for (const text of ["b", "c", "d"]) {
        vi.advanceTimersByTime(1_000);
        act(() => ref.announce(text, options));
      }
      expect(vi.getTimerCount()).toBe(1);
      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      expect(h.announcements).toEqual(["a", "d"]);
    });

    it("clears the pending timer on unmount", () => {
      vi.useFakeTimers();
      const { ref, Grab } = grabAnnounce();
      const h = renderHarness(<Grab />, null);
      act(() => ref.announce("a", options));
      act(() => ref.announce("b", options));
      expect(vi.getTimerCount()).toBe(1);
      h.result.unmount();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(20_000);
      expect(h.announcements).toEqual(["a"]);
    });
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

  it("names the right panel after what it shows: Inspector for a selection, Brief once Esc clears it (lane fix m3)", async () => {
    render(<TraceViewer source={createStaticBundleSource(fixtureBundle("oauth"))} />);
    // A finished session opens with its top finding selected (viewer spec §7.8), so the Inspector shows.
    expect(await screen.findByRole("complementary", { name: "Inspector" })).toBeTruthy();
    for (let i = 0; i < 4 && screen.queryByRole("complementary", { name: "Brief" }) === null; i += 1) {
      fireEvent.keyDown(document.body, { code: "Escape", key: "Escape" });
    }
    expect(screen.getByRole("complementary", { name: "Brief" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Inspector" })).toBeNull();
  });
});

describe("DecisionAnnouncer (lane fix m6)", () => {
  it("announces a decision that becomes pending after the load once, as untrusted text, and none pending at load", async () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.decision({ id: "d0", title: "Already open" });
    const fold = (): TraceSession =>
      foldRows(testMeta({ state: "running", lastEventSeq: b.rows.length }), b.rows, { live: true, nowMs: Date.parse("2026-09-18T09:30:00.000Z") });
    const first = fold();
    const h = createHarness(first, { state: { loaded: true } });
    const tree = (session: TraceSession) => (
      <ViewStoreContext.Provider value={h.store}>
        <SessionContext.Provider value={{ ...h.view, session, index: buildTraceIndex(session) }}>
          <LiveRegion onAnnounce={(message) => h.announcements.push(message)}>
            <DecisionAnnouncer />
          </LiveRegion>
        </SessionContext.Provider>
      </ViewStoreContext.Provider>
    );
    const result = render(tree(first));
    expect(h.announcements).toEqual([]);

    b.decision({ id: "d1", title: "Keep \u202Eemail login?" });
    result.rerender(tree(fold()));
    await waitFor(() => expect(h.announcements).toEqual(["Decision needed: Keep ⟨U+202E⟩email login?"]));

    b.agent({ type: "agent_message", role: "assistant", text: "more" });
    b.decision({ id: "d1", title: "Keep \u202Eemail login?" });
    result.rerender(tree(fold()));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(h.announcements).toHaveLength(1);
  });

  it("still announces a decision that arrives in the commit where an answer message is absorbed (steps shrink and grow)", async () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.decision({ id: "d0", title: "Keep email login?" });
    b.agent({ type: "agent_message", role: "user", text: "Keep both" });
    const fold = (): TraceSession =>
      foldRows(testMeta({ state: "running", lastEventSeq: b.rows.length }), b.rows, { live: true, nowMs: Date.parse("2026-09-18T09:30:00.000Z") });
    const first = fold();
    const h = createHarness(first, { state: { loaded: true } });
    const tree = (session: TraceSession) => (
      <ViewStoreContext.Provider value={h.store}>
        <SessionContext.Provider value={{ ...h.view, session, index: buildTraceIndex(session) }}>
          <LiveRegion onAnnounce={(message) => h.announcements.push(message)}>
            <DecisionAnnouncer />
          </LiveRegion>
        </SessionContext.Provider>
      </ViewStoreContext.Provider>
    );
    const result = render(tree(first));
    // The answer closes d0 and absorbs the user message step (removeStep); d1 opens in the same commit.
    b.decision({ id: "d0", title: "Keep email login?", status: "answered", answer: { decisionId: "d0", decision: { choice: "a" }, evidence: [] } });
    b.decision({ id: "d1", title: "Rotate the signing key?" });
    const second = fold();
    expect(second.steps).toHaveLength(first.steps.length);
    result.rerender(tree(second));
    await waitFor(() => expect(h.announcements).toEqual(["Decision needed: Rotate the signing key?"]));
  });
});
