// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { layoutOverview, MAX_OVERLAY_NODES } from "../../../../layout/overview-layout.js";
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
import { pinLabel } from "./Pins.js";

let layout: LayoutStub;
beforeEach(() => {
  layout = stubLayout({ width: 1400, height: 600 });
});
let activeFrames: FrameQueue | null = null;
afterEach(() => {
  activeFrames?.restore();
  activeFrames = null;
  cleanup();
  layout.restore();
});

type FrameQueue = { flush(): void; pending(): number; restore(): void };

/** Replaces the document window's rAF with a manual queue so tests decide when a frame runs. */
function installFrames(): FrameQueue {
  const view = document.defaultView as Window & typeof globalThis;
  const original = { raf: view.requestAnimationFrame, caf: view.cancelAnimationFrame };
  let next = 1;
  const queue = new Map<number, FrameRequestCallback>();
  view.requestAnimationFrame = (callback) => {
    const id = next;
    next += 1;
    queue.set(id, callback);
    return id;
  };
  view.cancelAnimationFrame = (id) => {
    queue.delete(id);
  };
  const queueApi: FrameQueue = {
    flush: () => {
      const callbacks = [...queue.values()];
      queue.clear();
      act(() => {
        for (const callback of callbacks) callback(0);
      });
    },
    pending: () => queue.size,
    restore: () => {
      view.requestAnimationFrame = original.raf;
      view.cancelAnimationFrame = original.caf;
    },
  };
  activeFrames = queueApi;
  return queueApi;
}

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

  it("restores the pre-gesture brush when a drag is cancelled", async () => {
    const frames = installFrames();
    const { h } = await renderOverview();
    const before = h.store.get().brush;
    const track = screen.getByTestId("overview-track");
    fireEvent.pointerDown(track, { clientX: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 300, pointerId: 1 });
    frames.flush();
    expect(h.store.get().brush).not.toEqual(before);
    expect(h.store.get().gesture).toBe("brush");
    fireEvent.pointerCancel(track, { clientX: 700, pointerId: 1 });
    expect(h.store.get().gesture).toBeNull();
    expect(h.store.get().brush).toEqual(before);
    fireEvent.pointerMove(track, { clientX: 900, pointerId: 1 });
    frames.flush();
    expect(h.store.get().brush).toEqual(before);
  });

  it("restores the pre-gesture playhead when a scrub loses capture", async () => {
    const frames = installFrames();
    await renderOverview();
    const now = (): string | null => slider().getAttribute("aria-valuenow");
    const before = now();
    const handle = slider();
    fireEvent.pointerDown(handle, { clientX: 200, button: 0, pointerId: 2 });
    fireEvent.pointerMove(handle, { clientX: 900, pointerId: 2 });
    frames.flush();
    expect(now()).not.toBe(before);
    fireEvent(handle, new Event("lostpointercapture"));
    expect(now()).toBe(before);
  });

  it("writes at most once per animation frame and commits the last position on pointerup", async () => {
    const frames = installFrames();
    const { h } = await renderOverview();
    let writes = 0;
    let last = h.store.get().brush;
    h.store.subscribe(() => {
      const now = h.store.get().brush;
      if (now !== last) {
        last = now;
        writes += 1;
      }
    });
    const track = screen.getByTestId("overview-track");
    fireEvent.pointerDown(track, { clientX: 100, button: 0, pointerId: 1 });
    for (const x of [200, 300, 400, 500]) fireEvent.pointerMove(track, { clientX: x, pointerId: 1 });
    expect(writes).toBe(0);
    expect(frames.pending()).toBe(1);
    frames.flush();
    expect(writes).toBe(1);
    fireEvent.pointerMove(track, { clientX: 600, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 800, pointerId: 1 });
    expect(frames.pending()).toBe(0);
    const brush = h.store.get().brush;
    expect(brush.kind).toBe("range");
    // The pointerup position (800) wins over the unflushed 600.
    fireEvent.pointerDown(track, { clientX: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 800, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 800, pointerId: 1 });
    expect(h.store.get().brush).toEqual(brush);
  });

  it("stops a body drag at either session end and keeps the range width in steps", async () => {
    const session = foldFixture("oauth");
    const { h } = await renderOverview();
    const from = 4;
    const to = 9;
    const seqOf = (position: number): number => session.steps[position]?.firstSeq ?? 0;
    act(() =>
      h.store.dispatch({ type: "brush/set", brush: { kind: "range", fromSeq: seqOf(from), toSeq: seqOf(to) }, by: "hybrid" }),
    );
    const body = (): HTMLElement => screen.getByTestId("overview-brush-body");
    const width = to - from;
    const last = session.steps.length - 1;

    fireEvent.pointerDown(body(), { clientX: 400, button: 0, pointerId: 3 });
    fireEvent.pointerMove(body(), { clientX: 9000, pointerId: 3 });
    fireEvent.pointerUp(body(), { clientX: 9000, pointerId: 3 });
    expect(h.store.get().brush).toEqual({ kind: "range", fromSeq: seqOf(last - width), toSeq: seqOf(last) });

    fireEvent.pointerDown(body(), { clientX: 400, button: 0, pointerId: 3 });
    fireEvent.pointerMove(body(), { clientX: -9000, pointerId: 3 });
    fireEvent.pointerUp(body(), { clientX: -9000, pointerId: 3 });
    expect(h.store.get().brush).toEqual({ kind: "range", fromSeq: seqOf(0), toSeq: seqOf(width) });

    // Already at the start: pushing further left keeps the width.
    fireEvent.pointerDown(body(), { clientX: 400, button: 0, pointerId: 3 });
    fireEvent.pointerMove(body(), { clientX: -9000, pointerId: 3 });
    fireEvent.pointerUp(body(), { clientX: -9000, pointerId: 3 });
    expect(h.store.get().brush).toEqual({ kind: "range", fromSeq: seqOf(0), toSeq: seqOf(width) });

    // Already at the end: pushing further right keeps the width.
    act(() =>
      h.store.dispatch({
        type: "brush/set",
        brush: { kind: "range", fromSeq: seqOf(last - width), toSeq: seqOf(last) },
        by: "hybrid",
      }),
    );
    fireEvent.pointerDown(body(), { clientX: 400, button: 0, pointerId: 3 });
    fireEvent.pointerMove(body(), { clientX: 9000, pointerId: 3 });
    fireEvent.pointerUp(body(), { clientX: 9000, pointerId: 3 });
    expect(h.store.get().brush).toEqual({ kind: "range", fromSeq: seqOf(last - width), toSeq: seqOf(last) });
  });

  it("keeps a session-level snapped end inside a band whose last step is long", async () => {
    const session = foldFixture("oauth");
    const { h, apiRef } = await renderOverview();
    act(() => h.store.dispatch({ type: "level/set", level: "session", by: "hybrid" }));
    await act(async () => undefined);
    const api = apiRef.current;
    if (api === null) throw new Error("no api");
    const bands = layoutOverview({
      overview: api.overview() as NonNullable<ReturnType<OverviewApi["overview"]>>,
      camera: api.camera() as NonNullable<ReturnType<OverviewApi["camera"]>>,
      widthPx: api.widthPx(),
      level: "session",
    }).bands;
    const band = bands.find((item) => item.key === "ch:37");
    if (band === undefined) throw new Error("oauth fixture lost its ch:37 band");
    const track = screen.getByTestId("overview-track");
    fireEvent.pointerDown(track, { clientX: band.x0 + 0.5, button: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: band.x1 - 0.5, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: band.x1 - 0.5, pointerId: 1 });
    const brush = h.store.get().brush;
    // The band ends inside the 5 s step at +25 s (seq 37); the next step starts at +31 s (seq 40) and is nearer
    // to the band end than the long step's own start, so a "nearest" lookup used to spill into it.
    const longStep = session.steps.find((step) => step.firstSeq === 37);
    expect(longStep?.durationMs).toBe(5000);
    expect(brush).toEqual({ kind: "range", fromSeq: 35, toSeq: 37 });
  });

  it("labels a decision pin with its kind, not the agent-written decision title", () => {
    const session = foldFixture("oauth");
    const position = session.steps.findIndex(
      (step) => step.kind === "decision" && step.decision !== undefined && step.findingIds.length === 0,
    );
    expect(position).toBeGreaterThanOrEqual(0);
    const title = session.steps[position]?.decision?.title ?? "";
    const label = pinLabel({ cluster: false, stepIndexes: [position] } as unknown as Parameters<typeof pinLabel>[0], session);
    expect(title.length).toBeGreaterThan(0);
    expect(label).not.toContain(title);
    expect(label).toContain("Decision");
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
    const frames = installFrames();
    const { h } = await renderOverview();
    const handle = slider();
    fireEvent.pointerDown(handle, { clientX: 200, button: 0, pointerId: 2 });
    fireEvent.pointerMove(handle, { clientX: 600, pointerId: 2 });
    expect(h.store.get().gesture).toBe("playhead");
    frames.flush();
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
