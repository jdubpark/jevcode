// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { UniformCamera, XOnlyCamera } from "../../layout/viewport.js";
import { createViewportController, SETTLE_MS, type FramePhase, type ViewportController } from "./controller.js";

interface Harness {
  element: HTMLDivElement;
  onFrame: Mock<(camera: UniformCamera, phase: FramePhase) => void>;
  onGestureEnd: Mock<(camera: UniformCamera) => void>;
  onGestureStart: Mock<(kind: "pan" | "zoom") => void>;
  flush(dt?: number): void;
  controller: ViewportController<UniformCamera>;
  state: { hand: boolean; reduced: boolean };
}

function setup(options: { settleRoundK?: number } = {}): Harness {
  const element = document.createElement("div");
  document.body.append(element);
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON: () => ({}),
  } as DOMRect);
  const queue: FrameRequestCallback[] = [];
  let now = 0;
  const state = { hand: false, reduced: false };
  const onFrame = vi.fn<(camera: UniformCamera, phase: FramePhase) => void>();
  const onGestureEnd = vi.fn<(camera: UniformCamera) => void>();
  const onGestureStart = vi.fn<(kind: "pan" | "zoom") => void>();
  const controller = createViewportController<UniformCamera>({
    element,
    initial: { mode: "uniform", tx: 0, ty: 0, k: 1 },
    limits: () => ({ minK: 0.1, maxK: 4 }),
    viewport: () => ({ w: 800, h: 600 }),
    content: () => ({ x: 0, y: 0, w: 2_000, h: 1_500 }),
    onFrame,
    onGestureStart,
    onGestureEnd,
    isHandTool: () => state.hand,
    reducedMotion: () => state.reduced,
    settleRoundK: options.settleRoundK ?? null,
    raf: (cb) => { queue.push(cb); return queue.length; },
    cancelRaf: () => { queue.length = 0; },
    setTimer: (cb, ms) => setTimeout(cb, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  const flush = (dt = 16): void => {
    now += dt;
    for (const cb of queue.splice(0)) cb(now);
  };
  return { element, onFrame, onGestureEnd, onGestureStart, flush, controller, state };
}

function wheel(element: HTMLElement, init: WheelEventInit): WheelEvent {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  element.dispatchEvent(event);
  return event;
}

function pointer(element: HTMLElement, type: string, init: MouseEventInit & { pointerId?: number }): void {
  const Ctor = (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
  element.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, ...init }));
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("viewport controller", () => {
  it("a Ctrl+wheel is prevented and zooms at the cursor, written once per frame", () => {
    const h = setup();
    const event = wheel(h.element, { deltaY: -10, ctrlKey: true, clientX: 200, clientY: 100 });
    expect(event.defaultPrevented).toBe(true);
    expect(h.onFrame).not.toHaveBeenCalled();
    h.flush();
    expect(h.onFrame).toHaveBeenCalledTimes(1);
    const [camera, phase] = h.onFrame.mock.calls[0] ?? [];
    expect(phase).toBe("gesture");
    expect(camera?.k).toBeCloseTo(2 ** 0.2, 12);
    expect(camera?.tx).toBeCloseTo(200 - 200 * 2 ** 0.2, 9);
    expect(h.onGestureStart).toHaveBeenCalledWith("zoom");
  });

  it("a Meta+wheel (trackpad pinch on macOS) also zooms", () => {
    const h = setup();
    wheel(h.element, { deltaY: 5, metaKey: true, clientX: 0, clientY: 0 });
    h.flush();
    expect(h.controller.get().k).toBeCloseTo(2 ** -0.1, 12);
  });

  it("a plain wheel pans and keeps k", () => {
    const h = setup();
    wheel(h.element, { deltaX: 12, deltaY: 30 });
    h.flush();
    expect(h.controller.get()).toEqual({ mode: "uniform", tx: -12, ty: -30, k: 1 });
    expect(h.onGestureStart).toHaveBeenCalledWith("pan");
  });

  it("line-mode wheel pans 16 px per line", () => {
    const h = setup();
    wheel(h.element, { deltaY: 2, deltaMode: 1 });
    h.flush();
    expect(h.controller.get().ty).toBe(-32);
  });

  it("two wheel events in one frame produce one onFrame", () => {
    const h = setup();
    wheel(h.element, { deltaY: 10 });
    wheel(h.element, { deltaY: 10 });
    h.flush();
    expect(h.onFrame).toHaveBeenCalledTimes(1);
    expect(h.controller.get().ty).toBe(-20);
  });

  it("settle fires once 150 ms after the last input with whole-pixel translation", () => {
    const h = setup();
    wheel(h.element, { deltaY: 10.4 });
    h.flush();
    vi.advanceTimersByTime(100);
    wheel(h.element, { deltaY: 0.3 });
    h.flush();
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(h.onGestureEnd).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.onGestureEnd).toHaveBeenCalledTimes(1);
    expect(h.onGestureEnd.mock.calls[0]?.[0]).toEqual({ mode: "uniform", tx: 0, ty: -11, k: 1 });
    expect(h.onFrame.mock.calls.at(-1)?.[1]).toBe("settle");
    expect(h.controller.isGesturing()).toBe(false);
  });

  it("settle rounds k to a 1/n grid when settleRoundK is set", () => {
    const h = setup({ settleRoundK: 64 });
    wheel(h.element, { deltaY: -7, ctrlKey: true, clientX: 300, clientY: 200 });
    h.flush();
    vi.advanceTimersByTime(SETTLE_MS);
    const k = h.controller.get().k;
    expect(Number.isInteger(k * 64)).toBe(true);
  });

  it("an animated set under reduced motion arrives in one frame", async () => {
    const h = setup();
    h.state.reduced = true;
    const target: UniformCamera = { mode: "uniform", tx: 100, ty: 50, k: 2 };
    const done = h.controller.set(target, { animate: true });
    h.flush();
    await done;
    expect(h.onFrame).toHaveBeenLastCalledWith(target, "tween");
  });

  it("an animated set takes TWEEN_MS and a newer set supersedes it", async () => {
    const h = setup();
    const first = h.controller.set({ mode: "uniform", tx: 100, ty: 0, k: 1 }, { animate: true });
    h.flush(16);
    h.flush(16);
    expect(h.controller.get().tx).toBeGreaterThan(0);
    expect(h.controller.get().tx).toBeLessThan(100);
    const second = h.controller.set({ mode: "uniform", tx: -50, ty: 0, k: 1 });
    await first;
    h.flush();
    await second;
    expect(h.controller.get().tx).toBe(-50);
  });

  it("a set inside the settle window ends the gesture at the panned camera, then tweens to the end", async () => {
    const h = setup();
    wheel(h.element, { deltaY: 10.4 });
    h.flush();
    vi.advanceTimersByTime(50);
    let arrived = false;
    const target: UniformCamera = { mode: "uniform", tx: 300, ty: 0, k: 1 };
    void h.controller.set(target, { animate: true }).then(() => { arrived = true; });
    // The gesture ends before the tween starts, with the camera the wheel left (rounded), never a tween camera.
    expect(h.onGestureEnd).toHaveBeenCalledTimes(1);
    expect(h.onGestureEnd.mock.calls[0]?.[0]).toEqual({ mode: "uniform", tx: 0, ty: -10, k: 1 });
    expect(h.controller.isGesturing()).toBe(false);
    for (let i = 0; i < 20; i += 1) {
      h.flush(16);
      vi.advanceTimersByTime(16);
    }
    await Promise.resolve();
    expect(h.onGestureEnd).toHaveBeenCalledTimes(1);
    expect(h.controller.get()).toEqual(target);
    expect(arrived).toBe(true);
    expect(h.onFrame.mock.calls.at(-1)).toEqual([target, "tween"]);
  });

  it("a set during a drag ends the drag; later moves of that pointer do not pan", async () => {
    const h = setup();
    h.state.hand = true;
    pointer(h.element, "pointerdown", { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    pointer(h.element, "pointermove", { clientX: 30, clientY: 10, pointerId: 1 });
    h.flush();
    const done = h.controller.set({ mode: "uniform", tx: -100, ty: 0, k: 1 });
    expect(h.onGestureEnd.mock.calls[0]?.[0]).toEqual({ mode: "uniform", tx: 20, ty: 0, k: 1 });
    pointer(h.element, "pointermove", { clientX: 90, clientY: 10, pointerId: 1 });
    h.flush();
    await done;
    pointer(h.element, "pointerup", { clientX: 90, clientY: 10, pointerId: 1 });
    vi.advanceTimersByTime(SETTLE_MS);
    expect(h.controller.get().tx).toBe(-100);
    expect(h.onGestureEnd).toHaveBeenCalledTimes(1);
    expect(h.controller.isGesturing()).toBe(false);
  });

  it("the hand tool drags to pan; middle drag pans without it", () => {
    const h = setup();
    pointer(h.element, "pointerdown", { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    pointer(h.element, "pointermove", { clientX: 30, clientY: 40, pointerId: 1 });
    h.flush();
    expect(h.controller.get().tx).toBe(0);
    h.state.hand = true;
    pointer(h.element, "pointerdown", { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    pointer(h.element, "pointermove", { clientX: 30, clientY: 40, pointerId: 1 });
    pointer(h.element, "pointerup", { clientX: 30, clientY: 40, pointerId: 1 });
    h.flush();
    expect(h.controller.get()).toMatchObject({ tx: 20, ty: 30 });
    h.state.hand = false;
    pointer(h.element, "pointerdown", { button: 1, clientX: 0, clientY: 0, pointerId: 2 });
    pointer(h.element, "pointermove", { clientX: -5, clientY: 0, pointerId: 2 });
    h.flush();
    expect(h.controller.get().tx).toBe(15);
  });

  it("measures the element once per zoom gesture, again after settle and after a resize (C3-10 review I-2)", () => {
    const observers: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          observers.push(callback);
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    const h = setup();
    const measure = vi.mocked(h.element.getBoundingClientRect);
    measure.mockClear();
    for (let i = 0; i < 5; i += 1) {
      wheel(h.element, { deltaY: -10, ctrlKey: true, clientX: 400, clientY: 300 });
      h.flush();
    }
    expect(measure).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SETTLE_MS);
    wheel(h.element, { deltaY: -10, ctrlKey: true, clientX: 400, clientY: 300 });
    expect(measure).toHaveBeenCalledTimes(2);
    for (const callback of observers) callback([], {} as ResizeObserver);
    wheel(h.element, { deltaY: -10, ctrlKey: true, clientX: 400, clientY: 300 });
    expect(measure).toHaveBeenCalledTimes(3);
  });

  it("destroy removes the wheel listener and stops frames", () => {
    const h = setup();
    const remove = vi.spyOn(h.element, "removeEventListener");
    h.controller.destroy();
    expect(remove.mock.calls.some(([type]) => type === "wheel")).toBe(true);
    wheel(h.element, { deltaY: 10 });
    h.flush();
    expect(h.onFrame).not.toHaveBeenCalled();
  });
});

describe("viewport controller on an xOnly (overview) camera", () => {
  function setupXOnly(initial: XOnlyCamera) {
    const element = document.createElement("div");
    document.body.append(element);
    const queue: FrameRequestCallback[] = [];
    const onGestureStart = vi.fn<(kind: "pan" | "zoom") => void>();
    const onFrame = vi.fn<(camera: XOnlyCamera, phase: FramePhase) => void>();
    const controller = createViewportController<XOnlyCamera>({
      element,
      initial,
      limits: () => ({ minK: 0.01, maxK: 0.4 }),
      viewport: () => ({ w: 800, h: 120 }),
      content: () => ({ x: 0, y: 0, w: 100_000, h: 0 }),
      onFrame,
      onGestureStart,
      isHandTool: () => false,
      reducedMotion: () => false,
      raf: (cb) => { queue.push(cb); return queue.length; },
      cancelRaf: () => { queue.length = 0; },
      setTimer: (cb, ms) => setTimeout(cb, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    const flush = (): void => { for (const cb of queue.splice(0)) cb(16); };
    return { element, controller, onGestureStart, onFrame, flush };
  }

  it("a plain vertical wheel pans x (spec §7.6.2)", () => {
    const h = setupXOnly({ mode: "xOnly", u0: 1_000, k: 0.1 });
    const event = wheel(h.element, { deltaY: 100 });
    h.flush();
    expect(event.defaultPrevented).toBe(true);
    expect(h.controller.get()).toEqual({ mode: "xOnly", u0: 2_000, k: 0.1 });
    expect(h.onGestureStart).toHaveBeenCalledWith("pan");
    wheel(h.element, { deltaX: -30, deltaY: 10 });
    h.flush();
    expect(h.controller.get().u0).toBeCloseTo(1_700, 9);
  });

  it("a wheel that cannot move the camera starts no gesture", () => {
    // u0 = −CLAMP_PAD_PX / k is the left clamp edge.
    const h = setupXOnly({ mode: "xOnly", u0: -240, k: 0.1 });
    const event = wheel(h.element, { deltaY: -50 });
    wheel(h.element, { deltaX: 0, deltaY: 0 });
    h.flush();
    expect(event.defaultPrevented).toBe(true);
    expect(h.onGestureStart).not.toHaveBeenCalled();
    expect(h.onFrame).not.toHaveBeenCalled();
    expect(h.controller.isGesturing()).toBe(false);
  });
});
