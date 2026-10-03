import { useCallback, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type React from "react";

import {
  MAP_BAND_LABEL_H,
  MAP_LANE_PAD,
  MAP_MARGIN,
  layoutMap,
  mapHubIds,
  mapImporterCounts,
  mapLevelForZoom,
  type MapBand,
  type MapCard as MapCardBox,
  type MapLayout,
  type MapLayoutState,
  type MapLevel,
} from "../../../layout/map-layout.js";
import type { Size, UniformCamera } from "../../../layout/viewport.js";
import type { OverviewModel } from "../../../model/index.js";
import type { IconName } from "../../icons/icon-names.js";
import { Icon } from "../../icons/Icon.js";
import { useSessionView } from "../../shell/session-context.js";
import { ZOOM_STEP } from "../../state/keymap.js";
import { useView, useViewStore } from "../../state/store.js";
import { createViewportController, type FramePhase, type ViewportController } from "../../viewport/controller.js";
import { useRegisterViewPort, useViewPortRegistry, type ViewPort, type ViewProps } from "../view-port.js";
import { anchoredCamera, cardCenter, MAP_ICON_ONLY_K, MAP_ZOOM_PRESETS, mapZoomLimits, planMapFit, revealCamera, zoomedAtCenter } from "./map-camera.js";
import { isMapNavKey, mapNeighbor } from "./map-nav.js";
import { scanNote } from "./map-text.js";
import { MapCard } from "./MapCard.js";
import { MapEdges } from "./MapEdges.js";
import { MapHeader } from "./MapHeader.js";
import styles from "./MapView.module.css";
import { mapOverlayOf } from "./overlay.js";

const BAND_LABEL: { readonly [K in MapBand]: string } = {
  ui: "UI",
  api: "API · IPC",
  agent: "Agents",
  domain: "Domain",
  storage: "Storage",
  side: "Support",
  // Never a band of their own (bandOf puts them in the side band); listed so the record covers MapBand.
  tests: "Support",
  tooling: "Support",
  config: "Support",
};
const BAND_ICON: { readonly [K in MapBand]: IconName } = {
  ui: "role-ui",
  api: "role-api",
  agent: "role-agent",
  domain: "role-domain",
  storage: "role-storage",
  side: "stack",
  tests: "stack",
  tooling: "stack",
  config: "stack",
};
const START: UniformCamera = { mode: "uniform", tx: 0, ty: 0, k: 0.5 };
const NO_HUBS: ReadonlySet<string> = new Set();
const NO_COUNTS: ReadonlyMap<string, number> = new Map();

function prefersReducedMotion(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  return view !== null && typeof view.matchMedia === "function" && view.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Spec E12: true when `layout` moved a card that `previous` placed (a band appeared or emptied, a column changed). */
function movedPlacedCard(layout: MapLayout, previous: readonly MapCardBox[]): boolean {
  const before = new Map(previous.map((card) => [card.id, card] as const));
  return layout.cards.some((card) => {
    const was = before.get(card.id);
    return was !== undefined && (was.x !== card.x || was.y !== card.y);
  });
}

interface Latest {
  overview: OverviewModel | null;
  cards: readonly MapCardBox[] | null;
  bounds: { w: number; h: number } | null;
  level: MapLevel;
  active: boolean;
}

/** The codebase Map (spec §3.4, E13): light band lanes, DOM cards and one SVG edge layer in a world layer moved by the shared camera controller. */
export function MapView({ active }: ViewProps): React.JSX.Element {
  const view = useSessionView();
  const store = useViewStore();
  const registry = useViewPortRegistry();
  const selection = useView((state) => state.mapSelection);
  const tool = useView((state) => state.tool);
  const session = view.session;
  const overview = session?.overview ?? null;
  // The level only changes what a card shows (one geometry, so no card moves); it follows the zoom at each settle.
  const [level, setLevel] = useState<MapLevel>("card");
  const [focusId, setFocusId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const stickyRef = useRef<MapLayoutState | undefined>(undefined);
  // Sticky (spec §8.3): each layout starts from the last committed layout's band order.
  const layout = useMemo(() => (overview === null ? null : layoutMap(overview, { level: "card" }, stickyRef.current)), [overview]);
  /** The cards of the last committed layout, to tell a relayout that moves cards from the first layout. */
  const prevCardsRef = useRef<readonly MapCardBox[] | null>(null);
  /** Relayouts that moved cards so far; its parity picks the edge-fade keyframes, so back-to-back fades replay. */
  const relayoutCountRef = useRef(0);
  /** The card the reader last focused or selected: Esc from the Inspector returns focus there (not to the first card). */
  const lastCardRef = useRef<string | null>(null);
  const overlay = useMemo(() => (session === null ? null : mapOverlayOf(session)), [session]);
  const hubs = useMemo(() => (layout === null ? NO_HUBS : mapHubIds(layout.edges, layout.cards.length)), [layout]);
  const importers = useMemo(() => (layout === null ? NO_COUNTS : mapImporterCounts(layout.edges)), [layout]);
  const maxFiles = useMemo(() => overview?.snapshot.components.reduce((most, component) => Math.max(most, component.fileCount), 0) ?? 0, [overview]);
  const activeId = hoverId ?? selection;

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<ViewportController<UniformCamera> | null>(null);
  /** The camera last written to the world (the one on screen). */
  const cameraRef = useRef<UniformCamera>(START);
  const moveTokenRef = useRef(0);
  const sizeRef = useRef<Size>({ w: 0, h: 0 });
  const fittedRepoRef = useRef<string | null>(null);
  /** The camera the last Fit chose; a resize refits only while the camera is still there. */
  const lastFitRef = useRef<UniformCamera | null>(null);
  /** A user key or port call asked to focus this card; consumed once by the next commit (never on data rebuilds). */
  const pendingFocusRef = useRef<string | null>(null);
  const latest = useRef<Latest>({ overview, cards: layout?.cards ?? null, bounds: layout?.bounds ?? null, level, active });

  useLayoutEffect(() => {
    latest.current = { overview, cards: layout?.cards ?? null, bounds: layout?.bounds ?? null, level, active };
    if (layout !== null) stickyRef.current = layout.state;
  });

  // Spec E12: a new layout that moved placed cards marks the world in the same frame as the new positions, so the CSS
  // glides the cards and fades the edges back in; never under reduced motion, never for the first layout.
  useLayoutEffect(() => {
    if (layout === null) return;
    const previous = prevCardsRef.current;
    prevCardsRef.current = layout.cards;
    const world = worldRef.current;
    const viewport = viewportRef.current;
    if (world === null || viewport === null) return;
    if (previous !== null && movedPlacedCard(layout, previous) && !prefersReducedMotion(viewport)) {
      relayoutCountRef.current += 1;
      world.dataset.relayout = relayoutCountRef.current % 2 === 0 ? "even" : "odd";
    } else if (world.dataset.relayout !== undefined) {
      delete world.dataset.relayout;
    }
  }, [layout]);

  /**
   * One write per camera frame: the world transform and the zoom band (names hide below MAP_ICON_ONLY_K). As in the
   * Canvas (spike risk 2 and 7 rulings), will-change holds only while a gesture or a tween runs, and --map-inv-k (rings
   * and focus outlines keep their screen width) is written at rest only, so a moving frame restyles no card.
   */
  const writeCamera = useCallback((camera: UniformCamera, phase: FramePhase) => {
    cameraRef.current = camera;
    const world = worldRef.current;
    if (world !== null) {
      world.style.transform = `translate(${camera.tx}px, ${camera.ty}px) scale(${camera.k})`;
      const moving = phase !== "settle";
      if (!moving) world.style.setProperty("--map-inv-k", String(1 / camera.k));
      const willChange = moving ? "transform" : "";
      if (world.style.willChange !== willChange) world.style.willChange = willChange;
    }
    const viewport = viewportRef.current;
    if (viewport !== null) {
      const band = camera.k < MAP_ICON_ONLY_K ? "icon" : "full";
      if (viewport.dataset.zoomBand !== band) viewport.dataset.zoomBand = band;
    }
  }, []);

  /** At rest the level follows the zoom (spec §8.3); cards keep their place, only their content changes. */
  const settle = useCallback(
    (camera: UniformCamera) => {
      const next = mapLevelForZoom(camera.k);
      if (next !== latest.current.level) setLevel(next);
      registry.notify();
    },
    [registry],
  );

  const moveTo = useCallback(
    (camera: UniformCamera, animate: boolean) => {
      const controller = controllerRef.current;
      const element = viewportRef.current;
      if (controller === null || element === null) return;
      const token = (moveTokenRef.current += 1);
      const tween = animate && !prefersReducedMotion(element);
      // A jump shows at once, so no frame paints the old camera; the controller arrives on its next frame.
      if (!tween) writeCamera(camera, "settle");
      void controller.set(camera, { animate: tween }).then(() => {
        // A superseded move (a newer one started, or a gesture took over) never settles from the camera it left.
        if (token !== moveTokenRef.current || controllerRef.current !== controller || controller.isGesturing()) return;
        writeCamera(controller.get(), "settle");
        settle(controller.get());
      });
    },
    [settle, writeCamera],
  );

  const fit = useCallback(
    (animate: boolean): boolean => {
      const current = latest.current;
      if (current.overview === null || controllerRef.current === null) return false;
      const plan = planMapFit(current.overview, sizeRef.current, stickyRef.current);
      if (plan === null) return false;
      lastFitRef.current = plan.camera;
      if (plan.level !== current.level) setLevel(plan.level);
      moveTo(plan.camera, animate);
      return true;
    },
    [moveTo],
  );

  /**
   * Fit once per repo, when the view is shown with a real size and the map has a card (spec §3.4 "Fit shows the whole
   * map"); a scan's first progress snapshots can carry no components, and those must not use up the repo's Fit.
   */
  const fitIfPending = useCallback(() => {
    const current = latest.current;
    const repo = current.overview?.snapshot.repoRoot ?? null;
    if (!current.active || repo === null || fittedRepoRef.current === repo || (current.cards?.length ?? 0) === 0) return;
    if (sizeRef.current.w <= 0 || sizeRef.current.h <= 0) return;
    if (fit(false)) fittedRepoRef.current = repo;
  }, [fit]);

  /** A viewport resize refits (centered, filling the stage) while the camera is still where the last Fit left it. */
  const refitIfStillFitted = useCallback((): boolean => {
    const last = lastFitRef.current;
    if (controllerRef.current === null || last === null) return false;
    const now = cameraRef.current;
    if (Math.abs(now.k - last.k) > 1e-6 || Math.abs(now.tx - last.tx) > 0.5 || Math.abs(now.ty - last.ty) > 0.5) return false;
    return fit(false);
  }, [fit]);

  const hasOverview = overview !== null;
  useLayoutEffect(() => {
    const element = viewportRef.current;
    const win = element?.ownerDocument.defaultView ?? null;
    if (element === null || win === null) return undefined;
    const controller = createViewportController<UniformCamera>({
      element,
      initial: cameraRef.current,
      limits: () => mapZoomLimits(lastFitRef.current?.k ?? null),
      viewport: () => sizeRef.current,
      content: () => {
        const bounds = latest.current.bounds;
        return bounds === null ? { x: 0, y: 0, w: 0, h: 0 } : { x: 0, y: 0, w: bounds.w, h: bounds.h };
      },
      onFrame: (camera, phase) => writeCamera(camera, phase),
      onGestureEnd: (camera) => settle(camera),
      isHandTool: () => store.get().tool === "hand",
      reducedMotion: () => prefersReducedMotion(element),
      raf: (callback) => win.requestAnimationFrame(callback),
      cancelRaf: (handle) => win.cancelAnimationFrame(handle),
      setTimer: (callback, ms) => win.setTimeout(callback, ms),
      clearTimer: (handle) => win.clearTimeout(handle as number),
    });
    controllerRef.current = controller;
    writeCamera(cameraRef.current, "settle");
    const Observer = win.ResizeObserver;
    const observer =
      typeof Observer === "function"
        ? new Observer((entries) => {
            const rect = entries[0]?.contentRect;
            if (rect === undefined || rect.width <= 0 || rect.height <= 0) return; // 0 × 0 under <Activity mode="hidden">
            sizeRef.current = { w: rect.width, h: rect.height };
            if (!refitIfStillFitted()) fitIfPending();
          })
        : null;
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      controller.destroy();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [hasOverview, fitIfPending, refitIfStillFitted, settle, store, writeCamera]);

  useLayoutEffect(() => {
    fitIfPending();
  }, [overview, active, fitIfPending]);

  // Focus moves only for a pending user request (lessons-w2): never on a new snapshot.
  useLayoutEffect(() => {
    const id = pendingFocusRef.current;
    if (id === null) return;
    pendingFocusRef.current = null;
    const element = worldRef.current?.querySelector<HTMLElement>(`[data-map-card="${id}"]`) ?? null;
    if (element === null) return;
    element.focus({ preventScroll: true });
    const card = latest.current.cards?.find((item) => item.id === id);
    const controller = controllerRef.current;
    if (card === undefined || controller === null) return;
    const target = revealCamera(cameraRef.current, card, sizeRef.current);
    if (target !== null) moveTo(target, true);
  });

  const onSelectCard = useCallback(
    (id: string) => {
      if (store.get().tool === "hand" || controllerRef.current?.isGesturing() === true) return;
      lastCardRef.current = id;
      setFocusId(id);
      store.dispatch({ type: "map/select", componentId: id });
    },
    [store],
  );

  const onBackgroundClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const state = store.get();
      if (state.tool === "hand" || state.mapSelection === null) return;
      if (event.target instanceof Element && event.target.closest("[data-map-card]") !== null) return;
      store.dispatch({ type: "map/select", componentId: null });
    },
    [store],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (layout === null || !isMapNavKey(event.key) || event.altKey || event.metaKey || event.ctrlKey) return;
      const from = event.target instanceof Element ? (event.target.closest<HTMLElement>("[data-map-card]")?.dataset.mapCard ?? null) : null;
      const next = mapNeighbor(layout, from, event.key);
      if (next === null) return;
      event.preventDefault();
      lastCardRef.current = next;
      pendingFocusRef.current = next;
      setFocusId(next);
      bump();
    },
    [layout],
  );

  /** A card that takes focus any way (Tab, click, keys) is the one Esc from the Inspector returns to. */
  const onCardFocus = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    const id = event.target instanceof Element ? (event.target.closest<HTMLElement>("[data-map-card]")?.dataset.mapCard ?? null) : null;
    if (id !== null) lastCardRef.current = id;
  }, []);

  const zoomTo = useCallback(
    (k: number) => {
      if (controllerRef.current !== null) moveTo(zoomedAtCenter(cameraRef.current, k, sizeRef.current), true);
    },
    [moveTo],
  );

  const fitSelection = useCallback(() => {
    const id = store.get().mapSelection;
    const card = id === null ? undefined : latest.current.cards?.find((item) => item.id === id);
    if (card === undefined) return;
    moveTo(anchoredCamera(1, cardCenter(card), { x: sizeRef.current.w / 2, y: sizeRef.current.h / 2 }), true);
  }, [moveTo, store]);

  const port = useMemo<ViewPort>(
    () => ({
      readingOrder: () => [],
      reveal: () => undefined,
      captureCamera: () => null,
      focusSelected: () => {
        const cards = latest.current.cards ?? [];
        const last = lastCardRef.current;
        const remembered = last !== null && cards.some((card) => card.id === last) ? last : null;
        const id = store.get().mapSelection ?? remembered ?? cards[0]?.id ?? null;
        if (id === null) return;
        pendingFocusRef.current = id;
        setFocusId(id);
        bump();
      },
      zoom: {
        label: () => `${Math.round(cameraRef.current.k * 100)}%`,
        presets: () => MAP_ZOOM_PRESETS,
        applyPreset: (id) => {
          if (id === "fit") fit(true);
          else zoomTo(1);
        },
        zoomIn: () => controllerRef.current?.zoomBy(ZOOM_STEP),
        zoomOut: () => controllerRef.current?.zoomBy(1 / ZOOM_STEP),
        resetToPreset: () => zoomTo(1),
        fitAll: () => {
          fit(true);
        },
        fitSelection,
      },
    }),
    [fit, fitSelection, store, zoomTo],
  );
  useRegisterViewPort("map", port);

  const tabStop = useMemo(() => {
    if (layout === null) return null;
    const has = (id: string | null): id is string => id !== null && layout.cards.some((card) => card.id === id);
    return has(focusId) ? focusId : has(selection) ? selection : (layout.cards[0]?.id ?? null);
  }, [layout, focusId, selection]);

  if (overview === null || layout === null) {
    return (
      <section className={styles.root} aria-label="Codebase map">
        <div className={styles.empty} data-map-empty="">
          <Icon name="view-map" size={16} />
          <p>No codebase map yet</p>
        </div>
      </section>
    );
  }
  const laneTop = MAP_MARGIN - 4;
  const laneHeight = layout.bounds.h - 2 * MAP_MARGIN + 10; // down to bounds.h − MAP_MARGIN + 6
  return (
    <section className={styles.root} aria-label="Codebase map">
      <MapHeader overview={overview} onSelectComponent={onSelectCard} selectedId={selection} onHoverComponent={setHoverId} />
      <div className={styles.stage}>
        {layout.cards.length === 0 ? (
          <p className={styles.stageNote} data-map-empty="">
            {scanNote(overview)?.text ?? "No components found"}
          </p>
        ) : null}
        <div
          ref={viewportRef}
          className={styles.viewport}
          data-tv-viewport="map"
          data-pannable=""
          data-tool={tool}
          data-zoom-band="full"
          onClick={onBackgroundClick}
          onScroll={(event) => {
            // overflow: hidden still scrolls on focus; the camera is the only way to move.
            event.currentTarget.scrollLeft = 0;
            event.currentTarget.scrollTop = 0;
          }}
        >
          <div
            ref={worldRef}
            className={styles.world}
            data-tv-world=""
            data-level={level}
            role="group"
            aria-label={`Codebase map, ${layout.cards.length.toLocaleString("en-US")} components`}
            onKeyDown={onKeyDown}
            onFocus={onCardFocus}
            style={{ width: layout.bounds.w, height: layout.bounds.h }}
          >
            {layout.bands.map((band) => (
              <div
                key={`lane:${band.band}`}
                className={styles.lane}
                data-map-lane={band.band}
                aria-hidden="true"
                style={{ left: band.x - MAP_LANE_PAD, top: laneTop, width: band.w + 2 * MAP_LANE_PAD, height: laneHeight }}
              />
            ))}
            {layout.bands.map((band) => (
              <div
                key={band.band}
                className={styles.band}
                data-map-band={band.band}
                aria-hidden="true"
                style={{ left: band.x - 1, top: MAP_MARGIN + 2, height: MAP_BAND_LABEL_H - 14 }}
              >
                <Icon name={BAND_ICON[band.band]} size={14} />
                <span className={styles.bandName}>{BAND_LABEL[band.band]}</span>
                <span className={styles.bandCount}>{band.count.toLocaleString("en-US")}</span>
              </div>
            ))}
            <MapEdges layout={layout} hubs={hubs} activeId={activeId} emphasized={overlay?.emphasizedEdges ?? null} />
            {layout.cards.map((box) => {
              const component = overview.componentById.get(box.id);
              return component === undefined ? null : (
                <MapCard
                  key={box.id}
                  box={box}
                  component={component}
                  level={level}
                  selected={box.id === selection}
                  tabStop={box.id === tabStop}
                  maxFiles={maxFiles}
                  hubImporters={hubs.has(box.id) ? (importers.get(box.id) ?? 0) : null}
                  state={overlay?.cardState.get(box.id) ?? null}
                  onSelect={onSelectCard}
                  onHover={setHoverId}
                />
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
