// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TraceSession } from "../../model/index.js";
import type { TraceSource } from "../../source.js";
import { createStaticBundleSource } from "../../sources/static-bundle.js";
import { fixtureBundle, foldFixture, renderHarness, stubLayout, type LayoutStub } from "../../test-support/ui-harness.js";
import type { ViewDefinition, ViewPort } from "../views/view-port.js";
import { TitleBar } from "./TitleBar.js";
import { TraceViewer } from "./TraceViewer.js";

let layout: LayoutStub;
beforeEach(() => {
  layout = stubLayout();
});
afterEach(() => {
  cleanup();
  layout.restore();
});

const noop = (): void => undefined;
const hybrid: ViewDefinition = { kind: "hybrid", label: "Hybrid", icon: "view-hybrid", Component: () => null };
const canvas: ViewDefinition = { kind: "canvas", label: "Canvas", icon: "view-canvas", Component: () => null };

describe("TitleBar", () => {
  it("shows repoName / prompt with the full prompt in the tooltip", () => {
    const session = foldFixture("oauth");
    renderHarness(<TitleBar onRetry={noop} />, session);
    const title = screen.getByText(session.meta.repoName).closest("p");
    expect(title?.textContent).toBe(`${session.meta.repoName} / ${session.meta.prompt.split("\n")[0] ?? ""}`);
    expect(title?.getAttribute("title")).toBe(session.meta.prompt);
  });

  it("data-quality chips are neutral", () => {
    const base = foldFixture("oauth");
    const session: TraceSession = {
      ...base,
      coverage: { ...base.coverage, approximateJoins: true },
      gaps: [
        { kind: "invalid_row", atSeq: 5, message: "payload failed its schema" },
        { kind: "unpaired", atSeq: 9, message: "start without completion" },
        { kind: "missing_evidence", atSeq: 12, message: "claim without a repo fact" },
      ],
    };
    const h = renderHarness(<TitleBar onRetry={noop} />, session);
    const approx = screen.getByText("≈ Approximate joins");
    const gaps = screen.getByRole("button", { name: "3 gaps" });
    expect(approx.getAttribute("data-tone")).toBe("neutral");
    expect(gaps.getAttribute("data-tone")).toBe("neutral");

    fireEvent.click(gaps);
    fireEvent.click(screen.getByRole("button", { name: /^seq 9/ }));
    const expected = [...session.steps].reverse().find((step) => step.firstSeq <= 9)?.id;
    expect(h.store.get().selection).toBe(expected);
  });

  it("shows a placeholder and no duration before the first event", () => {
    const base = foldFixture("oauth");
    const session: TraceSession = { ...base, meta: { ...base.meta, prompt: "", state: "starting" }, steps: [] };
    renderHarness(<TitleBar onRetry={noop} />, session, { terminal: false });
    expect(screen.getByText("Waiting for the first prompt")).toBeTruthy();
    expect(screen.queryByText("0 ms")).toBeNull();
  });

  it("re-enables Live when a terminal session becomes live again", () => {
    const session = foldFixture("oauth");
    renderHarness(<TitleBar onRetry={noop} />, session, { terminal: false });
    const live = screen.getByRole("button", { name: /^Live/ });
    expect(live.hasAttribute("disabled")).toBe(false);
  });

  it("disables Live and labels it Completed on a terminal session", () => {
    renderHarness(<TitleBar onRetry={noop} />, foldFixture("oauth"));
    const live = screen.getByRole("button", { name: /Completed/ });
    expect(live.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: /Review/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("says Completed once: on the disabled Live segment, with only the duration in the meta", () => {
    renderHarness(<TitleBar onRetry={noop} />, foldFixture("oauth"));
    const completed = [...document.querySelectorAll("span")].filter((node) => node.textContent === "Completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.closest("button")?.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("45 s")).toBeTruthy();
  });

  it("keeps the loading progress in the meta", () => {
    renderHarness(<TitleBar onRetry={noop} />, foldFixture("oauth"), { status: { kind: "loading" }, loadedFraction: 0.41, terminal: false });
    expect(screen.getByText("Loading 41%")).toBeTruthy();
  });

  it("reads the live agent state, so a session that ends while open shows Completed", async () => {
    const inner = createStaticBundleSource(fixtureBundle("oauth"));
    let ended = false;
    const source: TraceSource = {
      sessionId: inner.sessionId,
      summary: async () => ({ ...(await inner.summary()), state: "running" }),
      rows: async (request) => {
        const page = await inner.rows(request);
        return ended ? page : { ...page, state: "running" };
      },
      payloads: (seqs) => inner.payloads(seqs),
      now: () => inner.now(),
    };
    render(<TraceViewer source={source} pollMs={20} />);
    const follow = await screen.findByRole("group", { name: "Follow" });
    await waitFor(() => expect(follow.querySelectorAll("button")[1]?.hasAttribute("disabled")).toBe(false));
    expect(follow.querySelectorAll("button")[1]?.textContent).toBe("Live");

    ended = true;
    await waitFor(() => expect(follow.querySelectorAll("button")[1]?.textContent).toBe("Completed"));
    expect(follow.querySelectorAll("button")[1]?.hasAttribute("disabled")).toBe(true);
  });

  it("shows the N new pill with a red dot only when a new critical finding arrived", () => {
    const session = foldFixture("oauth");
    const critical = session.findings.filter((finding) => finding.severity === "critical").map((f) => f.anchorSeq);
    expect(critical.length).toBeGreaterThan(0);
    const lastStepSeq = session.steps.at(-1)?.firstSeq ?? 0;
    const seenAllCritical = Math.max(...critical);
    expect(seenAllCritical).toBeLessThan(lastStepSeq);

    renderHarness(<TitleBar onRetry={noop} />, session, { state: { follow: false, lastSeenSeq: seenAllCritical } });
    expect(screen.getByRole("button", { name: /new/ })).toBeTruthy();
    expect(screen.queryByTestId("new-critical-dot")).toBeNull();
    cleanup();

    renderHarness(<TitleBar onRetry={noop} />, session, { state: { follow: false, lastSeenSeq: Math.min(...critical) - 1 } });
    expect(screen.getByTestId("new-critical-dot")).toBeTruthy();
  });

  it("shows the display-clock span, never endedAt − startedAt", () => {
    const base = foldFixture("oauth");
    const session: TraceSession = {
      ...base,
      meta: { ...base.meta, endedAt: new Date(Date.parse(base.meta.startedAt) + 3_600_000).toISOString() },
    };
    renderHarness(<TitleBar onRetry={noop} />, session);
    expect(screen.getByText("45 s")).toBeTruthy();
    expect(screen.queryByText("1 h 00 m")).toBeNull();
  });

  it("shows Reconnecting with the attempt number", () => {
    renderHarness(<TitleBar onRetry={noop} />, foldFixture("oauth"), {
      status: { kind: "reconnecting", attempt: 2, retryInMs: 2_000 },
    });
    expect(screen.getByText("Reconnecting (2)")).toBeTruthy();
  });

  it("shows the channel, the message and Retry on a first-load error", () => {
    const onRetry = vi.fn();
    renderHarness(<TitleBar onRetry={onRetry} />, null, {
      status: { kind: "error", channel: "trace:rows", code: "SOURCE_FAILED", message: "socket closed" },
    });
    expect(screen.getByText("trace:rows: socket closed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders the view switch only when more than one view exists", () => {
    const session = foldFixture("oauth");
    renderHarness(<TitleBar onRetry={noop} />, session, { views: [hybrid] });
    expect(screen.queryByRole("radiogroup", { name: "View" })).toBeNull();
    cleanup();

    const h = renderHarness(<TitleBar onRetry={noop} />, session, { views: [canvas, hybrid] });
    expect(screen.getByRole("radiogroup", { name: "View" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Canvas/ }));
    expect(h.store.get().view).toBe("canvas");
  });
  it("the view switch is one tab stop; arrows, Home and End move the checked view with focus", () => {
    const session = foldFixture("oauth");
    const h = renderHarness(<TitleBar onRetry={noop} />, session, { views: [canvas, hybrid] });
    const radio = (name: RegExp): HTMLElement => screen.getByRole("radio", { name });
    const stops = (): string[] =>
      screen.getAllByRole("radio").filter((node) => node.closest('[aria-label="View"]') !== null).map((node) => node.getAttribute("tabindex") ?? "0");
    act(() => h.store.dispatch({ type: "view/switch", view: "canvas" }));
    expect(stops()).toEqual(["0", "-1"]);
    radio(/Canvas/).focus();
    fireEvent.keyDown(radio(/Canvas/), { key: "ArrowRight" });
    expect(h.store.get().view).toBe("hybrid");
    expect(document.activeElement).toBe(radio(/Hybrid/));
    expect(stops()).toEqual(["-1", "0"]);
    fireEvent.keyDown(radio(/Hybrid/), { key: "ArrowRight" });
    expect(h.store.get().view).toBe("canvas");
    expect(document.activeElement).toBe(radio(/Canvas/));
    fireEvent.keyDown(radio(/Canvas/), { key: "ArrowLeft" });
    expect(h.store.get().view).toBe("hybrid");
    fireEvent.keyDown(radio(/Hybrid/), { key: "Home" });
    expect(h.store.get().view).toBe("canvas");
    expect(document.activeElement).toBe(radio(/Canvas/));
    fireEvent.keyDown(radio(/Canvas/), { key: "End" });
    expect(h.store.get().view).toBe("hybrid");
    expect(document.activeElement).toBe(radio(/Hybrid/));
  });

  describe("popover dismissal", () => {
    const gapSession = (): TraceSession => ({
      ...foldFixture("oauth"),
      gaps: [{ kind: "invalid_row", atSeq: 5, message: "x" }],
    });
    const port = (): ViewPort => ({
      readingOrder: () => [],
      reveal: noop,
      captureCamera: () => null,
      focusSelected: noop,
      zoom: {
        label: () => "Session",
        presets: () => [{ id: "session", label: "Session" }],
        applyPreset: noop,
        zoomIn: noop,
        zoomOut: noop,
        resetToPreset: noop,
        fitAll: noop,
        fitSelection: noop,
      },
    });

    it("Escape closes the gaps popover and returns focus to its trigger", () => {
      renderHarness(<TitleBar onRetry={noop} />, gapSession());
      const trigger = screen.getByRole("button", { name: "1 gap" });
      fireEvent.click(trigger);
      expect(screen.getByRole("list", { name: "Gaps" })).toBeTruthy();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("list", { name: "Gaps" })).toBeNull();
      expect(document.activeElement).toBe(trigger);
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    });

    it("an outside pointerdown closes the gaps popover but a pointerdown inside does not", () => {
      renderHarness(<TitleBar onRetry={noop} />, gapSession());
      fireEvent.click(screen.getByRole("button", { name: "1 gap" }));
      fireEvent.pointerDown(screen.getByRole("list", { name: "Gaps" }));
      expect(screen.getByRole("list", { name: "Gaps" })).toBeTruthy();
      fireEvent.pointerDown(document.body);
      expect(screen.queryByRole("list", { name: "Gaps" })).toBeNull();
    });

    it("the zoom menu is plain buttons that Escape and an outside click dismiss", () => {
      const h = renderHarness(<TitleBar onRetry={noop} />, foldFixture("oauth"), { views: [hybrid] });
      act(() => {
        h.registry.register("hybrid", port());
      });
      const trigger = screen.getByRole("button", { name: /Session/ });
      fireEvent.click(trigger);
      expect(screen.queryByRole("menu")).toBeNull();
      expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
      expect(screen.getByRole("button", { name: "Fit all" })).toBeTruthy();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("button", { name: "Fit all" })).toBeNull();
      expect(document.activeElement).toBe(trigger);
      fireEvent.click(trigger);
      fireEvent.pointerDown(document.body);
      expect(screen.queryByRole("button", { name: "Fit all" })).toBeNull();
    });

    it("the approximate-joins chip is a focusable button that opens the window-rule explanation", () => {
      const base = foldFixture("oauth");
      renderHarness(<TitleBar onRetry={noop} />, { ...base, coverage: { ...base.coverage, approximateJoins: true } });
      const chip = screen.getByRole("button", { name: /Approximate joins/ });
      expect(chip.getAttribute("data-tone")).toBe("neutral");
      fireEvent.click(chip);
      expect(screen.getByRole("dialog", { name: "Approximate joins" }).textContent).toContain("time window");
      const rule = screen.getByRole("dialog", { name: "Approximate joins" }).textContent ?? "";
      expect(rule).toContain("within 5 s");
      expect(rule).toContain("latest earlier edit");
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("dialog", { name: "Approximate joins" })).toBeNull();
      expect(document.activeElement).toBe(chip);
    });
  });

  it("renders the prompt line through displayUntrusted", () => {
    const base = foldFixture("oauth");
    const session: TraceSession = { ...base, meta: { ...base.meta, prompt: "Fix\u202Eevil\nsecond line" } };
    renderHarness(<TitleBar onRetry={noop} />, session);
    const title = screen.getByText(session.meta.repoName).closest("p");
    expect(title?.textContent).toContain("Fix⟨U+202E⟩evil");
    expect(title?.textContent).not.toContain("\u202E");
    expect(title?.getAttribute("title")?.includes("\u202E")).toBe(false);
  });

  it("names each view's number key in its title", () => {
    renderHarness(<TitleBar onRetry={noop} />, foldFixture("oauth"), { views: [canvas, hybrid] });
    expect(screen.getByRole("radio", { name: /Canvas/ }).getAttribute("title")).toBe("Canvas (1)");
    expect(screen.getByRole("radio", { name: /Hybrid/ }).getAttribute("title")).toBe("Hybrid (2)");
  });

  it("the embedded bar shows no title and leaves the switch to the host", () => {
    const session = foldFixture("oauth");
    const firstLine = session.meta.prompt.split(/\r?\n/)[0] ?? "";
    renderHarness(<TitleBar onRetry={noop} chrome="embedded" showSwitch={false} />, session, { views: [canvas, hybrid] });
    expect(screen.queryByRole("radiogroup", { name: "View" })).toBeNull();
    expect(screen.queryByText(firstLine)).toBeNull();
    expect(screen.getByRole("group", { name: "Follow" })).toBeTruthy();
  });

  it("the embedded bar shows the gaps chip as its icon and count, with the full text as name and tooltip (lane 03 D-6)", () => {
    const base = foldFixture("oauth");
    const gaps = Array.from({ length: 160 }, (_, position) => ({ kind: "missing_evidence" as const, atSeq: position + 1, message: "x" }));
    const session: TraceSession = { ...base, gaps };
    renderHarness(<TitleBar onRetry={noop} chrome="embedded" />, session, { views: [canvas, hybrid] });
    const chip = screen.getByRole("button", { name: "160 gaps" });
    expect(chip.textContent).toBe("160");
    expect(chip.getAttribute("title")).toBe("160 gaps");
    expect(chip.querySelector("svg")).not.toBeNull();
    fireEvent.click(chip);
    expect(screen.getByRole("list", { name: "Gaps" }).children).toHaveLength(160);
    cleanup();

    // The trace window's full chrome keeps the worded chip.
    renderHarness(<TitleBar onRetry={noop} />, session);
    const full = screen.getByRole("button", { name: "160 gaps" });
    expect(full.textContent).toBe("160 gaps");
    expect(full.getAttribute("aria-label")).toBeNull();
  });
});
