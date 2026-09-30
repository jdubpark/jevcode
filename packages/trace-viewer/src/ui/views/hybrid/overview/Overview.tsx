import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { buildOverviewIndex, type OverviewIndex } from "../../../../layout/overview-index.js";
import {
  GUTTER_W,
  GUTTER_W_NARROW,
  K_MAX,
  LANE_H,
  LANES_TOP,
  NARROW_CONTAINER_PX,
  OVERVIEW_H,
  layoutOverview,
  overviewPreset,
  type BandPlacement,
  type OverviewLayout,
} from "../../../../layout/overview-layout.js";
import { xOnlyXMap } from "../../../../layout/time-scale.js";
import { brushSeqRange, type TraceIndex } from "../../../../layout/trace-index.js";
import { fitRange, uToScreenX, type XOnlyCamera, type ZoomLimits } from "../../../../layout/viewport.js";
import { displayUntrusted, LANES, type Level, type TraceSession } from "../../../../model/index.js";
import { Icon } from "../../../icons/Icon.js";
import { CATEGORY_ICON, LANE_ICON, LANE_LABEL } from "../../../icons/kind-icons.js";
import { PERF } from "../../../shell/perf.js";
import { useSessionView } from "../../../shell/session-context.js";
import { useDispatch, useView, useViewStore } from "../../../state/store.js";
import { selectEffectivePlayheadSeq } from "../../../state/view-state.js";
import { LIGHT_TOKENS } from "../../../tokens/tokens.js";
import { createViewportController, type ViewportController } from "../../../viewport/controller.js";
import { LevelControl } from "../../shared/LevelControl.js";
import { Ruler } from "../../shared/Ruler.js";
import { rulerTicks } from "../../shared/ruler-ticks.js";
import { Brush, stepIndexAtX } from "./Brush.js";
import styles from "./Overview.module.css";
import { OverviewCanvas, type CanvasSurface } from "./OverviewCanvas.js";
import { laneCenter, paintOverview, type PaintContext } from "./paint.js";
import { Pins, PINS_PAINTED_ON_CANVAS } from "./Pins.js";

export interface OverviewApi {
  controller(): ViewportController<XOnlyCamera> | null;
  camera(): XOnlyCamera | null;
  widthPx(): number;
  overview(): OverviewIndex | null;
  limits(): ZoomLimits;
  /** Resolves once the camera has arrived (or been superseded). */
  moveTo(camera: XOnlyCamera, animate: boolean): Promise<void>;
}

export interface OverviewProps {
  active: boolean;
  apiRef: { current: OverviewApi | null };
  spineWindow: { t0: number; t1: number } | null;
  onSettle(camera: XOnlyCamera): void;
  createContext?(canvas: HTMLCanvasElement): PaintContext | null;
}

export function overviewLimits(endU: number, widthPx: number): ZoomLimits {
  const fitK = widthPx / Math.max(endU, 1);
  return { minK: fitK * 0.9, maxK: Math.max(K_MAX, fitK) };
}

export function zoomPercent(camera: XOnlyCamera, presetK: number): string {
  return `${Math.round((camera.k / presetK) * 100)}%`;
}

/** Reads the media query through the element's own window, never a bare global. */
function prefersReducedMotion(element: Element | null): boolean {
  const view = element?.ownerDocument.defaultView ?? null;
  return view !== null && typeof view.matchMedia === "function" && view.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function stepTAtSeq(session: TraceSession, index: TraceIndex, seq: number): number {
  return session.steps[Math.max(0, index.stepIndexAtOrBefore(seq))]?.tMs ?? 0;
}

/** The element's own window clock; null when that window has no Performance API. */
function elementPerformance(element: Element | null): Performance | null {
  const perf = element?.ownerDocument.defaultView?.performance;
  return perf !== undefined && typeof perf.now === "function" ? perf : null;
}

/** Gap kept between two labels of one tier (matches the layout's label gap). */
const LABEL_GAP_PX = 8;

/**
 * Max width per labelled band: a label may run past its own band into free tier space, up to the next label of its
 * tier (or the lane edge). The layout decides which bands get a label and in which tier (§7.6.1); this only keeps
 * the DOM from clipping a name the layout said fits.
 */
export function bandLabelWidths(bands: readonly BandPlacement[], widthPx: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const tier of [0, 1] as const) {
    const row = bands.filter((band) => band.tier === tier).sort((a, b) => a.labelX - b.labelX);
    row.forEach((band, i) => {
      const next = row[i + 1];
      const end = next === undefined ? widthPx : next.labelX - LABEL_GAP_PX;
      out.set(band.key, Math.max(20, end - band.labelX));
    });
  }
  return out;
}

