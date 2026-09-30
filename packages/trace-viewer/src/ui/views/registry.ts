import { CanvasView } from "./canvas/CanvasView.js";
import { HybridView } from "./hybrid/HybridView.js";
import type { ViewDefinition } from "./view-port.js";

export type { ViewDefinition, ViewProps } from "./view-port.js";

/** Switch order: Canvas | Hybrid. The title bar shows the switch only when VIEWS.length > 1 . */
export const VIEWS: readonly ViewDefinition[] = [
  { kind: "canvas", label: "Canvas", icon: "view-canvas", Component: CanvasView },
  { kind: "hybrid", label: "Hybrid", icon: "view-hybrid", Component: HybridView },
];

/** true: hidden views stay mounted under <Activity mode="hidden">; the spike risk 6 ruling sets false (unmount). */
export const KEEP_HIDDEN_VIEWS_MOUNTED = true;
