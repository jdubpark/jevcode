import { useMemo, useSyncExternalStore } from "react";
import type React from "react";

import { canvasXMap, type CanvasLayout } from "../../../layout/canvas-layout.js";
import type { TimeScale } from "../../../layout/time-scale.js";
import { Ruler } from "../shared/Ruler.js";
import { rulerTicks } from "../shared/ruler-ticks.js";
import { screenXMap, type CameraStore } from "./canvas-camera.js";
import styles from "./CanvasView.module.css";

export interface CanvasRulerProps {
  layout: CanvasLayout;
  scale: TimeScale;
  cameraStore: CameraStore;
  widthPx: number;
  playheadT: number | null;
  band: readonly [number, number] | null;
  problemTs: readonly number[];
  hatchFromT: number | null;
}

/** Ruler strip height (CanvasView.module.css `.ruler`). */
const RULER_H = 28;

/**
 * The shared Ruler over the canvas column map (spec §7.4), the only place this lane passes Ruler props. Per the W3
 * Ruler ruling the shared Ruler keeps `{ map, scale, widthPx, loadedThroughT }` (hatchFromT is its loadedThroughT) and
 * this adapter draws the minor ticks, the selection band, the critical-finding ticks and the playhead itself.
 */
export function CanvasRuler(props: CanvasRulerProps): React.JSX.Element {
  const camera = useSyncExternalStore(props.cameraStore.subscribe, props.cameraStore.get);
  const world = useMemo(() => canvasXMap(props.layout, props.scale), [props.layout, props.scale]);
  const map = useMemo(() => screenXMap(world, camera), [world, camera]);
  const { widthPx } = props;
  const minor = useMemo(() => {
    let d = "";
    for (const tick of rulerTicks(map, props.scale, { x0: 0, x1: widthPx }).ticks) {
      const x = Math.round(tick.x) + 0.5;
      d += tick.labeled ? `M${x} 17V${RULER_H - 4}` : `M${x} 20V${RULER_H - 4}`;
    }
    return d;
  }, [map, props.scale, widthPx]);
  const inside = (x: number): boolean => x >= -2 && x <= widthPx + 2;
  const band = props.band === null ? null : ([map.xOf(props.band[0]), map.xOf(props.band[1])] as const);
  const playheadX = props.playheadT === null ? null : map.xOf(props.playheadT);
  return (
    <div className={styles.rulerInner}>
      {band !== null && band[1] >= 0 && band[0] <= widthPx ? (
        <div
          className={styles.rulerBand}
          data-ruler-band=""
          style={{ left: Math.max(0, band[0]), width: Math.max(1, Math.min(widthPx, band[1]) - Math.max(0, band[0])) }}
        />
      ) : null}
      <Ruler map={map} scale={props.scale} widthPx={widthPx} loadedThroughT={props.hatchFromT} className={styles.rulerLabels} />
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