interface FrameKey {
  overview: OverviewIndex;
  u0: number;
  k: number;
  widthPx: number;
  level: Level;
}

/** One layout per (data, camera, width, level): the canvas paint and the DOM overlay share it (perf fix 3). */
function createFrameCache(): (key: FrameKey) => OverviewLayout {
  let last: { key: FrameKey; layout: OverviewLayout } | null = null;
  return (key) => {
    const hit =
      last !== null &&
      last.key.overview === key.overview &&
      last.key.u0 === key.u0 &&
      last.key.k === key.k &&
      last.key.widthPx === key.widthPx &&
      last.key.level === key.level;
    if (hit && last !== null) return last.layout;
    const layout = layoutOverview({
      overview: key.overview,
      camera: { mode: "xOnly", u0: key.u0, k: key.k },
      widthPx: key.widthPx,
      level: key.level,
    });
    last = { key, layout };
    return layout;
  };
}

/** The Shell root: the container whose width sets the 1180 px breakpoint (§7.1 grid, §7.2 gutter). */
function shellRootOf(element: Element): Element | null {
  return element.closest("[data-trace-viewer]");
}

let paintSamples = 0;
function measurePaint(perf: Performance | null, started: number): void {
  if (perf === null) return;
  try {
    perf.measure(PERF.overviewPaint, { start: started, end: perf.now() });
    paintSamples += 1;
    if (paintSamples > 2_000) {
      perf.clearMeasures(PERF.overviewPaint);
      paintSamples = 0;
    }
  } catch {
    // Timing is diagnostic only.
  }
}

