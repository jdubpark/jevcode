// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_OVERLAY_NODES } from "../../../../layout/overview-layout.js";
import { RecordingContext } from "../../../../test-support/recording-context.js";
import {
  foldFixture,
  renderHarness,
  stubLayout,
  type HarnessOptions,
  type LayoutStub,
} from "../../../../test-support/ui-harness.js";
import { KeyboardLayer } from "../../../shell/KeyboardLayer.js";
import { Overview, type OverviewApi } from "./Overview.js";

let layout: LayoutStub;
beforeEach(() => {
  layout = stubLayout({ width: 1400, height: 600 });
});
afterEach(() => {
  cleanup();
  layout.restore();
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

async function renderOverview(options: HarnessOptions = {}) {
  const session = foldFixture("oauth");
  const apiRef: { current: OverviewApi | null } = { current: null };
  const h = renderHarness(
    <WithKeys>
      <Overview
        active
        apiRef={apiRef}
        spineWindow={null}
        onSettle={() => undefined}
        createContext={() => new RecordingContext()}
      />
    </WithKeys>,
    session,
    options,
  );
  await act(async () => undefined);
  await act(async () => undefined);
  return { h, session, apiRef };
}

function slider(): HTMLElement {
  return screen.getByRole("slider", { name: "Playhead" });
}

function claimStep(): `step:${number}` {
  const claim = foldFixture("oauth").findings.find((finding) => finding.ruleId === "claim_contradicted");
  if (claim === undefined) throw new Error("oauth has no claim_contradicted finding");
  return claim.anchorStepId;
}

describe("Overview", () => {
  it("moves the playhead on a click on the empty track and keeps the selection", async () => {
    const selected = claimStep();
    const { h } = await renderOverview({ state: { selection: selected } });
    const track = screen.getByTestId("overview-track");
    fireEvent.pointerDown(track, { clientX: 300, button: 0, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 300, pointerId: 1 });
    expect(h.store.get().playhead.kind).toBe("free");
    expect(h.store.get().selection).toBe(selected);
  });

  it("treats a drag under 4 px as a click", async () => {
    const { h } = await renderOverview();
    const track = screen.getByTestId("overview-track");
    fireEvent.pointerDown(track, { clientX: 300, button: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 302, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 302, pointerId: 1 });
    expect(h.store.get().playhead.kind).toBe("free");
    expect(h.store.get().brush).toEqual({ kind: "session" });
  });

  it("draws a range brush on a longer drag", async () => {
    const { h } = await renderOverview();
    const track = screen.getByTestId("overview-track");
    fireEvent.pointerDown(track, { clientX: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 700, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 700, pointerId: 1 });
    const brush = h.store.get().brush;
    expect(brush.kind).toBe("range");
    if (brush.kind === "range") expect(brush.toSeq === "live" || brush.fromSeq < brush.toSeq).toBe(true);
    expect(h.store.get().gesture).toBeNull();
  });

  it("names the playhead slider with offset, title and position", async () => {
    const session = foldFixture("oauth");
    const selected = claimStep();
    await renderOverview({ state: { selection: selected } });
    const position = session.steps.findIndex((step) => step.id === selected) + 1;
    expect(slider().getAttribute("aria-valuetext")).toBe(
      `+0:43, Claim contradicts tests, step ${position} of ${session.steps.length}`,
    );
    expect(slider().getAttribute("aria-valuenow")).toBe(String(position));
  });

  it("moves one step, one pin or one band start with the arrow keys", async () => {
    const session = foldFixture("oauth");
    await renderOverview({ state: { selection: session.steps[0]?.id ?? null } });
    const now = (): number => Number(slider().getAttribute("aria-valuenow"));
    const start = now();
    fireEvent.keyDown(slider(), { key: "ArrowRight" });
    expect(now()).toBe(start + 1);

    const pinned = new Set(
      Array.from(document.querySelectorAll<HTMLElement>("[data-steps]")).flatMap((pin) =>
        (pin.dataset.steps ?? "").split(",").map((value) => Number(value) + 1),
      ),
    );
    fireEvent.keyDown(slider(), { key: "ArrowRight", altKey: true });
    expect(pinned.has(now())).toBe(true);

    const beforeShift = now();
    fireEvent.keyDown(slider(), { key: "ArrowRight", shiftKey: true });
    expect(now()).toBeGreaterThan(beforeShift);
  });

  it("sets the brush from the playhead with {, } and b", async () => {
    const session = foldFixture("oauth");
    const { h } = await renderOverview();
    // The claim step sits inside a chapter; oauth's first steps precede every chapter, where `b` falls back to a turn range.
    const claimId = claimStep();
    const seq = session.steps.find((step) => step.id === claimId)?.firstSeq ?? 1;
    act(() => h.store.dispatch({ type: "playhead/set", playhead: { kind: "free", seq }, origin: "program" }));
    fireEvent.keyDown(document.body, { code: "BracketLeft", key: "{", shiftKey: true });
    const afterFrom = h.store.get().brush;
    expect(afterFrom.kind).toBe("range");
    if (afterFrom.kind === "range") expect(afterFrom.fromSeq).toBe(seq);
    fireEvent.keyDown(document.body, { code: "KeyB", key: "b" });
    expect(h.store.get().brush.kind).toBe("chapter");
  });

  it("keeps the overlay within 150 nodes at Session level and names every pin", async () => {
    const { h } = await renderOverview();
    act(() => h.store.dispatch({ type: "level/set", level: "session", by: "hybrid" }));
    await act(async () => undefined);
    expect(document.querySelectorAll("[data-overlay-node]").length).toBeLessThanOrEqual(MAX_OVERLAY_NODES);
    const pins = Array.from(document.querySelectorAll<HTMLElement>("[data-steps]"));
    expect(pins.length).toBeGreaterThan(0);
    for (const pin of pins) expect((pin.getAttribute("aria-label") ?? "").length).toBeGreaterThan(0);
  });

  it("shows the claim pin at Chapter level", async () => {
    await renderOverview({ state: { selection: claimStep() } });
    const labels = Array.from(document.querySelectorAll<HTMLElement>("[data-steps]")).map((pin) => pin.getAttribute("aria-label") ?? "");
    expect(labels.some((label) => label.startsWith("Claim contradicts tests"))).toBe(true);
  });

  it("ends a drag on pointercancel without committing and clears the gesture", async () => {
    const { h } = await renderOverview();
    const before = h.store.get().brush;
    const track = screen.getByTestId("overview-track");
    fireEvent.pointerDown(track, { clientX: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 500, pointerId: 1 });
    expect(h.store.get().gesture).toBe("brush");
    fireEvent.pointerCancel(track, { pointerId: 1 });
    expect(h.store.get().gesture).toBeNull();
    const afterCancel = h.store.get().brush;
    fireEvent.pointerMove(track, { clientX: 900, pointerId: 1 });
    expect(h.store.get().brush).toEqual(afterCancel);
    expect(before.kind).toBe("session");
  });

  it("clears the gesture when it unmounts mid-drag", async () => {
    const { h } = await renderOverview();
    const track = screen.getByTestId("overview-track");
    fireEvent.pointerDown(track, { clientX: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 500, pointerId: 1 });
    expect(h.store.get().gesture).toBe("brush");
    cleanup();
    expect(h.store.get().gesture).toBeNull();
  });

  it("scrubs with the playhead handle and never leaves a gesture behind on lost capture", async () => {
    const { h } = await renderOverview();
    const handle = slider();
    fireEvent.pointerDown(handle, { clientX: 200, button: 0, pointerId: 2 });
    fireEvent.pointerMove(handle, { clientX: 600, pointerId: 2 });
    expect(h.store.get().gesture).toBe("playhead");
    expect(h.store.get().playhead.kind).toBe("free");
    fireEvent(handle, new Event("lostpointercapture"));
    expect(h.store.get().gesture).toBeNull();
  });

  it("keeps focus on the playhead slider across a data and level rebuild", async () => {
    const { h } = await renderOverview();
    act(() => slider().focus());
    fireEvent.keyDown(slider(), { key: "ArrowRight" });
    act(() => h.store.dispatch({ type: "level/set", level: "session", by: "hybrid" }));
    await act(async () => undefined);
    act(() => h.store.dispatch({ type: "level/set", level: "chapter", by: "hybrid" }));
    await act(async () => undefined);
    expect(document.activeElement).toBe(slider());
  });

  it("exposes the range edges as sliders and jumps the playhead with Home and End", async () => {
    const session = foldFixture("oauth");
    const { h } = await renderOverview();
    const from = session.steps[3]?.firstSeq ?? 1;
    const to = session.steps[9]?.firstSeq ?? from;
    act(() => h.store.dispatch({ type: "brush/set", brush: { kind: "range", fromSeq: from, toSeq: to }, by: "hybrid" }));
    for (const [name, position] of [["Range start", 4], ["Range end", 10]] as const) {
      const edge = screen.getByRole("slider", { name });
      expect(edge.getAttribute("aria-valuemin")).toBe("1");
      expect(edge.getAttribute("aria-valuemax")).toBe(String(session.steps.length));
      expect(edge.getAttribute("aria-valuenow")).toBe(String(position));
      expect(edge.getAttribute("aria-valuetext")).toContain(`step ${position} of ${session.steps.length}`);
    }
    fireEvent.keyDown(slider(), { key: "End" });
    expect(slider().getAttribute("aria-valuenow")).toBe(String(session.steps.length));
    fireEvent.keyDown(slider(), { key: "Home" });
    expect(slider().getAttribute("aria-valuenow")).toBe("1");
  });

  it("holds will-change only while a camera gesture runs", async () => {
    vi.useFakeTimers();
    try {
      const { h } = await renderOverview();
      const lanes = document.querySelector("[data-overview-lanes]");
      const overlay = lanes?.querySelector("canvas")?.nextElementSibling as HTMLElement | null;
      expect(overlay?.style.willChange ?? "").toBe("");
      fireEvent.wheel(lanes as Element, { ctrlKey: true, deltaY: -50, clientX: 400 });
      expect(h.store.get().gesture).toBe("zoom");
      expect(overlay?.style.willChange).toBe("transform");
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
      expect(h.store.get().gesture).toBeNull();
      expect(overlay?.style.willChange ?? "").toBe("");
    } finally {
      vi.useRealTimers();
    }
  });
});
