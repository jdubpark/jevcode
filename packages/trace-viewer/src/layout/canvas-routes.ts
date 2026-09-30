import type { FindingId, TraceSession } from "../model/index.js";
import type { CanvasColumn, CanvasFrame } from "./canvas-layout.js";
import type { LevelSpec } from "./canvas-levels.js";
import type { Point } from "./viewport.js";

export type EdgeKind = "trunk" | "contradicts" | "decides" | "validates";
export type EdgeShape = "comb" | "stacked" | "adjacent" | "rail" | "channel" | "direct";

export interface CanvasEdge {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  shape: EdgeShape;
  lane: number | null;
  /** SVG path in world px; null when no lane is free (drawn only for the selection via directPath). */
  d: string | null;
  rest: boolean;
  tone: "bad" | "neutral";
  /** contradicts: ≠ badge position. */
  badge: Point | null;
  findingId: FindingId | null;
}

export interface RouteInput {
  session: TraceSession;
  frames: readonly CanvasFrame[];
  frameByKey: ReadonlyMap<string, CanvasFrame>;
  columns: readonly CanvasColumn[];
  spec: LevelSpec;
}
