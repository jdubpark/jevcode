// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStaticBundleSource } from "../../../sources/static-bundle.js";
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
    const main = screen.getByRole("main");
    expect(main.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
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
    expect(brush.kind).toBe("range");
    if (brush.kind === "range" && brush.toSeq !== "live") expect(brush.toSeq).toBeGreaterThanOrEqual(selected?.firstSeq ?? 0);
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
    await settle();
    fireEvent.keyDown(document.body, { code: "Digit1", key: "1", altKey: true });
    await settle();
    expect(h.store.get().level).toBe("session");
    expect(h.store.get().brush).toEqual({ kind: "session" });
    fireEvent.keyDown(document.body, { code: "Digit3", key: "3", altKey: true });
    await settle();
    expect(h.store.get().level).toBe("step");
    expect(h.store.get().brush.kind).toBe("range");
    fireEvent.keyDown(document.body, { code: "Digit2", key: "2", altKey: true });
    await settle();
    expect(h.store.get().level).toBe("chapter");
    expect(h.store.get().brush.kind).toBe("chapter");
    await waitFor(() => expect(h.registry.get("hybrid")?.zoom.label()).toBe("Chapter"));
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