export function Overview({ active, apiRef, spineWindow, onSettle, createContext }: OverviewProps) {
  const { session, index, scale, loadedFraction } = useSessionView();
  const store = useViewStore();
  const dispatch = useDispatch();
  const level = useView((state) => state.level);
  const brush = useView((state) => state.brush);
  const selection = useView((state) => state.selection);
  const tool = useView((state) => state.tool);
  const follow = useView((state) => state.follow);
  const playheadSeq = useView((state) => selectEffectivePlayheadSeq(state, index));

  const containerRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(0);
  const [shellW, setShellW] = useState(0);
  // The gutter follows the Shell container, not the overview: the overview is the Shell minus both side panels.
  const breakpointW = shellW > 0 ? shellW : containerW;
  const narrow = breakpointW > 0 && breakpointW < NARROW_CONTAINER_PX;
  const gutterW = narrow ? GUTTER_W_NARROW : GUTTER_W;
  const widthPx = Math.max(0, containerW - gutterW);

  // Starts from the last overview built: marks and bands whose inputs did not change are kept (any earlier overview
  // works, so a discarded render costs only speed).
  const lastOverview = useRef<OverviewIndex | undefined>(undefined);
  const overview = useMemo(
    () => (session === null ? null : buildOverviewIndex(session, index, scale, lastOverview.current)),
    [session, index, scale],
  );
  lastOverview.current = overview ?? undefined;
  const limits = useMemo(() => overviewLimits(scale.endU, widthPx), [scale, widthPx]);

  const [camera, setCamera] = useState<XOnlyCamera | null>(null);
  const cameraRef = useRef<XOnlyCamera | null>(null);
  const renderedRef = useRef<XOnlyCamera | null>(null);
  const controllerRef = useRef<ViewportController<XOnlyCamera> | null>(null);
  const surfaceRef = useRef<CanvasSurface | null>(null);
  const createContextRef = useRef(createContext);
  createContextRef.current = createContext;
  // OverviewCanvas requires a stable createContext: forward through a ref so a caller's inline function cannot rebuild the surface.
  const stableCreateContext = useMemo(
    () =>
      createContext === undefined
        ? undefined
        : (canvas: HTMLCanvasElement): PaintContext | null => createContextRef.current?.(canvas) ?? null,
    // Only whether a seam exists matters; the ref carries the current function.
    [createContext === undefined],
  );
  const frameOf = useMemo(createFrameCache, []);
  const live = useRef({ overview, scale, level, widthPx, limits, onSettle, brush, playheadSeq, session, index });
  live.current = { overview, scale, level, widthPx, limits, onSettle, brush, playheadSeq, session, index };

  useEffect(() => {
    const element = containerRef.current;
    if (element === null) return undefined;
    const shell = shellRootOf(element);
    const apply = (target: Element, width: number): void => {
      if (width <= 0) return;
      if (target === element) setContainerW(Math.round(width));
      else if (target === shell) setShellW(Math.round(width));
    };
    apply(element, element.getBoundingClientRect().width);
    if (shell !== null) apply(shell, shell.getBoundingClientRect().width);
    const Observer = element.ownerDocument.defaultView?.ResizeObserver;
    if (typeof Observer !== "function") return undefined;
    const observer = new Observer((entries) => {
      for (const entry of entries) apply(entry.target, entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width);
    });
    observer.observe(element);
    if (shell !== null) observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  const presetCamera = useCallback(
    (forLevel: Level): XOnlyCamera | null => {
      const { overview: current, scale: currentScale, widthPx: width, index: currentIndex } = live.current;
      if (current === null || width <= 0) return null;
      const state = store.get();
      return overviewPreset({
        level: forLevel,
        overview: current,
        index: currentIndex,
        scale: currentScale,
        widthPx: width,
        playheadSeq: selectEffectivePlayheadSeq(state, currentIndex),
        live: state.follow,
      }).camera;
    },
    [store],
  );

  const paintNow = useCallback((): void => {
    const surface = surfaceRef.current;
    const current = cameraRef.current;
    const { overview: model, scale: currentScale, level: currentLevel, brush: currentBrush, playheadSeq: seq, session: s, index: ix } =
      live.current;
    if (surface === null || current === null || model === null || s === null) return;
    const perf = elementPerformance(containerRef.current);
    const started = perf?.now() ?? 0;
    const frame = frameOf({ overview: model, u0: current.u0, k: current.k, widthPx: surface.widthPx, level: currentLevel });
    const ticks = rulerTicks(xOnlyXMap(currentScale, current), currentScale, { x0: 0, x1: surface.widthPx }).ticks;
    const toStrip = (u: number): number => (u / Math.max(currentScale.endU, 1)) * surface.widthPx;
    const range = brushSeqRange(currentBrush, ix);
    const selected = store.get().selection;
    const selectedChapter = selected === null ? null : selected.startsWith("unit:") ? selected : (ix.entry(selected)?.parent ?? null);
    paintOverview(surface.ctx, {
      layout: frame,
      ticks,
      widthPx: surface.widthPx,
      dpr: surface.dpr,
      tokens: LIGHT_TOKENS,
      emphasizedBands: new Set(frame.bands.filter((band) => band.id !== null && band.id === selectedChapter).map((band) => band.key)),
      strip: {
        brush:
          currentBrush.kind === "session"
            ? null
            : {
                x0: toStrip(currentScale.toU(stepTAtSeq(s, ix, range.fromSeq))),
                x1: toStrip(currentScale.toU(stepTAtSeq(s, ix, range.toSeq))),
              },
        playheadX: toStrip(currentScale.toU(stepTAtSeq(s, ix, seq))),
        viewport: { x0: toStrip(current.u0), x1: toStrip(current.u0 + surface.widthPx / current.k) },
      },
      paintPins: PINS_PAINTED_ON_CANVAS,
    });
    measurePaint(perf, started);
  }, [store, frameOf]);

  const moveOverlay = useCallback((next: XOnlyCamera): void => {
    const rendered = renderedRef.current;
    const overlay = overlayRef.current;
    if (rendered === null || overlay === null || rendered.k !== next.k) {
      setCamera(next);
      return;
    }
    overlay.style.transform = `translateX(${(rendered.u0 - next.u0) * next.k}px)`;
  }, []);

  const moveTo = useCallback(
    (next: XOnlyCamera, animate: boolean): Promise<void> => {
      const controller = controllerRef.current;
      if (controller === null) {
        cameraRef.current = next;
        setCamera(next);
        return Promise.resolve();
      }
      return controller.set(next, { animate: animate && !prefersReducedMotion(lanesRef.current) }).then(() => {
        const settled = controller.get();
        cameraRef.current = settled;
        setCamera(settled);
      });
    },
    [],
  );

  // Initial camera: the stored one while in sync with focus, else the level preset (spec §7.8 item 3).
  useLayoutEffect(() => {
    if (cameraRef.current !== null || widthPx <= 0 || overview === null) return;
    const state = store.get();
    const saved = state.cameras.hybrid;
    const initial: XOnlyCamera | null =
      saved !== null && saved.syncedRev === state.focusRev ? { mode: "xOnly", u0: saved.u0, k: saved.k } : presetCamera(state.level);
    if (initial === null) return;
    cameraRef.current = initial;
    setCamera(initial);
  }, [widthPx, overview, store, presetCamera]);

  const cameraReady = camera !== null;
  useEffect(() => {
    const element = lanesRef.current;
    const initial = cameraRef.current;
    if (!active || element === null || initial === null) return undefined;
    const controller = createViewportController<XOnlyCamera>({
      element,
      initial,
      limits: () => live.current.limits,
      viewport: () => ({ w: live.current.widthPx, h: OVERVIEW_H }),
      content: () => ({ x: 0, y: 0, w: Math.max(live.current.scale.endU, 1), h: 0 }),
      onFrame: (next) => {
        cameraRef.current = next;
        paintNow();
        moveOverlay(next);
      },
      onGestureStart: (kind) => {
        // will-change lives only for the gesture (spike ruling).
        if (overlayRef.current !== null) overlayRef.current.style.willChange = "transform";
        if (store.get().follow) store.dispatch({ type: "follow/set", follow: false });
        store.dispatch({ type: "gesture", gesture: kind });
      },
      onGestureEnd: (settled) => {
        if (overlayRef.current !== null) overlayRef.current.style.willChange = "";
        cameraRef.current = settled;
        setCamera(settled);
        store.dispatch({ type: "gesture", gesture: null });
        live.current.onSettle(settled);
      },
      isHandTool: () => store.get().tool === "hand",
      reducedMotion: () => prefersReducedMotion(element),
    });
    controllerRef.current = controller;
    return () => {
      const interrupted = controller.isGesturing();
      controller.destroy();
      if (overlayRef.current !== null) overlayRef.current.style.willChange = "";
      if (interrupted) store.dispatch({ type: "gesture", gesture: null });
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [active, cameraReady, store, paintNow, moveOverlay]);

  // Live: keep the tail in view (spec §7.10 Hybrid overview).
  useEffect(() => {
    const current = cameraRef.current;
    if (!follow || current === null || session === null || widthPx <= 0) return;
    const tailX = uToScreenX(current, scale.endU);
    if (tailX <= widthPx * 0.8 && tailX >= 0) return;
    if (level === "session") {
      moveTo(fitRange(0, Math.max(1, scale.endU * 1.5), widthPx, { padFraction: 0, limits }), false);
    } else {
      moveTo({ mode: "xOnly", u0: scale.endU - (widthPx * 0.6) / current.k, k: current.k }, false);
    }
  }, [session, follow, level, widthPx, scale, limits, moveTo]);

  useLayoutEffect(() => {
    apiRef.current = {
      controller: () => controllerRef.current,
      camera: () => cameraRef.current,
      widthPx: () => live.current.widthPx,
      overview: () => live.current.overview,
      limits: () => live.current.limits,
      moveTo,
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, moveTo]);

  // After every render: the overlay sits at the rendered camera and the canvas repaints.
  useLayoutEffect(() => {
    renderedRef.current = camera;
    if (overlayRef.current !== null) overlayRef.current.style.transform = "";
    paintNow();
  });

  const onSurface = useCallback(
    (surface: CanvasSurface | null): void => {
      surfaceRef.current = surface;
      paintNow();
    },
    [paintNow],
  );

  const renderLayout = useMemo<OverviewLayout | null>(
    () => (overview === null || camera === null || widthPx <= 0 ? null : frameOf({ overview, u0: camera.u0, k: camera.k, widthPx, level })),
    [overview, camera, widthPx, level, frameOf],
  );
  const labelWidths = useMemo(
    () => (renderLayout === null ? new Map<string, number>() : bandLabelWidths(renderLayout.bands, widthPx)),
    [renderLayout, widthPx],
  );
  const chapterById = useMemo(() => new Map((session?.chapters ?? []).map((chapter) => [chapter.id, chapter])), [session]);
  const selectedChapter =
    selection === null ? null : selection.startsWith("unit:") ? selection : (index.entry(selection)?.parent ?? null);
  // `overview` and `widthPx` are not read in the callback body: presetCamera reads them through a ref, so it keeps a
  // stable identity, and these deps re-run it when the data or the width changes. A react-hooks exhaustive-deps lint would flag them as unnecessary.
  const presetK = useMemo(() => presetCamera(level)?.k ?? null, [presetCamera, level, overview, widthPx]);
  const xMap = useMemo(() => (camera === null ? null : xOnlyXMap(scale, camera)), [scale, camera]);
  const loadedThroughT = loadedFraction < 1 && session !== null ? (session.steps.at(-1)?.tMs ?? 0) : null;

  const focusBand = (band: BandPlacement): void => {
    if (session === null || camera === null) return;
    const step = session.steps[stepIndexAtX(session, scale, camera, band.x0 + 0.5, "after")];
    if (step === undefined) return;
    dispatch({ type: "playhead/set", playhead: { kind: "free", seq: step.firstSeq }, origin: "overview" });
    const key = band.id === null ? undefined : index.chapterKey(band.id);
    if (key !== undefined) dispatch({ type: "brush/set", brush: { kind: "chapter", anchorSeq: Number(key.slice(3)) }, by: "hybrid" });
    dispatch({ type: "level/set", level: "chapter", by: "hybrid" });
  };

  const zoomToSteps = (stepIndexes: readonly number[]): void => {
    if (session === null || widthPx <= 0) return;
    const first = session.steps[stepIndexes[0] ?? 0];
    const last = session.steps[stepIndexes.at(-1) ?? 0];
    if (first === undefined || last === undefined) return;
    moveTo(
      fitRange(scale.toU(first.tMs), scale.toU(last.tMs + (last.durationMs ?? 0)) + 1, widthPx, { padFraction: 0.2, limits }),
      true,
    );
  };

  const pinByKey = new Map((renderLayout?.pins ?? []).map((pin) => [pin.key, pin]));

  return (
    <div ref={containerRef} className={styles.overview} data-measure-root="" data-pannable="" style={{ height: OVERVIEW_H }}>
      <div className={styles.gutter} style={{ width: gutterW }}>
        {LANES.map((lane, position) => (
          <div key={lane} className={styles.laneLabel} style={{ top: LANES_TOP + position * LANE_H, height: LANE_H }}>
            {narrow ? null : <span className={styles.laneName}>{LANE_LABEL[lane]}</span>}
            <Icon name={LANE_ICON[lane]} size={14} title={narrow ? LANE_LABEL[lane] : undefined} />
          </div>
        ))}
      </div>
      <div ref={lanesRef} className={styles.lanes} style={{ left: gutterW }} data-overview-lanes="" data-tool={tool}>
        <OverviewCanvas
          widthPx={widthPx}
          heightPx={OVERVIEW_H}
          className={styles.canvas}
          onSurface={onSurface}
          createContext={stableCreateContext}
        />
        <div ref={overlayRef} className={styles.overlay}>
          {xMap === null ? null : (
            <Ruler map={xMap} scale={scale} widthPx={widthPx} loadedThroughT={loadedThroughT} className={styles.ruler} />
          )}
          {spineWindow === null || xMap === null ? null : (
            <span
              className={styles.underline}
              style={{ left: xMap.xOf(spineWindow.t0), width: Math.max(2, xMap.xOf(spineWindow.t1) - xMap.xOf(spineWindow.t0)) }}
            />
          )}
          {renderLayout === null || session === null || camera === null ? null : (
            <>
              {renderLayout.bands
                .filter((band) => band.tier !== null)
                .map((band) => {
                  const chapter = band.id === null ? undefined : chapterById.get(band.id);
                  // Chapter titles embed agent-written paths: neutralise bidi and control characters (lane review I-1).
                  // The label shows the band's short title; the tooltip and the name carry the full title.
                  const shortTitle = displayUntrusted(band.title);
                  const title = displayUntrusted(chapter?.title ?? band.title);
                  return (
                    <button
                      key={band.key}
                      type="button"
                      tabIndex={-1}
                      data-overlay-node=""
                      data-band-label=""
                      data-on={band.id !== null && band.id === selectedChapter ? "" : undefined}
                      className={styles.bandLabel}
                      style={{ left: band.labelX, top: band.tier === 1 ? 18 : 0, maxWidth: labelWidths.get(band.key) ?? 20 }}
                      title={title}
                      aria-label={title}
                      onDoubleClick={() => focusBand(band)}
                    >
                      <Icon name={chapter === undefined ? "flag" : CATEGORY_ICON[chapter.category]} size={12} />
                      {band.iconOnly ? null : <span className={styles.bandTitle}>{shortTitle}</span>}
                    </button>
                  );
                })}
              <Brush
                session={session}
                index={index}
                scale={scale}
                camera={camera}
                level={level}
                brush={brush}
                playheadSeq={playheadSeq}
                pins={renderLayout.pins}
                bands={renderLayout.bands}
                tool={tool}
                onPlayhead={(seq) =>
                  dispatch({ type: "playhead/set", playhead: { kind: "free", seq }, origin: "overview" })
                }
                onStep={(dir) => dispatch({ type: "playhead/step", dir })}
                onBrush={(next) => dispatch({ type: "brush/set", brush: next, by: "hybrid" })}
                onGesture={(gesture) => dispatch({ type: "gesture", gesture })}
              />
              <Pins
                pins={renderLayout.pins}
                session={session}
                selection={selection}
                onSelect={(stepIndex) => {
                  const step = session.steps[stepIndex];
                  if (step !== undefined) dispatch({ type: "select", id: step.id, by: "hybrid" });
                }}
                onZoomTo={zoomToSteps}
              />
              <svg className={styles.links} aria-hidden="true" width={widthPx} height={OVERVIEW_H}>
                {renderLayout.links.map((link) => {
                  const a = pinByKey.get(link.fromPin);
                  const b = pinByKey.get(link.toPin);
                  if (a === undefined || b === undefined) return null;
                  const ay = laneCenter(a.lane);
                  const by = laneCenter(b.lane);
                  const mx = (a.x + b.x) / 2;
                  return <path key={link.findingId} className={styles.link} d={`M ${a.x} ${ay} C ${mx} ${ay}, ${mx} ${by}, ${b.x} ${by}`} />;
                })}
              </svg>
              {renderLayout.links.map((link) => {
                const a = pinByKey.get(link.fromPin);
                const b = pinByKey.get(link.toPin);
                if (a === undefined || b === undefined) return null;
                return (
                  <span
                    key={`neq:${link.findingId}`}
                    className={styles.neq}
                    data-overlay-node=""
                    style={{ left: (a.x + b.x) / 2 - 9, top: (laneCenter(a.lane) + laneCenter(b.lane)) / 2 - 9 }}
                  >
                    <Icon name="neq" size={12} />
                  </span>
                );
              })}
            </>
          )}
        </div>
        <div className={styles.toolbar} role="toolbar" aria-label="Overview tools">
          <button
            type="button"
            tabIndex={-1}
            aria-label="Select"
            aria-pressed={tool === "select"}
            className={styles.tool}
            onClick={() => dispatch({ type: "tool/set", tool: "select" })}
          >
            <Icon name="cursor" size={16} />
          </button>
          <button
            type="button"
            tabIndex={-1}
            aria-label="Hand"
            aria-pressed={tool === "hand"}
            className={styles.tool}
            onClick={() => dispatch({ type: "tool/set", tool: "hand" })}
          >
            <Icon name="hand" size={16} />
          </button>
          <LevelControl by="hybrid" />
          <span className={styles.zoom}>
            <Icon name="zoom" size={14} />
            {camera === null || presetK === null ? "100%" : zoomPercent(camera, presetK)}
          </span>
        </div>
      </div>
    </div>
  );
}
