import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { overviewPreset } from "../../../layout/overview-layout.js";
import type { SelectionId } from "../../../layout/trace-index.js";
import { fitRange, uToScreenX, type XOnlyCamera } from "../../../layout/viewport.js";
import type { Level } from "../../../model/index.js";
import { useSessionView } from "../../shell/session-context.js";
import { ZOOM_STEP } from "../../state/keymap.js";
import { useDispatch, useView, useViewStore } from "../../state/store.js";
import { selectEffectivePlayheadSeq } from "../../state/view-state.js";
import { useRegisterViewPort, useViewPortRegistry, type ViewPort, type ViewProps } from "../view-port.js";
import { HYBRID_PRESETS, hybridReadingOrder, isLevel, zoomReadout } from "./hybrid-port.js";
import styles from "./HybridView.module.css";
import { Overview, type OverviewApi } from "./overview/Overview.js";
import { FindingBody } from "./spine/findings/FindingBody.js";
import { FindingBodyContext, Spine, type SpineApi } from "./spine/Spine.js";

/** Overview over spine: composes both, owns the view's ViewPort and the level-preset wiring (spec §7.6). */
export function HybridView({ active }: ViewProps) {
  const store = useViewStore();
  const dispatch = useDispatch();
  const registry = useViewPortRegistry();
  const { session, index, scale } = useSessionView();
  const level = useView((state) => state.level);
  const loaded = useView((state) => state.loaded);
  const overviewApi = useRef<OverviewApi | null>(null);
  const spineApi = useRef<SpineApi | null>(null);
  const anchor = useRef<{ key: string; offsetPx: number } | null>(null);
  const [spineWindow, setSpineWindow] = useState<{ t0: number; t1: number } | null>(null);
  const moveToken = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const live = useRef({ session, index, scale });
  live.current = { session, index, scale };

  const presetFor = useCallback(
    (forLevel: Level) => {
      const api = overviewApi.current;
      const model = api?.overview() ?? null;
      const { session: current, index: currentIndex, scale: currentScale } = live.current;
      if (api === null || model === null || current === null || api.widthPx() <= 0) return null;
      const state = store.get();
      return overviewPreset({
        level: forLevel,
        overview: model,
        index: currentIndex,
        scale: currentScale,
        widthPx: api.widthPx(),
        playheadSeq: selectEffectivePlayheadSeq(state, currentIndex),
        live: state.follow,
      });
    },
    [store],
  );

  // The title bar's zoom readout divides by the same preset k as the overview toolbar (spec §7.1, §7.6.1): the
  // preset is recomputed only when the level, the overview model or the width changes, never when only the playhead
  // moves, so moving the selection is not read as a zoom.
  const presetK = useRef<{ level: Level; model: unknown; widthPx: number; k: number | null } | null>(null);
  const presetKFor = useCallback(
    (forLevel: Level): number | null => {
      const api = overviewApi.current;
      const model = api?.overview() ?? null;
      const widthPx = api?.widthPx() ?? 0;
      const cached = presetK.current;
      if (cached !== null && cached.level === forLevel && cached.model === model && cached.widthPx === widthPx) return cached.k;
      const k = presetFor(forLevel)?.camera.k ?? null;
      presetK.current = { level: forLevel, model, widthPx, k };
      return k;
    },
    [presetFor],
  );

  // A zoom key is a camera gesture: it leaves Live (spec §7.10).
  const leaveLive = useCallback((): void => {
    if (store.get().follow) dispatch({ type: "follow/set", follow: false });
  }, [store, dispatch]);

  const onSettle = useCallback(
    (camera: XOnlyCamera): void => {
      dispatch({ type: "camera/sync", view: "hybrid", camera: { mode: "xOnly", u0: camera.u0, k: camera.k, spineAnchor: anchor.current } });
      registry.notify();
    },
    [dispatch, registry],
  );

  const moveAndSettle = useCallback(
    (camera: XOnlyCamera, animate: boolean): void => {
      const api = overviewApi.current;
      if (api === null) return;
      const token = (moveToken.current += 1);
      void api.moveTo(camera, animate).then(() => {
        // A superseded move (a newer one started) or a hidden view never writes the camera store.
        if (token !== moveToken.current || !activeRef.current) return;
        const settled = overviewApi.current?.camera();
        if (settled !== null && settled !== undefined) onSettle(settled);
      });
    },
    [onSettle],
  );

  const zoomAroundPlayhead = useCallback(
    (factor: number): void => {
      const api = overviewApi.current;
      const controller = api?.controller() ?? null;
      const camera = api?.camera() ?? null;
      const { session: current, index: currentIndex, scale: currentScale } = live.current;
      if (api === null || controller === null || camera === null || current === null) return;
      leaveLive();
      const step = current.steps[Math.max(0, currentIndex.stepIndexAtOrBefore(selectEffectivePlayheadSeq(store.get(), currentIndex)))];
      const x = step === undefined ? api.widthPx() / 2 : Math.min(api.widthPx(), Math.max(0, uToScreenX(camera, currentScale.toU(step.tMs))));
      controller.zoomBy(factor, { x, y: 0 });
    },
    [store, leaveLive],
  );

  const port = useMemo<ViewPort>(
    () => ({
      readingOrder: () => {
        const current = live.current.session;
        return current === null ? [] : hybridReadingOrder(spineApi.current?.rows() ?? [], current);
      },
      reveal: (id: SelectionId, options: { animate: boolean }) => {
        const entry = live.current.index.entry(id);
        if (entry === undefined) return;
        spineApi.current?.revealSeq(entry.firstSeq, "auto");
        const api = overviewApi.current;
        const camera = api?.camera() ?? null;
        if (api === null || camera === null) return;
        const u = live.current.scale.toU(entry.t0);
        const x = uToScreenX(camera, u);
        // Pan only when the step lies off screen; never zoom.
        if (x < 0 || x > api.widthPx()) {
          moveAndSettle({ mode: "xOnly", u0: u - api.widthPx() / 2 / camera.k, k: camera.k }, options.animate);
        }
      },
      captureCamera: () => {
        const camera = overviewApi.current?.camera() ?? null;
        return camera === null
          ? null
          : { mode: "xOnly", u0: camera.u0, k: camera.k, spineAnchor: anchor.current, syncedRev: store.get().focusRev };
      },
      focusSelected: () => {
        const selection = store.get().selection;
        if (selection !== null) spineApi.current?.focusRow(selection);
      },
      zoom: {
        label: () => zoomReadout(overviewApi.current?.camera() ?? null, presetKFor(store.get().level), store.get().level),
        presets: () => HYBRID_PRESETS,
        applyPreset: (id: string) => {
          if (isLevel(id)) dispatch({ type: "level/set", level: id, by: "hybrid" });
        },
        zoomIn: () => zoomAroundPlayhead(ZOOM_STEP),
        zoomOut: () => zoomAroundPlayhead(1 / ZOOM_STEP),
        resetToPreset: () => {
          const preset = presetFor(store.get().level);
          if (preset === null) return;
          leaveLive();
          moveAndSettle(preset.camera, true);
        },
        fitAll: () => {
          const api = overviewApi.current;
          if (api === null) return;
          leaveLive();
          moveAndSettle(fitRange(0, Math.max(1, live.current.scale.endU), api.widthPx(), { padFraction: 0.04, limits: api.limits() }), true);
        },
        fitSelection: () => {
          const api = overviewApi.current;
          const selection = store.get().selection;
          const entry = selection === null ? undefined : live.current.index.entry(selection);
          if (api === null || entry === undefined) return;
          leaveLive();
          const u0 = live.current.scale.toU(entry.t0);
          const u1 = Math.max(u0 + 1, live.current.scale.toU(entry.t1));
          moveAndSettle(fitRange(u0, u1, api.widthPx(), { padFraction: 0.2, limits: api.limits() }), true);
        },
      },
    }),
    [store, dispatch, presetFor, presetKFor, zoomAroundPlayhead, leaveLive, moveAndSettle],
  );
  useRegisterViewPort("hybrid", port);

  // Picking a level applies its preset camera and brush (spec §7.6.1); continuous zoom leaves the level alone.
  // Compared against the level last applied (not last seen), so a change made while hidden lands on activation.
  const appliedLevel = useRef(level);
  useEffect(() => {
    if (appliedLevel.current === level || !active) return;
    const preset = presetFor(level);
    if (preset === null) return;
    appliedLevel.current = level;
    dispatch({ type: "brush/set", brush: preset.brush, by: "hybrid" });
    moveAndSettle(preset.camera, true);
  }, [level, active, presetFor, dispatch, moveAndSettle]);

  // After that remount the overview measures its width and places its camera a frame or two later; the title bar
  // rendered before then, so tell it once the new camera exists.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const view = rootRef.current?.ownerDocument.defaultView ?? null;
    if (!loaded || !active || view === null) return undefined;
    let frames = 0;
    let id = 0;
    const check = (): void => {
      frames += 1;
      if (overviewApi.current?.camera() != null) registry.notify();
      else if (frames < 30) id = view.requestAnimationFrame(check);
    };
    id = view.requestAnimationFrame(check);
    return () => view.cancelAnimationFrame(id);
  }, [loaded, active, registry]);

  const onAnchor = useCallback((next: { key: string; offsetPx: number } | null): void => {
    anchor.current = next;
  }, []);

  return (
    <div ref={rootRef} className={styles.hybrid}>
      {/* The overview places its first camera at the level preset for the playhead it sees. The open defaults (spec
          §7.8) move the playhead to the initial selection only once loading ends, after that first camera; one remount
          at that moment gives the camera and both zoom readouts the preset of the initial selection. */}
      <Overview key={loaded ? "loaded" : "loading"} active={active} apiRef={overviewApi} spineWindow={spineWindow} onSettle={onSettle} />
      <FindingBodyContext.Provider value={FindingBody}>
        <Spine active={active} apiRef={spineApi} onWindow={setSpineWindow} onAnchor={onAnchor} />
      </FindingBodyContext.Provider>
    </div>
  );
}
