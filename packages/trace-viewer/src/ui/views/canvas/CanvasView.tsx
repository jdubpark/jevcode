import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type React from "react";

import { layoutCanvas, type CanvasFrame, type CanvasLayout } from "../../../layout/canvas-layout.js";
import type { CanvasEdge } from "../../../layout/canvas-routes.js";
import type { TimeScale } from "../../../layout/time-scale.js";
import { worstSeverity } from "../../../layout/tone.js";
import type { SelectionId, TraceIndex } from "../../../layout/trace-index.js";
import { screenToWorld, setCenter, worldToScreen, type Point, type Size, type UniformCamera } from "../../../layout/viewport.js";
import type { Level, TraceSession } from "../../../model/index.js";
import { markAfterPaint, PERF } from "../../shell/perf.js";
import { useDiagnostics, useSessionView } from "../../shell/session-context.js";
import { useView, useViewStore } from "../../state/store.js";
import { selectEffectivePlayheadSeq, selectNewCount, type Tool } from "../../state/view-state.js";
import { createViewportController, type FramePhase, type ViewportController } from "../../viewport/controller.js";
import { useRegisterViewPort, useViewPortRegistry, type ViewProps } from "../view-port.js";
import {
  DEFAULT_CAMERA,
  brushForWindow,
  createCameraStore,
  focusFrame,
  framesAhead,
  frontierFollowCamera,
  intersectsViewport,
  levelLimits,
  nearestFrameToCenter,
  pinFrameCamera,
  planFit,
  revealCamera,
  showCamera,
  zoomToSelection,
} from "./canvas-camera.js";
import { canvasReadingOrder, createCanvasPort, frameForSelection, tailFrame } from "./canvas-port.js";
import { CanvasRuler } from "./CanvasRuler.js";
import styles from "./CanvasView.module.css";
import { buildFrameContext, frameEnd, frameRunning, frameStart, frameSteps, zoomBand } from "./frame-label.js";
import { Minimap } from "./Minimap.js";
import { Overlay } from "./Overlay.js";
import { CANVAS_SETTLE_ROUND_K, CULL_FRAMES, INV_K_EVERY_FRAME } from "./spike-rulings.js";
import { Toolbar } from "./Toolbar.js";
import { World, focusFrameElement, type CullRange } from "./World.js";

interface Latest {
  layout: CanvasLayout | null;
  session: TraceSession | null;
  index: TraceIndex;
  scale: TimeScale;
  level: Level;
  active: boolean;
}

type DomView = Window & typeof globalThis;

function domView(element: Element | null): DomView | null {
  return element?.ownerDocument.defaultView ?? null;
}

