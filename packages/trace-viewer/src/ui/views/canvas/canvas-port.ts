import type { CanvasFrame, CanvasLayout } from "../../../layout/canvas-layout.js";
import { LEVEL_SPECS } from "../../../layout/canvas-levels.js";
import { homeFrameKey, type RouteInput } from "../../../layout/canvas-routes.js";
import type { SelectionId } from "../../../layout/trace-index.js";
import type { UniformCamera } from "../../../layout/viewport.js";
import type { StepId, TraceSession } from "../../../model/index.js";
import { ZOOM_STEP } from "../../state/keymap.js";
import type { CanvasCamera } from "../../state/view-state.js";
import type { ViewPort, ZoomPreset } from "../view-port.js";

export function routeInputOf(layout: CanvasLayout, session: TraceSession): RouteInput {
  return {
    session,
    frames: layout.frames,
    frameByKey: layout.frameByKey,
    columns: layout.columns,
    spec: LEVEL_SPECS[layout.level],
  };
}

export function frameForSelection(layout: CanvasLayout, session: TraceSession, id: SelectionId): CanvasFrame | undefined {
  for (const frame of layout.frames) if (frame.memberSelIds.includes(id)) return frame;
  if (!id.startsWith("step:")) return undefined;
  const key = homeFrameKey(id as StepId, routeInputOf(layout, session));
  return key === undefined ? undefined : layout.frameByKey.get(key);
}

export function tailFrame(layout: CanvasLayout, session: TraceSession): CanvasFrame | undefined {
  const bySel = new Map<string, CanvasFrame>();
  for (const frame of layout.frames) {
    for (const selId of frame.memberSelIds) if (!bySel.has(selId)) bySel.set(selId, frame);
  }
  for (let i = session.steps.length - 1; i >= 0; i -= 1) {
    const step = session.steps[i];
    if (step === undefined) continue;
    const direct = bySel.get(step.id);
    if (direct !== undefined) return direct;
    for (const chapterId of step.chapterIds) {
      const frame = bySel.get(chapterId);
      if (frame !== undefined) return frame;
    }
  }
  return undefined;
}

export function canvasReadingOrder(
  layout: CanvasLayout,
  session: TraceSession,
  expanded: ReadonlySet<string>,
): SelectionId[] {
  const chapterById = new Map(session.chapters.map((chapter) => [chapter.id, chapter]));
  const out: SelectionId[] = [];
  const seen = new Set<SelectionId>();
  const push = (id: SelectionId): void => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const frame of layout.frames) {
    for (const selId of frame.memberSelIds) push(selId);
    if (frame.kind === "chapter" && (expanded.has(frame.key) || expanded.has(frame.selId))) {
      for (const stepId of chapterById.get(frame.selId as `unit:${string}`)?.stepIds ?? []) push(stepId);
    }
  }
  return out;
}

export const CANVAS_ZOOM_PRESETS: readonly ZoomPreset[] = [
  { id: "50", label: "50%" },
  { id: "100", label: "100%" },
  { id: "200", label: "200%" },
];

export function zoomLabel(k: number): string {
  return `${Math.round(k * 100)}%`;
}

export interface CanvasPortDeps {
  readingOrder(): readonly SelectionId[];
  reveal(id: SelectionId, animate: boolean): void;
  captureCamera(): CanvasCamera | null;
  focusSelected(): void;
  camera(): UniformCamera;
  zoomAround(factor: number): void;
  zoomTo(k: number): void;
  fitAll(): void;
  fitSelection(): void;
}

/** The Canvas registration with the shell (UI index §2.4 ViewPort). */
export function createCanvasPort(deps: CanvasPortDeps): ViewPort {
  return {
    readingOrder: () => deps.readingOrder(),
    reveal: (id, options) => deps.reveal(id, options.animate),
    captureCamera: () => deps.captureCamera(),
    focusSelected: () => deps.focusSelected(),
    zoom: {
      label: () => zoomLabel(deps.camera().k),
      presets: () => CANVAS_ZOOM_PRESETS,
      applyPreset: (id) => {
        const k = Number(id) / 100;
        if (Number.isFinite(k) && k > 0) deps.zoomTo(k);
      },
      zoomIn: () => deps.zoomAround(ZOOM_STEP),
      zoomOut: () => deps.zoomAround(1 / ZOOM_STEP),
      resetToPreset: () => deps.zoomTo(1),
      fitAll: () => deps.fitAll(),
      fitSelection: () => deps.fitSelection(),
    },
  };
}
