import {
  clampCamera, panBy as panCamera, TWEEN_MS, tweenCamera, WHEEL_LINE_PX, wheelZoomFactor, zoomAt,
  type Camera, type Point, type Rect, type Size, type ZoomLimits,
} from "../../layout/viewport.js";

export const SETTLE_MS = 150;
export type FramePhase = "gesture" | "tween" | "settle";

export interface ViewportControllerOptions<C extends Camera> {
  /** Receives wheel and pointer input. */
  element: HTMLElement;
  initial: C;
  limits(): ZoomLimits;
  viewport(): Size;
  content(): Rect;
  /** One call per animation frame while the camera changed; the view writes transforms directly. */
  onFrame(camera: C, phase: FramePhase): void;
  onGestureStart?(kind: "pan" | "zoom"): void;
  /** After settle: translation rounded to whole CSS px. */
  onGestureEnd?(camera: C): void;
  /** Hand tool active or Space held. */
  isHandTool(): boolean;
  reducedMotion(): boolean;
  /** Spike risk 3 ruling: round k to a 1/n grid at settle (null = off). */
  settleRoundK?: number | null;
  /** Test seams; default window.requestAnimationFrame / cancelAnimationFrame / setTimeout / clearTimeout. */
  raf?(callback: FrameRequestCallback): number;
  cancelRaf?(handle: number): void;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  /** Internal (C1-7F): false leaves Ctrl/Meta+wheel zoom to another handler; the event is still prevented. */
  wheelZoom?: boolean;
}

export interface ViewportController<C extends Camera> {
  get(): C;
  /**
   * Animated moves take TWEEN_MS (0 under reduced motion); resolves when the camera arrives or is superseded.
   * A gesture in progress (including a drag) settles first, so onGestureEnd reports the camera it left.
   */
  set(camera: C, options?: { animate?: boolean }): Promise<void>;
  zoomBy(factor: number, anchor?: Point): void;
  panBy(dx: number, dy: number): void;
  isGesturing(): boolean;
  destroy(): void;
}

export interface ViewportCore<C extends Camera> extends ViewportController<C> {
  /** Gesture-time camera write: clamps, schedules one frame, re-arms settle. */
  gestureTo(camera: C, kind: "pan" | "zoom"): void;
}

interface Tween<C> { from: C; to: C; start: number | null; duration: number; resolve(): void }

function sameCamera(a: Camera, b: Camera): boolean {
  if (a.mode === "xOnly") return b.mode === "xOnly" && a.k === b.k && a.u0 === b.u0;
  return b.mode === "uniform" && a.k === b.k && a.tx === b.tx && a.ty === b.ty;
}

