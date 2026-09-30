import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type React from "react";

import { canvasXMap, type CanvasLayout } from "../../../layout/canvas-layout.js";
import type { TimeScale, XMap } from "../../../layout/time-scale.js";
import type { UniformCamera } from "../../../layout/viewport.js";
import { Ruler } from "../shared/Ruler.js";
import { rulerTicks } from "../shared/ruler-ticks.js";
import { screenXMap, type CameraStore } from "./canvas-camera.js";
import styles from "./CanvasView.module.css";

export interface CanvasRulerProps {
  layout: CanvasLayout;
  scale: TimeScale;
  cameraStore: CameraStore;
  /**
   * The camera the ruler's ticks are laid out for: the view's mounted (cull) camera, which changes at settle and when
   * a long pan leaves the mounted range. The strip covers one viewport width either side of it.
   */
  base: UniformCamera;
  widthPx: number;
  playheadT: number | null;
  band: readonly [number, number] | null;
  problemTs: readonly number[];
  hatchFromT: number | null;
}

/** Ruler strip height (CanvasView.module.css `.ruler`). */
const RULER_H = 28;

/** `map` moved right by `dx` px: the shared Ruler lays ticks out over [0, widthPx] only. */
function shifted(map: XMap, dx: number): XMap {
  return { xOf: (t) => map.xOf(t) + dx, tOf: (x) => map.tOf(x - dx) };
}

/**
 * The shared Ruler over the canvas column map (spec §7.4), the only place this lane passes Ruler props. Per the W3
 * Ruler ruling the shared Ruler keeps `{ map, scale, widthPx, loadedThroughT }` (hatchFromT is its loadedThroughT) and
 * this adapter draws the minor ticks, the selection band, the critical-finding ticks and the playhead itself.
 *
 * Ticks are laid out once per base camera over three viewport widths (C3-10 review M6). A camera frame at the base's
 * zoom only translates the strip through a ref, with no React render; a frame at another zoom (a pinch in progress)
 * lays the ticks out for that camera.
 */
export function CanvasRuler(props: CanvasRulerProps): React.JSX.Element {
  const { layout, scale, cameraStore, base, widthPx } = props;
  // The live camera while its k differs from the base's, else null (a stable snapshot: pans cause no render). A
  // store snapshot re-renders in the same frame as the camera write, so ticks never lag the world during a pinch.
  const getZoomed = useCallback((): UniformCamera | null => {
    const live = cameraStore.get();
    return live.k === base.k ? null : live;
  }, [cameraStore, base]);
  const zoomed = useSyncExternalStore(cameraStore.subscribe, getZoomed);
  const camera = zoomed ?? base;
  const innerRef = useRef<HTMLDivElement | null>(null);
  const world = useMemo(() => canvasXMap(layout, scale), [layout, scale]);
  const map = useMemo(() => screenXMap(world, camera), [world, camera]);
  const labelMap = useMemo(() => shifted(map, widthPx), [map, widthPx]);
  const minor = useMemo(() => {
    let d = "";
    for (const tick of rulerTicks(map, scale, { x0: -widthPx, x1: 2 * widthPx }).ticks) {
      const x = Math.round(tick.x) + 0.5;
      d += tick.labeled ? `M${x} 17V${RULER_H - 4}` : `M${x} 20V${RULER_H - 4}`;
    }
    return d;
  }, [map, scale, widthPx]);

  // A camera frame at the laid-out zoom only translates the strip.
  useLayoutEffect(() => {
    const apply = (): void => {
      const live = cameraStore.get();
      const inner = innerRef.current;
      if (inner !== null && live.k === camera.k) inner.style.transform = `translateX(${live.tx - camera.tx}px)`;
    };
    apply();
    return cameraStore.subscribe(apply);
  }, [cameraStore, camera]);

  const inside = (x: number): boolean => x >= -widthPx && x <= 2 * widthPx;
  const band = props.band === null ? null : ([map.xOf(props.band[0]), map.xOf(props.band[1])] as const);
  const playheadX = props.playheadT === null ? null : map.xOf(props.playheadT);
  return (
    <div ref={innerRef} className={styles.rulerInner}>
      {band !== null && band[1] >= -widthPx && band[0] <= 2 * widthPx ? (
        <div
          className={styles.rulerBand}
          data-ruler-band=""
          style={{
            left: Math.max(-widthPx, band[0]),
            width: Math.max(1, Math.min(2 * widthPx, band[1]) - Math.max(-widthPx, band[0])),
          }}
        />
      ) : null}
      <div className={styles.rulerSpan} style={{ left: -widthPx, width: 3 * widthPx }}>
        <Ruler map={labelMap} scale={scale} widthPx={3 * widthPx} loadedThroughT={props.hatchFromT} className={styles.rulerLabels} />
      </div>
      <svg className={styles.rulerMarks} width={widthPx} height={RULER_H} aria-hidden="true">
        <path className={styles.rulerMinor} d={minor} />
        {props.problemTs.map((t, index) => {
          const x = map.xOf(t);
          // Red marks differ in shape too (spec §7.12): a full-height 2 px bar, never a 1 px tick.
          return inside(x) ? (
            <rect key={index} data-ruler-problem="" className={styles.rulerProblem} x={Math.round(x) - 1} y={12} width={2} height={RULER_H - 14} />
          ) : null;
        })}
        {playheadX !== null && inside(playheadX) ? (
          <rect data-ruler-playhead="" className={styles.rulerPlayhead} x={Math.round(playheadX) - 1} y={0} width={2} height={RULER_H} />
        ) : null}
      </svg>
    </div>
  );
}
