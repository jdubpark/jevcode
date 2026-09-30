// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { foldRows } from "../../../model/index.js";
import { createStaticBundleSource } from "../../../sources/static-bundle.js";
import { TraceBuilder, testMeta } from "../../../test-support/trace-builder.js";
import {
  applyOpenDefaults,
  fixtureBundle,
  foldFixture,
  renderHarness,
  stubLayout,
  type LayoutStub,
} from "../../../test-support/ui-harness.js";
import { KeyboardLayer } from "../../shell/KeyboardLayer.js";
import { TraceViewer } from "../../shell/TraceViewer.js";
import { HybridView } from "./HybridView.js";

let layout: LayoutStub;
beforeEach(() => {
  layout = stubLayout({ width: 1400, height: 2_000 });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  layout.restore();
  vi.restoreAllMocks();
});

function WithKeys({ children }: { children: ReactNode }) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setRoot}>
      <main data-region="main">{children}</main>
      <KeyboardLayer root={root} />
    </div>
  );
}

function articles(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="feed"] article'));
}

function spineKeys(): string[] {
  return articles().map((node) => node.dataset.key ?? "");
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

describe("HybridView", () => {
  it("opens oauth in Review with the contradiction selected and expanded at +0:43", async () => {
    render(<TraceViewer source={createStaticBundleSource(fixtureBundle("oauth"))} />);
    await waitFor(() =>
      expect(document.querySelector('[data-slot="title"]')?.textContent).toBe("Claim contradicts tests"),
    );
    await settle();
    const claim = foldFixture("oauth").findings.find((finding) => finding.ruleId === "claim_contradicted");
    const row = document.querySelector<HTMLElement>(`[role="feed"] article[data-key="${claim?.anchorStepId ?? ""}"]`);
    expect(row?.textContent).toContain("+0:43");
    expect(row?.querySelector("[data-expanded]")).not.toBeNull();
    expect(screen.getByRole("button", { name: /Review/ }).getAttribute("aria-pressed")).toBe("true");
    // The hidden Canvas stays mounted under <Activity> (display: none, out of the tab order), so count the shown view.
    const hybrid = screen.getByRole("main").querySelector('[data-view="hybrid"]');
    expect(hybrid?.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });

  it("opens with both zoom readouts at the Chapter preset of the initial selection", async () => {
    // A late tail event outside the claim's chapter (like the recorded bundle's Jev pipeline tail), so the Chapter
    // preset at the session end differs from the one at the initial selection.
    const bundle = fixtureBundle("oauth");
    const last = bundle.rows.at(-1);
    const tail = {
      seq: (last?.seq ?? 0) + 1,
      type: "agent_event",
      ts: last?.ts ?? "2026-09-18T09:00:00.000Z",
      payload: { type: "agent_message", sessionId: bundle.session.sessionId, ts: "2026-09-18T09:03:00.000Z", role: "assistant", text: "Tail." },
    };
    render(<TraceViewer source={createStaticBundleSource({ ...bundle, rows: [...bundle.rows, tail] })} />);
    await waitFor(() =>
      expect(document.querySelector('[data-slot="title"]')?.textContent).toBe("Claim contradicts tests"),
    );
    await settle();
    // Title bar (spec §7.1): the level name at its preset; overview toolbar (spec §7.6.1): k / k_preset.
    const titleBar = document.querySelector('header button[aria-haspopup="true"]')?.textContent;
    const toolbar = Array.from(document.querySelectorAll<HTMLElement>("[data-overview-lanes] ~ * span, span"))
      .map((node) => node.textContent ?? "")
      .find((text) => /^\d+%$/.test(text));
    expect(titleBar).toBe("Chapter");
    expect(toolbar).toBe("100%");
    // Moving the selection (and the playhead) out of that chapter is not a zoom: both readouts keep their value.
    fireEvent.keyDown(document.body, { code: "KeyJ", key: "j" });
    await settle();
    expect(document.querySelector('[data-slot="title"]')?.textContent).not.toBe("Claim contradicts tests");
    expect(document.querySelector('header button[aria-haspopup="true"]')?.textContent).toBe("Chapter");
  });

  it("registers a port whose reading order equals the spine's step keys", async () => {
    const session = foldFixture("oauth");
    const h = renderHarness(<HybridView active />, session);
    act(() => applyOpenDefaults(h, session));
    await settle();
    const order = h.registry.get("hybrid")?.readingOrder() ?? [];
    expect(order.length).toBeGreaterThan(0);
    expect(order).toEqual(spineKeys().filter((key) => key.startsWith("step:")));
  });

  it("slides the brush past its edge on j", async () => {
    const session = foldFixture("oauth");
    const [a, , c] = session.steps.filter((step) => step.noise === null);
    const h = renderHarness(
      <WithKeys>
        <HybridView active />
      </WithKeys>,
      session,
    );
    act(() => applyOpenDefaults(h, session));
    act(() =>
      h.store.dispatch({ type: "brush/set", brush: { kind: "range", fromSeq: a?.firstSeq ?? 1, toSeq: c?.firstSeq ?? 1 }, by: "hybrid" }),
    );
    act(() => h.store.dispatch({ type: "select", id: c?.id ?? null, by: "shell" }));
    await settle();
    fireEvent.keyDown(document.body, { code: "KeyJ", key: "j" });
    await settle();
    const selected = session.steps.find((step) => step.id === h.store.get().selection);
    const brush = h.store.get().brush;
    expect(selected?.firstSeq ?? 0).toBeGreaterThan(c?.firstSeq ?? 0);
    if (brush.kind !== "range") throw new Error(`expected a range brush, got ${brush.kind}`);
    expect(typeof brush.toSeq).toBe("number");
    expect(brush.toSeq).toBeGreaterThanOrEqual(selected?.firstSeq ?? 0);
  });

  it("a j press to an off-screen row reads no scroll offset from the DOM and scrolls the spine exactly once", async () => {
    layout.restore();
    layout = stubLayout({ width: 1400, height: 200 });
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Run the scripts" });
    for (let i = 0; i < 40; i += 1) {
      b.agent({ type: "command_started", command: `node script-${i}.js` });
      b.agent({ type: "command_completed", command: `node script-${i}.js`, exitCode: 0, stdout: "", stderr: "" });
    }
    b.agent({ type: "agent_completed" });
    const session = foldRows(testMeta(), b.rows, { live: false });
    const h = renderHarness(
      <WithKeys>
        <HybridView active />
      </WithKeys>,
      session,
      { state: { level: "step" } },
    );
    act(() => applyOpenDefaults(h, session));
    // A 200 px window of 32 px rows at offset 0 (a shell select does not scroll): the next row after steps[8]
    // (288..320 px) lies below the window, so the press has to scroll.
    act(() => h.store.dispatch({ type: "select", id: session.steps[8]?.id ?? null, by: "shell" }));
    await settle();
    const feed = document.querySelector<HTMLElement>("[data-scroll-root]") as HTMLElement;
    let top = feed.scrollTop;
    let reads = 0;
    Object.defineProperty(feed, "scrollTop", {
      configurable: true,
      get: () => {
        reads += 1;
        return top;
      },
      set: (value: number) => {
        top = value;
      },
    });
    // jsdom has no scroll extent; without one the virtualizer clamps every offset to 0.
    Object.defineProperty(feed, "scrollHeight", { configurable: true, get: () => 5_000 });
    Object.defineProperty(feed, "clientHeight", { configurable: true, get: () => 200 });
    expect(top).toBe(0);
    layout.scrollCalls.length = 0;
    // Synchronous part of the press: the keydown handler plus the render and layout effects it triggers.
    await act(async () => {
      fireEvent.keyDown(document.body, { code: "KeyJ", key: "j" });
      await Promise.resolve();
    });
    const target = session.steps[9]?.id ?? "";
    expect(h.store.get().selection).toBe(target);
    expect(reads).toBe(0);
    expect(layout.scrollCalls).toHaveLength(1);
    // The scroll reveals the row: it lies whole inside the moved window.
    const row = document.querySelector<HTMLElement>(`[role="feed"] article[data-key="${target}"]`);
    const rowTop = Number(/translateY\((-?[\d.]+)px\)/.exec(row?.style.transform ?? "")?.[1] ?? Number.NaN);
    expect(top).toBeGreaterThan(0);
    expect(rowTop).toBeGreaterThanOrEqual(top);
    expect(rowTop + 32).toBeLessThanOrEqual(top + 200);
  });

  it("applies the level presets on Alt+1, Alt+2 and Alt+3", async () => {
    const session = foldFixture("oauth");
    const h = renderHarness(
      <WithKeys>
        <HybridView active />
      </WithKeys>,
      session,
    );
    act(() => applyOpenDefaults(h, session));
    await waitFor(() => expect(h.registry.get("hybrid")?.zoom.label()).toBe("Chapter"));
    const zoom = () => h.registry.get("hybrid")?.zoom;
    const cameraK = (): number | undefined => h.store.get().cameras.hybrid?.k;

    // The camera lands on the level's preset k, which is what presetFor(level) reports through the port:
    // the label reads the level name only at that k, and a preset reset then leaves k unchanged.
    const presetK = async (level: "session" | "step", label: string): Promise<number> => {
      const stored = h.store.get().cameras.hybrid;
      await waitFor(() => expect(h.store.get().level).toBe(level));
      await waitFor(() => expect(zoom()?.label()).toBe(label));
      // The level effect must also write the settled camera to the store (camera/sync).
      await waitFor(() => expect(h.store.get().cameras.hybrid).not.toBe(stored));
      const applied = cameraK();
      expect(applied).toBeDefined();
      const before = h.store.get().cameras.hybrid;
      act(() => zoom()?.resetToPreset());
      await waitFor(() => expect(h.store.get().cameras.hybrid).not.toBe(before));
      expect(cameraK()).toBeCloseTo(applied ?? Number.NaN, 6);
      return applied ?? Number.NaN;
    };

    fireEvent.keyDown(document.body, { code: "Digit1", key: "1", altKey: true });
    const sessionK = await presetK("session", "Session");
    expect(h.store.get().brush).toEqual({ kind: "session" });

    fireEvent.keyDown(document.body, { code: "Digit3", key: "3", altKey: true });
    const stepK = await presetK("step", "Step");
    expect(stepK).not.toBeCloseTo(sessionK, 4);
    expect(h.store.get().brush.kind).toBe("range");

    fireEvent.keyDown(document.body, { code: "Digit2", key: "2", altKey: true });
    await waitFor(() => expect(h.store.get().level).toBe("chapter"));
    await waitFor(() => expect(zoom()?.label()).toBe("Chapter"));
    expect(h.store.get().brush.kind).toBe("chapter");
    expect(cameraK()).not.toBeCloseTo(sessionK, 4);
  });

  it("applies a level change made while hidden when the view becomes active", async () => {
    const session = foldFixture("oauth");
    const h = renderHarness(<HybridView active />, session);
    act(() => applyOpenDefaults(h, session));
    await waitFor(() => expect(h.registry.get("hybrid")?.zoom.label()).toBe("Chapter"));
    h.result.rerender(h.wrap(<HybridView active={false} />));
    act(() => h.store.dispatch({ type: "level/set", level: "session", by: "canvas" }));
    await settle();
    expect(h.registry.get("hybrid")?.zoom.label()).not.toBe("Session");
    h.result.rerender(h.wrap(<HybridView active />));
    await waitFor(() => expect(h.registry.get("hybrid")?.zoom.label()).toBe("Session"));
  });

  it("syncs only the camera of the latest preset move", async () => {
    const session = foldFixture("oauth");
    const h = renderHarness(<HybridView active />, session);
    act(() => applyOpenDefaults(h, session));
    await waitFor(() => expect(h.registry.get("hybrid")?.zoom.label()).toBe("Chapter"));
    await settle();
    const seen: unknown[] = [];
    const stop = h.store.subscribe(() => {
      const camera = h.store.get().cameras.hybrid;
      if (camera !== null && seen.at(-1) !== camera) seen.push(camera);
    });
    act(() => {
      h.registry.get("hybrid")?.zoom.applyPreset("session");
    });
    act(() => {
      h.registry.get("hybrid")?.zoom.applyPreset("step");
    });
    await waitFor(() => expect(h.registry.get("hybrid")?.zoom.label()).toBe("Step"));
    await settle();
    stop();
    expect(seen).toHaveLength(1);
  });

  it("a zoom key in Live switches to Review", async () => {
    const source = createStaticBundleSource(fixtureBundle("oauth"), {
      drip: { rowsPerTick: 5, intervalMs: 50, manual: true, startAtSeq: 30 },
    });
    render(<TraceViewer source={source} pollMs={50} />);
    await waitFor(() => expect(spineKeys().length).toBeGreaterThan(0));
    await settle();
    expect(screen.getByRole("button", { name: /Live/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(document.body, { code: "Equal", key: "=" });
    await settle();
    expect(screen.getByRole("button", { name: /Review/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the playhead at the live edge while following", async () => {
    const source = createStaticBundleSource(fixtureBundle("oauth"), {
      drip: { rowsPerTick: 5, intervalMs: 50, manual: true, startAtSeq: 30 },
    });
    render(<TraceViewer source={source} pollMs={50} />);
    await waitFor(() => expect(spineKeys().length).toBeGreaterThan(0));
    expect(screen.getByRole("button", { name: /Live/ }).getAttribute("aria-pressed")).toBe("true");
    const before = spineKeys().join("|");
    act(() => source.tick());
    await waitFor(() => expect(spineKeys().join("|")).not.toBe(before));
    expect(articles().at(-1)?.hasAttribute("data-playhead")).toBe(true);
  });

  it("a Review append raises N new and never moves focus", async () => {
    const source = createStaticBundleSource(fixtureBundle("oauth"), {
      drip: { rowsPerTick: 5, intervalMs: 50, manual: true, startAtSeq: 30 },
    });
    render(<TraceViewer source={source} pollMs={50} />);
    await waitFor(() => expect(spineKeys().length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: /Review/ }));
    const focused = articles()[0];
    focused?.focus();
    expect(document.activeElement).toBe(focused);
    act(() => source.tick());
    await waitFor(() => expect(screen.getByRole("button", { name: /↓ \d+ new/ })).toBeTruthy());
    expect(document.activeElement).toBe(focused);
  });
});
