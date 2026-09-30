import type { SpineRow } from "../../../layout/spine-rows.js";
import type { SelectionId } from "../../../layout/trace-index.js";
import type { XOnlyCamera } from "../../../layout/viewport.js";
import { LEVELS, type Level, type TraceSession } from "../../../model/index.js";
import { LEVEL_LABEL } from "../shared/LevelControl.js";
import type { ZoomPreset } from "../view-port.js";

export const HYBRID_PRESETS: readonly ZoomPreset[] = LEVELS.map((level) => ({ id: level, label: LEVEL_LABEL[level] }));

export function isLevel(id: string): id is Level {
  return (LEVELS as readonly string[]).includes(id);
}

/** The spine's step keys in order; Session-level chapter rows contribute their unit id. */
export function hybridReadingOrder(rows: readonly SpineRow[], session: TraceSession): SelectionId[] {
  const order: SelectionId[] = [];
  for (const row of rows) {
    if (row.t === "step") order.push(row.key);
    else if (row.t === "chapter") {
      const chapter = session.chapters[row.chapter];
      if (chapter !== undefined) order.push(chapter.id);
    }
  }
  return order;
}

/** The level name at its preset k (±0.5%), else "150%" etc. */
export function zoomReadout(camera: XOnlyCamera | null, presetK: number | null, level: Level): string {
  if (camera === null || presetK === null || presetK <= 0) return LEVEL_LABEL[level];
  const ratio = camera.k / presetK;
  return Math.abs(ratio - 1) < 0.005 ? LEVEL_LABEL[level] : `${Math.round(ratio * 100)}%`;
}
