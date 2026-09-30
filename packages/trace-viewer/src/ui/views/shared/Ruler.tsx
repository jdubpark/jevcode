import { useMemo } from "react";

import type { TimeScale, XMap } from "../../../layout/time-scale.js";
import { rulerLabel, rulerTicks } from "./ruler-ticks.js";
import styles from "./shared.module.css";

export interface RulerProps {
  /** Pass a stable (memoized) map: ticks recompute whenever its identity changes. */
  map: XMap;
  scale: TimeScale;
  widthPx: number;
  /** Display time of loadedThroughSeq while loading; null once loaded. */
  loadedThroughT: number | null;
  className?: string;
}

export function idleLabel(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
  if (minutes >= 1) return `${minutes}m`;
  return `${Math.round(ms / 1_000)}s`;
}

/** One ruler for any XMap (spec §7.4): labels about 120 px apart, none inside breaks, real offsets without "+". */
export function Ruler({ map, scale, widthPx, loadedThroughT, className }: RulerProps) {
  const { ticks, breaks } = useMemo(() => rulerTicks(map, scale, { x0: 0, x1: widthPx }), [map, scale, widthPx]);
  const hatchX = loadedThroughT === null ? null : Math.max(0, Math.min(widthPx, map.xOf(loadedThroughT)));
  return (
    <div className={`${styles.ruler} ${className ?? ""}`} aria-hidden="true" data-testid="ruler">
      {ticks
        .filter((tick) => tick.labeled)
        .map((tick) => (
          <span
            key={tick.tMs}
            data-tick=""
            className={styles.tick}
            style={{ transform: `translateX(${Math.round(tick.x)}px)` }}
          >
            {rulerLabel(tick.tMs)}
          </span>
        ))}
      {breaks.map((mark) => (
        <span
          key={`break:${mark.x0}`}
          className={styles.break}
          style={{ left: mark.x0, width: Math.max(0, mark.x1 - mark.x0) }}
        >
          {`⫽ ${idleLabel(mark.ms)} idle`}
        </span>
      ))}
      {hatchX !== null && hatchX < widthPx ? (
        <span className={styles.hatch} data-testid="ruler-hatch" style={{ left: hatchX, width: widthPx - hatchX }} />
      ) : null}
    </div>
  );
}