function prefersReducedMotion(element: Element | null): boolean {
  const view = domView(element);
  return view !== null && typeof view.matchMedia === "function" && view.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Relayout animation length (CSS --tv-dur is 180 ms; the attribute outlives it by a frame or two). */
const RELAYOUT_MS = 250;

interface StickyEntry {
  layout: CanvasLayout;
  key: string;
  sessionId: string;
  level: Level;
  tidyRev: number;
}

/**
 * layoutCanvas chained through the last committed layout, so a placed frame never moves (spec §7.5). The layout reruns
 * only when loadedThroughSeq (or Live, level, session or Tidy) changes: the live scale grows with the clock every tick,
 * and a rerun per tick would cost a fresh placement pass for nothing. `prev` is passed only for the same level, session
 * and Tidy generation; a level switch or Tidy lays out fresh (lane deviation 19).
 */
function useStickyLayout(
  session: TraceSession | null,
  index: TraceIndex,
  scale: TimeScale,
  level: Level,
  tidyRev: number,
): CanvasLayout | null {
  const committed = useRef<StickyEntry | null>(null);
  const sessionId = session?.meta.sessionId ?? null;
  const key = session === null ? null : `${session.loadedThroughSeq}|${session.live ? 1 : 0}|${session.steps.length}`;
  const latest = useRef({ session, index, scale });
  latest.current = { session, index, scale };
  const layout = useMemo(() => {
    const { session: current, index: currentIndex, scale: currentScale } = latest.current;
    if (current === null || key === null || sessionId === null) return null;
    const prev = committed.current;
    const same = prev !== null && prev.sessionId === sessionId && prev.level === level && prev.tidyRev === tidyRev;
    if (same && prev.key === key) return prev.layout;
    return layoutCanvas(current, currentIndex, currentScale, level, same ? prev.layout : undefined);
  }, [key, sessionId, level, tidyRev]);
  useLayoutEffect(() => {
    if (layout !== null && key !== null && sessionId !== null) committed.current = { layout, key, sessionId, level, tidyRev };
  }, [layout, key, sessionId, level, tidyRev]);
  return layout;
}

/** Frames animate for --tv-dur after a level switch or Tidy; the pinned focus frame does not. */
function markRelayout(viewport: HTMLElement | null, pinnedKey: string): void {
  const view = domView(viewport);
  if (viewport === null || view === null) return;
  viewport.setAttribute("data-relayout", "");
  const pinned = [...viewport.querySelectorAll<HTMLElement>('[role="group"][data-key]')].find((element) => element.dataset.key === pinnedKey);
  pinned?.setAttribute("data-pinned", "");
  view.setTimeout(() => {
    viewport.removeAttribute("data-relayout");
    pinned?.removeAttribute("data-pinned");
  }, RELAYOUT_MS);
}

/** A cull range no frame overlaps. */
const NOTHING: CullRange = { x0: Infinity, x1: -Infinity };

/** Spike risk 2 ruling: the mounted range spans one viewport width either side of the view at the mounted camera. */
function mountedRange(camera: UniformCamera, width: number): CullRange {
  return { x0: screenToWorld(camera, { x: -width, y: 0 }).x, x1: screenToWorld(camera, { x: 2 * width, y: 0 }).x };
}

/**
 * True while the live camera's view stays half a viewport width (at the mounted zoom) inside the mounted range. A pan
 * of half a width, or a zoom out past 2×, leaves it (C3-10 review M2).
 */
function mountCovers(mounted: UniformCamera, live: UniformCamera, width: number): boolean {
  const range = mountedRange(mounted, width);
  const slack = width / (2 * mounted.k);
  const x0 = screenToWorld(live, { x: 0, y: 0 }).x;
  const x1 = screenToWorld(live, { x: width, y: 0 }).x;
  return x0 >= range.x0 + slack && x1 <= range.x1 - slack;
}

/** At most one mounted-range update per this many ms during a long pan or zoom (C3-10 review M2). */
const MOUNT_THROTTLE_MS = 100;

/** The dot grid's cell at k = 1 (World.module.css `.viewport`). */
const GRID_PX = 20;

/** Stage width under which the toolbar leaves the center (toolbar ≈ 310 px, minimap 152 px + 16 px margins). */
const NARROW_PX = 680;

/** A frame's screen point (its card's top-left) under a camera. */
function screenPoint(camera: UniformCamera, frame: CanvasFrame): Point {
  return worldToScreen(camera, { x: frame.card.x, y: frame.card.y });
}

export function CanvasView({ active }: ViewProps): React.JSX.Element {
  const view = useSessionView();
  const store = useViewStore();
  const registry = useViewPortRegistry();
  const diagnostics = useDiagnostics();
  const level = useView((state) => state.level);
  const selection = useView((state) => state.selection);
  const expanded = useView((state) => state.expanded);
  const tool = useView((state) => state.tool);
  const follow = useView((state) => state.follow);
  const newCount = useView((state) => selectNewCount(state, view.index));
  const playheadSeq = useView((state) => selectEffectivePlayheadSeq(state, view.index));
  const [tidyRev, setTidyRev] = useState(0);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  const [settled, setSettled] = useState<UniformCamera | null>(null);
  /** The camera the cull range and the ruler are laid out for: each settle, and a long pan or zoom (throttled). */
  const [mounted, setMounted] = useState<UniformCamera | null>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const { session, index, scale } = view;
  const layout = useStickyLayout(session, index, scale, level, tidyRev);
  const ctx = useMemo(() => (session === null ? null : buildFrameContext(session)), [session]);
  const cameraStore = useMemo(() => createCameraStore(DEFAULT_CAMERA), []);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef<UniformCamera | null>(null);
  const mountTimerRef = useRef<number | null>(null);
  /** A programmatic move (moveTo) is in flight: its camera does not agree with focus yet. */
  const movingRef = useRef(false);
  const controllerRef = useRef<ViewportController<UniformCamera> | null>(null);
  const sizeRef = useRef<Size>({ w: 0, h: 0 });
  const latest = useRef<Latest>({ layout, session, index, scale, level, active });
  const prevLayoutRef = useRef<CanvasLayout | null>(null);
  const lastSelectionRef = useRef<SelectionId | null>(selection);
  const pendingShowRef = useRef(false);
  const pendingFitRef = useRef(false);
  const relayoutRef = useRef(false);
  const userGestureRef = useRef(false);
  const syncedRevRef = useRef(-1);
  const moveTokenRef = useRef(0);
  /** A reveal asked through the port (j/k, n/N): queued to the next commit so it resolves against the new selection. */
  const pendingRevealRef = useRef<{ id: SelectionId; animate: boolean } | null>(null);
  /** Frame key the selection effect revealed in this commit; the queued port reveal of the same frame is dropped. */
  const revealedThisCommitRef = useRef<string | null>(null);
  const wasActiveRef = useRef(active);

  // First layout effect of every commit: callbacks below read the committed values through `latest`.
  useLayoutEffect(() => {
    latest.current = { layout, session, index, scale, level, active };
  });

  const mountAt = useCallback((camera: UniformCamera) => {
    mountedRef.current = camera;
    setMounted(camera);
  }, []);

  /** Long pans and zooms re-mount around the live camera, throttled; a settle always does (sync). */
  const followMount = useCallback(
    function follow(camera: UniformCamera): void {
      const width = sizeRef.current.w;
      const current = mountedRef.current;
      if (!CULL_FRAMES || width <= 0 || current === null || mountTimerRef.current !== null) return;
      if (mountCovers(current, camera, width)) return;
      mountAt(camera);
      const win = domView(viewportRef.current);
      if (win === null) return;
      // Trailing check: the camera may have moved on while the update was held back.
      mountTimerRef.current = win.setTimeout(() => {
        mountTimerRef.current = null;
        follow(cameraStore.get());
      }, MOUNT_THROTTLE_MS);
    },
    [cameraStore, mountAt],
  );

  /**
   * One camera write per animation frame (spec §7.5 "Controller"), all compositor-friendly (C3-10 review I-1): the
   * world layer's transform, the dot grid's background on the viewport (non-inherited), and the three camera variables
   * on the overlay root (--tv-kw, the label width scale, only at settle), whose subtree is the culled labels, handles, chip and badges. Nothing inherited is written
   * above the world, so a frame restyles no card or edge. Spike risk 7 ruling (INV_K_EVERY_FRAME = false): --tv-inv-k
   * re-scales hairlines and junction dots at settle and at a tween's end only. will-change holds only while a gesture
   * or a tween runs.
   */
  const writeCamera = useCallback(
    (camera: UniformCamera, phase: FramePhase) => {
      const world = worldRef.current;
      if (world !== null) {
        world.style.transform = `translate(${camera.tx}px, ${camera.ty}px) scale(${camera.k})`;
        const moving = phase !== "settle";
        if (INV_K_EVERY_FRAME || !moving) world.style.setProperty("--tv-inv-k", String(1 / camera.k));
        const willChange = moving ? "transform" : "";
        if (world.style.willChange !== willChange) world.style.willChange = willChange;
      }
      const viewport = viewportRef.current;
      if (viewport !== null) {
        viewport.style.backgroundPosition = `${camera.tx}px ${camera.ty}px`;
        viewport.style.backgroundSize = `${GRID_PX * camera.k}px ${GRID_PX * camera.k}px`;
        const band = zoomBand(camera.k);
        if (viewport.dataset.zoomBand !== band) viewport.dataset.zoomBand = band;
      }
      const overlay = overlayRef.current;
      if (overlay !== null) {
        overlay.style.setProperty("--tv-tx", `${camera.tx}px`);
        overlay.style.setProperty("--tv-ty", `${camera.ty}px`);
        overlay.style.setProperty("--tv-k", String(camera.k));
        // Label widths re-lay out, so they follow the camera at rest only (positions are compositor-only).
        if (phase === "settle") overlay.style.setProperty("--tv-kw", String(camera.k));
      }
      cameraStore.set(camera);
      if (phase !== "settle") followMount(camera);
    },
    [cameraStore, followMount],
  );

  /** The overlay mounts with the layout, after the controller's first write: give it the current camera. */
  const setOverlayRoot = useCallback(
    (element: HTMLDivElement | null) => {
      overlayRef.current = element;
      if (element === null) return;
      const camera = cameraStore.get();
      element.style.setProperty("--tv-tx", `${camera.tx}px`);
      element.style.setProperty("--tv-ty", `${camera.ty}px`);
      element.style.setProperty("--tv-k", String(camera.k));
      element.style.setProperty("--tv-kw", String(camera.k));
    },
    [cameraStore],
  );

  /** A tween's end (or a programmatic jump) is a rest: settle writes (--tv-inv-k, no will-change) for its camera. */
  const rest = useCallback(() => {
    const camera = controllerRef.current?.get();
    if (camera !== undefined) writeCamera(camera, "settle");
  }, [writeCamera]);

  /** Stamps the camera as agreeing with focus (spec §7.8 rule 3) and tells the title bar the zoom label may differ. */
  const sync = useCallback(() => {
    const controller = controllerRef.current;
    if (controller === null) return;
    const camera = controller.get();
    syncedRevRef.current = store.get().focusRev;
    store.dispatch({ type: "camera/sync", view: "canvas", camera: { mode: "uniform", tx: camera.tx, ty: camera.ty, k: camera.k } });
    setSettled(camera);
    mountAt(camera);
    registry.notify();
  }, [mountAt, registry, store]);

  const moveTo = useCallback(
    (camera: UniformCamera, animate: boolean) => {
      const controller = controllerRef.current;
      if (controller === null) return;
      const token = (moveTokenRef.current += 1);
      movingRef.current = true;
      void controller.set(camera, { animate: animate && !prefersReducedMotion(viewportRef.current) }).then(() => {
        // A superseded move (a newer one started) or a destroyed controller never stamps the camera.
        if (token !== moveTokenRef.current || controllerRef.current !== controller) return;
        movingRef.current = false;
        rest();
        sync();
      });
    },
    [rest, sync],
  );

  const leaveLive = useCallback(() => {
    if (store.get().follow) store.dispatch({ type: "follow/set", follow: false });
  }, [store]);

  /** lastSeenSeq advances while the tail step's home frame intersects the viewport (spec §7.10). */
  const markSeen = useCallback(() => {
    const { layout: current, session: s, index: idx } = latest.current;
    const controller = controllerRef.current;
    if (current === null || s === null || controller === null) return;
    if (store.get().lastSeenSeq >= idx.loadedThroughSeq) return;
    const tail = tailFrame(current, s);
    if (tail !== undefined && intersectsViewport(controller.get(), tail.card, sizeRef.current)) {
      store.dispatch({ type: "seen", seq: idx.loadedThroughSeq });
    }
  }, [store]);

  /** Show without an exact restore (spec §7.8 rule 3): fit the brush horizontally, keep ty, reveal the selection. */
  const runPendingShow = useCallback(() => {
    if (!pendingShowRef.current) return;
    const { layout: current, session: s, index: idx } = latest.current;
    const controller = controllerRef.current;
    const viewport = sizeRef.current;
    // Never fits a 0 × 0 rect: wait for a ResizeObserver entry with a real size.
    if (controller === null || current === null || s === null || viewport.w <= 0 || viewport.h <= 0) return;
    pendingShowRef.current = false;
    const state = store.get();
    const selected = state.selection === null ? undefined : frameForSelection(current, s, state.selection);
    const target = showCamera({
      layout: current,
      session: s,
      index: idx,
      brush: state.brush,
      camera: controller.get(),
      viewport,
      selectionCard: selected?.card ?? null,
    });
    if (target === null) sync();
    else moveTo(target, true);
  }, [moveTo, store, sync]);

  const fitAll = useCallback(() => {
    const current = latest.current.layout;
    const controller = controllerRef.current;
    if (current === null || controller === null) return;
    const plan = planFit(current, sizeRef.current);
    if (plan === null) return;
    leaveLive();
    if (plan.kind === "switch") {
      pendingFitRef.current = true;
      store.dispatch({ type: "level/set", level: plan.level, by: "canvas" });
      return;
    }
    moveTo(plan.camera, true);
  }, [leaveLive, moveTo, store]);

  const fitSelection = useCallback(() => {
    const { layout: current, session: s } = latest.current;
    const selected = store.get().selection;
    if (current === null || s === null || selected === null) return;
    const frame = frameForSelection(current, s, selected);
    const target = frame === undefined ? null : zoomToSelection(current, frame.key, sizeRef.current);
    if (target === null) return;
    leaveLive();
    moveTo(target, true);
  }, [leaveLive, moveTo, store]);

  /** Zoom keys (spec §7.9): around the selection's card center, else the viewport center. */
  const zoomAround = useCallback(
    (factor: number) => {
      const controller = controllerRef.current;
      const viewport = sizeRef.current;
      if (controller === null || viewport.w <= 0 || viewport.h <= 0) return;
      const { layout: current, session: s } = latest.current;
      const selected = store.get().selection;
      const frame = current === null || s === null || selected === null ? undefined : frameForSelection(current, s, selected);
      const anchor: Point =
        frame === undefined
          ? { x: viewport.w / 2, y: viewport.h / 2 }
          : worldToScreen(controller.get(), { x: frame.card.x + frame.card.w / 2, y: frame.card.y + frame.card.h / 2 });
      leaveLive();
      controller.zoomBy(factor, anchor);
    },
    [leaveLive, store],
  );

  const zoomTo = useCallback(
    (k: number) => {
      const controller = controllerRef.current;
      if (controller !== null) zoomAround(k / controller.get().k);
    },
    [zoomAround],
  );

  /** Reveal (spec §7.5): nothing when the card lies inside the 48 px inset, else center it at the current zoom. */
  const reveal = useCallback(
    (id: SelectionId, animate: boolean): string | null => {
      const { layout: current, session: s } = latest.current;
      const controller = controllerRef.current;
      if (current === null || s === null || controller === null) return null;
      const frame = frameForSelection(current, s, id);
      if (frame === undefined) return null;
      const target = revealCamera(controller.get(), frame.card, sizeRef.current);
      if (target === null) sync();
      else moveTo(target, animate);
      return frame.key;
    },
    [moveTo, sync],
  );

  // Controller lifecycle: only while shown. Under <Activity mode="hidden"> this cleanup runs too, so a hidden canvas
  // holds no wheel or pointer listener, no observer and no animation frame.
  useLayoutEffect(() => {
    const element = viewportRef.current;
    const win = domView(element);
    if (!active || element === null || win === null) return undefined;
    const box = element.getBoundingClientRect();
    sizeRef.current = box.width > 0 && box.height > 0 ? { w: box.width, h: box.height } : { w: 0, h: 0 };
    const state = store.get();
    const saved = state.cameras.canvas;
    const exact = saved !== null && saved.syncedRev === state.focusRev;
    const initial: UniformCamera = saved === null ? cameraStore.get() : { mode: "uniform", tx: saved.tx, ty: saved.ty, k: saved.k };
    pendingShowRef.current = !exact;
    if (exact) syncedRevRef.current = saved.syncedRev;
    lastSelectionRef.current = state.selection;
    writeCamera(initial, "settle");
    mountAt(initial);
    const controller = createViewportController<UniformCamera>({
      element,
      initial,
      limits: () => levelLimits(latest.current.level),
      viewport: () => sizeRef.current,
      content: () => latest.current.layout?.bounds ?? { x: 0, y: 0, w: 0, h: 0 },
      onFrame: (camera, phase) => writeCamera(camera, phase),
      onGestureStart: (kind) => {
        userGestureRef.current = true;
        store.dispatch({ type: "gesture", gesture: kind });
        leaveLive();
      },
      onGestureEnd: (camera) => {
        writeCamera(camera, "settle");
        if (userGestureRef.current) {
          userGestureRef.current = false;
          store.dispatch({ type: "gesture", gesture: null });
          // Only user gestures write the brush (spec §7.8 rule 2): the steps inside the settled window.
          const { layout: current, session: s, scale: sc } = latest.current;
          if (current !== null && s !== null) {
            const brush = brushForWindow({ layout: current, scale: sc, session: s, camera, viewport: sizeRef.current });
            if (brush !== null) store.dispatch({ type: "brush/set", brush, by: "canvas" });
          }
        }
        sync();
        markSeen();
      },
      isHandTool: () => store.get().tool === "hand",
      reducedMotion: () => prefersReducedMotion(element),
      settleRoundK: CANVAS_SETTLE_ROUND_K,
      raf: (callback) => win.requestAnimationFrame(callback),
      cancelRaf: (handle) => win.cancelAnimationFrame(handle),
      setTimer: (callback, ms) => win.setTimeout(callback, ms),
      clearTimer: (handle) => win.clearTimeout(handle as number),
    });
    controllerRef.current = controller;
    const Observer = win.ResizeObserver;
    const observer =
      typeof Observer === "function"
        ? new Observer((entries) => {
            const rect = entries[0]?.contentRect;
            if (rect === undefined || rect.width <= 0 || rect.height <= 0) return; // width 0 under <Activity mode="hidden">
            if (rect.width === sizeRef.current.w && rect.height === sizeRef.current.h && !pendingShowRef.current) return;
            sizeRef.current = { w: rect.width, h: rect.height };
            setSize(sizeRef.current);
            runPendingShow();
          })
        : null;
    observer?.observe(element);
    setSize(sizeRef.current);
    runPendingShow();
    return () => {
      observer?.disconnect();
      if (mountTimerRef.current !== null) win.clearTimeout(mountTimerRef.current);
      mountTimerRef.current = null;
      const camera = controller.get();
      const interrupted = controller.isGesturing() || userGestureRef.current;
      // A show still waiting for a real size, or a programmatic move cut short, never agreed with focus (C3-10 review
      // M4): stamping it would make the next show restore it "exactly" instead of re-fitting.
      const unsettled = pendingShowRef.current || movingRef.current;
      controller.destroy();
      controllerRef.current = null;
      moveTokenRef.current += 1;
      movingRef.current = false;
      // A view hidden or unmounted mid-gesture releases it; the Shell holds data applies while a gesture is set.
      if (interrupted) {
        userGestureRef.current = false;
        store.dispatch({ type: "gesture", gesture: null });
      }
      if (!unsettled) {
        store.dispatch({ type: "camera/sync", view: "canvas", camera: { mode: "uniform", tx: camera.tx, ty: camera.ty, k: camera.k } });
      }
    };
  }, [active, cameraStore, leaveLive, markSeen, mountAt, runPendingShow, store, sync, writeCamera]);

  // Spec §10 view switch: mark the paint after the canvas comes back into view (restored in the toggle's frame).
  useEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = active;
    if (active && !wasActive) markAfterPaint(PERF.viewSwitch);
  }, [active]);

  // Layout changes: pin the focus frame across a level switch or Tidy; follow the frontier in Live.
  useLayoutEffect(() => {
    const prev = prevLayoutRef.current;
    prevLayoutRef.current = layout;
    const controller = controllerRef.current;
    if (layout === null || controller === null || prev === layout) return;
    const viewport = sizeRef.current;
    if (prev !== null && (prev.level !== layout.level || relayoutRef.current)) {
      relayoutRef.current = false;
      const s = latest.current.session;
      const selected = store.get().selection;
      const selectedBefore = s === null || selected === null ? undefined : frameForSelection(prev, s, selected);
      const before = controller.get();
      const focus = focusFrame(prev, before, viewport, selectedBefore);
      const next =
        focus === undefined
          ? undefined
          : (layout.frameByKey.get(focus.key) ?? layout.frames.find((candidate) => candidate.selId === focus.selId));
      if (focus !== undefined && next !== undefined) {
        const pinned = pinFrameCamera(before, focus.card, next.card, levelLimits(layout.level));
        writeCamera(pinned, "settle");
        void controller.set(pinned, { animate: false }).then(() => {
          if (controllerRef.current !== controller) return;
          rest();
          // The controller reports the pinned camera only after its frame; mount around it, not the pre-switch one.
          mountAt(controller.get());
        });
        markRelayout(viewportRef.current, next.key);
        if (diagnostics.enabled) {
          const a = screenPoint(before, focus);
          const b = screenPoint(pinned, next);
          diagnostics.reportDrift(Math.hypot(b.x - a.x, b.y - a.y));
        }
      }
      if (pendingFitRef.current) {
        pendingFitRef.current = false;
        fitAll();
      } else {
        sync();
      }
    } else if (prev !== null && store.get().follow) {
      // Live (spec §7.10): pan x only, and only when the frontier column leaves the view.
      const target = frontierFollowCamera(layout, controller.get(), viewport);
      if (target !== null) moveTo(target, true);
    } else if (prev !== null && diagnostics.enabled) {
      // Review: an append never moves a placed frame, so the frame nearest the center stays where it was.
      const camera = controller.get();
      const anchor = nearestFrameToCenter(prev, camera, viewport);
      const after = anchor === undefined ? undefined : layout.frameByKey.get(anchor.key);
      if (anchor !== undefined && after !== undefined) {
        const a = screenPoint(camera, anchor);
        const b = screenPoint(camera, after);
        diagnostics.reportDrift(Math.hypot(b.x - a.x, b.y - a.y));
      }
    }
    runPendingShow();
    markSeen();
  }, [diagnostics, fitAll, layout, markSeen, mountAt, moveTo, rest, runPendingShow, store, sync, writeCamera]);

  // Reveal (spec §7.5): a selection made outside the canvas (keys, Outline, n/N, the badge) comes into view. A canvas
  // click (focusBy "canvas") never moves the camera; its camera already agrees with focus, so it is stamped.
  useLayoutEffect(() => {
    if (lastSelectionRef.current === selection) return;
    lastSelectionRef.current = selection;
    if (!active || selection === null) return;
    if (store.get().focusBy === "canvas") {
      sync();
      return;
    }
    const pending = pendingRevealRef.current;
    const animate = pending !== null && pending.id === selection ? pending.animate : true;
    revealedThisCommitRef.current = reveal(selection, animate);
  }, [active, reveal, selection, store, sync]);

  // The port's queued reveal runs after the selection reveal of the same commit and is dropped when that already
  // revealed the same frame: one camera move per j (C2 hand-off, as the Hybrid spine does).
  useLayoutEffect(() => {
    const pending = pendingRevealRef.current;
    const revealed = revealedThisCommitRef.current;
    pendingRevealRef.current = null;
    revealedThisCommitRef.current = null;
    if (pending === null || !latest.current.active) return;
    const { layout: current, session: s } = latest.current;
    const frame = current === null || s === null ? undefined : frameForSelection(current, s, pending.id);
    if (frame === undefined || frame.key === revealed) return;
    reveal(pending.id, pending.animate);
  });

  const port = useMemo(
    () =>
      createCanvasPort({
        readingOrder: () => {
          const { layout: current, session: s } = latest.current;
          return current === null || s === null ? [] : canvasReadingOrder(current, s, store.get().expanded);
        },
        reveal: (id, animate) => {
          pendingRevealRef.current = { id, animate };
          bump();
        },
        captureCamera: () => {
          const camera = controllerRef.current?.get() ?? cameraStore.get();
          return { mode: "uniform", tx: camera.tx, ty: camera.ty, k: camera.k, syncedRev: syncedRevRef.current };
        },
        focusSelected: () => {
          const { layout: current, session: s } = latest.current;
          const selected = store.get().selection;
          const element = viewportRef.current;
          if (current === null || s === null || selected === null || element === null) return;
          const frame = frameForSelection(current, s, selected);
          if (frame !== undefined) focusFrameElement(element, frame.key);
        },
        camera: () => cameraStore.get(),
        zoomAround,
        zoomTo,
        fitAll,
        fitSelection,
      }),
    [cameraStore, fitAll, fitSelection, store, zoomAround, zoomTo],
  );
  useRegisterViewPort("canvas", port);

  // "N frames →" (spec §7.10 Review): per settled camera, never per camera frame (C3-10 review M5).
  const badgeCanShow = !follow && newCount > 0 && layout !== null;
  const ahead = useMemo(
    () => (badgeCanShow && layout !== null ? framesAhead(layout, settled ?? cameraStore.get(), size) : 0),
    [badgeCanShow, layout, settled, cameraStore, size],
  );

  // Per (layout, selection), never per camera tick (C3a hand-off: homeFrameKey rebuilds its context per call).
  const selectedFrame = useMemo(
    () => (layout !== null && session !== null && selection !== null ? frameForSelection(layout, session, selection) : undefined),
    [layout, session, selection],
  );
  const selectedKey = selectedFrame?.key ?? null;

  // Anchor rule (lessons W2): a frame is critical only through findings anchored at its steps.
  const criticalKeys = useMemo(() => {
    const keys = new Set<string>();
    if (layout === null || ctx === null) return keys;
    for (const frame of layout.frames) {
      if (frameSteps(frame, ctx).some((step) => worstSeverity(step, ctx.findingsById) === "critical")) keys.add(frame.key);
    }
    return keys;
  }, [layout, ctx]);

  const problemTs = useMemo(() => {
    if (session === null) return [];
    const stepById = new Map(session.steps.map((step) => [step.id, step]));
    return session.findings
      .filter((finding) => finding.severity === "critical")
      .map((finding) => stepById.get(finding.anchorStepId)?.tMs)
      .filter((t): t is number => t !== undefined);
  }, [session]);

  // Live running bars (C1a hand-off M-1): a 1 Hz tick while Live and not terminal, only when a frame is running.
  const hasRunning = useMemo(
    () => layout !== null && ctx !== null && layout.frames.some((frame) => frameRunning(frame, ctx)),
    [layout, ctx],
  );
  const [nowMs, setNowMs] = useState<number | null>(null);
  const nowT = view.nowT;
  const originMs = session?.originMs ?? 0;
  const ticking = active && hasRunning && session?.live === true && !view.terminal;
  useEffect(() => {
    const win = domView(viewportRef.current);
    if (!ticking || win === null) {
      setNowMs(null);
      return undefined;
    }
    setNowMs(originMs + nowT());
    const handle = win.setInterval(() => setNowMs(originMs + nowT()), 1_000);
    return () => win.clearInterval(handle);
  }, [ticking, originMs, nowT]);

  const playheadT = session === null ? null : (session.steps[index.stepIndexAtOrBefore(playheadSeq)]?.tMs ?? null);
  const band = useMemo<readonly [number, number] | null>(
    () => (selectedFrame === undefined || ctx === null ? null : [frameStart(selectedFrame, ctx), frameEnd(selectedFrame, ctx)]),
    [selectedFrame, ctx],
  );
  const hatchFromT = view.loadedFraction < 1 ? (session?.steps.at(-1)?.tMs ?? null) : null;
  // Spike risk 2 ruling (CULL_FRAMES): one viewport width of margin each side of the mounted camera (the settled
  // camera, moved along during a long pan or zoom). Before the viewport is measured nothing but the selection and the
  // tab stop mounts: at soak scale (thousands of frames) a first render of every frame would block the main thread.
  const mountCamera = mounted ?? cameraStore.get();
  const cullRange = useMemo<CullRange | null>(() => {
    if (!CULL_FRAMES) return null;
    if (size.w <= 0) return NOTHING;
    return mountedRange(mountCamera, size.w);
  }, [mountCamera, size.w]);

  const onSelect = useCallback(
    (frame: CanvasFrame) => {
      if (store.get().tool === "hand") return;
      store.dispatch({ type: "select", id: frame.selId, by: "canvas" });
    },
    [store],
  );
  const onToggle = useCallback((frame: CanvasFrame) => store.dispatch({ type: "expand/toggle", key: frame.key }), [store]);
  const onSelectEdge = useCallback(
    (edge: CanvasEdge) => {
      const from = latest.current.layout?.frameByKey.get(edge.from);
      if (from !== undefined) store.dispatch({ type: "select", id: from.selId, by: "canvas" });
    },
    [store],
  );
  const onCenter = useCallback(
    (world: Point) => {
      const controller = controllerRef.current;
      if (controller === null) return;
      leaveLive();
      moveTo(setCenter(controller.get(), world, sizeRef.current), true);
    },
    [leaveLive, moveTo],
  );
  // The minimap reports the outline's world delta; panBy takes screen px and moves the content, so the camera moves
  // by −delta · k. panBy is a gesture (rAF-coalesced, leaves Live, writes the brush at settle).
  const onPan = useCallback((dxWorld: number, dyWorld: number) => {
    const controller = controllerRef.current;
    if (controller === null) return;
    const k = controller.get().k;
    controller.panBy(-dxWorld * k, -dyWorld * k);
  }, []);
  const onTool = useCallback((next: Tool) => store.dispatch({ type: "tool/set", tool: next }), [store]);
  const onLevel = useCallback((next: Level) => store.dispatch({ type: "level/set", level: next, by: "canvas" }), [store]);
  const onTidy = useCallback(() => {
    relayoutRef.current = true;
    setTidyRev((rev) => rev + 1);
  }, []);

  const overlay = useMemo(
    () =>
      layout !== null && ctx !== null ? (
        <Overlay
          layout={layout}
          ctx={ctx}
          level={level}
          selectedKey={selectedKey}
          onSelect={onSelect}
          cullRange={cullRange}
          rootRef={setOverlayRoot}
        />
      ) : null,
    [layout, ctx, level, selectedKey, onSelect, cullRange, setOverlayRoot],
  );

  // Below this width the centered toolbar would run under the minimap: it moves to the left edge and the minimap
  // lifts above the toolbar row.
  const narrow = size.w > 0 && size.w < NARROW_PX;

  const hiddenRows =
    session === null ? 0 : Object.values(session.hidden.byType).reduce<number>((sum, count) => sum + (count ?? 0), 0);
  const emptyText =
    session === null || layout === null || layout.frames.length > 0
      ? null
      : session.live
        ? "Waiting for the agent's first event"
        : hiddenRows > 0
          ? `${hiddenRows.toLocaleString("en-US")} events, none describe agent work`
          : "No steps in this session";

  return (
    <div className={styles.root}>
      <div className={styles.ruler}>
        {layout !== null && size.w > 0 ? (
          <CanvasRuler
            layout={layout}
            scale={scale}
            cameraStore={cameraStore}
            base={mountCamera}
            widthPx={size.w}
            playheadT={playheadT}
            band={band}
            problemTs={problemTs}
            hatchFromT={hatchFromT}
          />
        ) : null}
      </div>
      <div className={styles.stage}>
        <World
          layout={layout}
          ctx={ctx}
          level={level}
          selectedKey={selectedKey}
          expanded={expanded}
          tool={tool}
          cullRange={cullRange}
          viewportRef={viewportRef}
          worldRef={worldRef}
          overlay={overlay}
          nowMs={nowMs}
          onSelect={onSelect}
          onToggle={onToggle}
          onSelectEdge={onSelectEdge}
        />
        {emptyText === null ? null : <p className={styles.empty}>{emptyText}</p>}
        {/* Siblings of the viewport, never inside it: wheel and clicks here never reach the camera controller. */}
        {badgeCanShow && ahead > 0 ? (
          <button type="button" tabIndex={-1} className={styles.ahead} onClick={() => store.dispatch({ type: "nav/last" })}>
            {ahead === 1 ? "1 frame →" : `${ahead.toLocaleString("en-US")} frames →`}
          </button>
        ) : null}
        {layout !== null ? (
          <div className={styles.toolbarSlot} data-narrow={narrow ? "" : undefined}>
            <Toolbar tool={tool} level={level} holes={layout.stats.holes} onTool={onTool} onLevel={onLevel} onFit={fitAll} onTidy={onTidy} />
          </div>
        ) : null}
        {layout !== null && size.w > 0 ? (
          <div className={styles.minimapSlot} data-narrow={narrow ? "" : undefined}>
            <Minimap
              layout={layout}
              cameraStore={cameraStore}
              viewport={size}
              selectedKey={selectedKey}
              criticalKeys={criticalKeys}
              onCenter={onCenter}
              onPan={onPan}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