export function createViewportCore<C extends Camera>(options: ViewportControllerOptions<C>): ViewportCore<C> {
  const raf = options.raf ?? ((cb: FrameRequestCallback) => window.requestAnimationFrame(cb));
  const cancelRaf = options.cancelRaf ?? ((handle: number) => window.cancelAnimationFrame(handle));
  const setTimer = options.setTimer ?? ((cb: () => void, ms: number) => window.setTimeout(cb, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => window.clearTimeout(handle as number));
  const { element } = options;
  const wheelZoom = options.wheelZoom ?? true;

  let camera: C = options.initial;
  let frameHandle: number | null = null;
  let phase: FramePhase = "gesture";
  let gesturing = false;
  let settleHandle: unknown = null;
  let tween: Tween<C> | null = null;
  let drag: { pointerId: number; x: number; y: number } | null = null;
  let destroyed = false;
  /**
   * The element's client origin, measured on the first Ctrl/Meta wheel of a gesture and reused until the gesture
   * settles or the element resizes: a getBoundingClientRect per wheel event forces a synchronous style and layout
   * flush whenever a camera write or a React commit left style dirty (C3-10 review I-2).
   */
  let origin: Point | null = null;
  const Observer = element.ownerDocument.defaultView?.ResizeObserver;
  const resizeObserver =
    typeof Observer === "function"
      ? new Observer(() => {
          origin = null;
        })
      : null;
  resizeObserver?.observe(element);

  const clampToContent = (next: C): C => clampCamera(next, options.content(), options.viewport(), options.limits());

  function schedule(next: FramePhase): void {
    if (destroyed) return;
    phase = next;
    if (frameHandle === null) frameHandle = raf(onAnimationFrame);
  }

  function onAnimationFrame(now: number): void {
    frameHandle = null;
    if (destroyed) return;
    if (tween !== null) {
      const current = tween;
      if (current.start === null) current.start = now;
      const t = current.duration <= 0 ? 1 : (now - current.start) / current.duration;
      camera = tweenCamera(current.from, current.to, t);
      if (t >= 1) tween = null;
      options.onFrame(camera, "tween");
      if (t >= 1) current.resolve();
      else schedule("tween");
      return;
    }
    options.onFrame(camera, phase);
  }

  function supersedeTween(): void {
    if (tween === null) return;
    const current = tween;
    tween = null;
    current.resolve();
  }

  function beginGesture(kind: "pan" | "zoom"): void {
    supersedeTween();
    if (!gesturing) {
      gesturing = true;
      options.onGestureStart?.(kind);
    }
  }

  function armSettle(): void {
    if (settleHandle !== null) clearTimer(settleHandle);
    settleHandle = setTimer(settle, SETTLE_MS);
  }

  function roundCamera(value: C): C {
    const cam = value as Camera;
    if (cam.mode === "xOnly") return { ...cam, u0: Math.round(cam.u0 * cam.k) / cam.k } as C;
    let next = cam;
    const n = options.settleRoundK ?? null;
    if (n !== null && n > 0) {
      const k = Math.round(cam.k * n) / n;
      if (k > 0 && k !== cam.k) {
        const v = options.viewport();
        next = zoomAt(cam, { x: v.w / 2, y: v.h / 2 }, k / cam.k, { minK: k, maxK: k });
      }
    }
    return { ...next, tx: Math.round(next.tx), ty: Math.round(next.ty) } as C;
  }

  function settle(): void {
    settleHandle = null;
    if (destroyed || drag !== null) return;
    if (frameHandle !== null) {
      cancelRaf(frameHandle);
      frameHandle = null;
    }
    camera = roundCamera(camera);
    gesturing = false;
    origin = null;
    options.onFrame(camera, "settle");
    options.onGestureEnd?.(camera);
  }

  function releaseCapture(pointerId: number): void {
    if (typeof element.releasePointerCapture !== "function") return;
    try {
      element.releasePointerCapture(pointerId);
    } catch {
      // Capture was never taken (synthetic events).
    }
  }

  /**
   * A programmatic move settles the gesture in progress first, with the camera the gesture left, so a
   * settle never cancels the tween's frames or reports a tween's camera as a gesture end (spec §7.8 rule 2).
   */
  function finishGesture(): void {
    if (drag !== null) {
      releaseCapture(drag.pointerId);
      drag = null;
    }
    if (settleHandle !== null) {
      clearTimer(settleHandle);
      settleHandle = null;
    }
    origin = null;
    if (gesturing) settle();
  }

  function gestureTo(next: C, kind: "pan" | "zoom"): void {
    if (destroyed) return;
    beginGesture(kind);
    camera = clampToContent(next);
    schedule("gesture");
    armSettle();
  }

  /** Wheel input that would not move the camera starts no gesture, so it never leaves Live. */
  function wheelTo(next: C, kind: "pan" | "zoom"): void {
    if (sameCamera(clampToContent(next), camera)) {
      // A no-op at a zoom limit starts no gesture, so the rect measured for it must not outlive it.
      if (!gesturing) origin = null;
      return;
    }
    gestureTo(next, kind);
  }

  function localPoint(clientX: number, clientY: number): Point {
    if (origin === null) {
      const rect = element.getBoundingClientRect();
      origin = { x: rect.left, y: rect.top };
    }
    return { x: clientX - origin.x, y: clientY - origin.y };
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    if (destroyed) return;
    const viewport = options.viewport();
    if (event.ctrlKey || event.metaKey) {
      if (!wheelZoom) return;
      const factor = wheelZoomFactor(event.deltaY, event.deltaMode as 0 | 1 | 2, viewport.h);
      wheelTo(zoomAt(camera, localPoint(event.clientX, event.clientY), factor, options.limits()), "zoom");
      return;
    }
    const scale = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? viewport.h : 1;
    let dx = event.deltaX * scale;
    let dy = event.deltaY * scale;
    // An xOnly camera has no y, so a plain (vertical) mouse wheel pans x by the dominant axis (spec §7.6.2).
    if ((camera as Camera).mode === "xOnly" || (event.shiftKey && dx === 0)) {
      if (Math.abs(dy) > Math.abs(dx)) dx = dy;
      dy = 0;
    }
    wheelTo(panCamera(camera, -dx, -dy), "pan");
  }

  function onPointerDown(event: PointerEvent): void {
    const pans = event.button === 1 || (event.button === 0 && options.isHandTool());
    if (!pans || destroyed) return;
    event.preventDefault();
    beginGesture("pan");
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    if (settleHandle !== null) {
      clearTimer(settleHandle);
      settleHandle = null;
    }
    if (typeof element.setPointerCapture === "function") {
      try {
        element.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic events carry no active pointer; panning still works without capture.
      }
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    camera = clampToContent(panCamera(camera, dx, dy));
    schedule("gesture");
  }

  function onPointerUp(event: PointerEvent): void {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    releaseCapture(event.pointerId);
    drag = null;
    armSettle();
  }

  const wheelOptions: AddEventListenerOptions = { passive: false };
  element.addEventListener("wheel", onWheel, wheelOptions);
  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", onPointerUp);
  element.addEventListener("pointercancel", onPointerUp);

  return {
    get: () => camera,
    set(next, setOptions) {
      supersedeTween();
      if (destroyed) return Promise.resolve();
      finishGesture();
      const animate = setOptions?.animate === true && !options.reducedMotion();
      return new Promise<void>((resolve) => {
        tween = { from: camera, to: next, start: null, duration: animate ? TWEEN_MS : 0, resolve };
        schedule("tween");
      });
    },
    zoomBy(factor, anchor) {
      const v = options.viewport();
      gestureTo(zoomAt(camera, anchor ?? { x: v.w / 2, y: v.h / 2 }, factor, options.limits()), "zoom");
    },
    panBy(dx, dy) {
      gestureTo(panCamera(camera, dx, dy), "pan");
    },
    isGesturing: () => gesturing || drag !== null,
    gestureTo,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      element.removeEventListener("wheel", onWheel, wheelOptions);
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", onPointerUp);
      element.removeEventListener("pointercancel", onPointerUp);
      resizeObserver?.disconnect();
      if (frameHandle !== null) cancelRaf(frameHandle);
      frameHandle = null;
      if (settleHandle !== null) clearTimer(settleHandle);
      settleHandle = null;
      supersedeTween();
    },
  };
}

export function createViewportController<C extends Camera>(options: ViewportControllerOptions<C>): ViewportController<C> {
  return createViewportCore(options);
}
