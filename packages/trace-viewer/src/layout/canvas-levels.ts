import type { Level, Step } from "../model/index.js";

/** Story band: intent, instruction, plan, decision, claim. Work band: chapter, noise, loose. */
export type CanvasItemKind =
  | "intent"
  | "instruction"
  | "plan"
  | "decision"
  | "claim"
  | "chapter"
  | "noise"
  | "loose";

export interface LevelSpec {
  level: Level;
  w: number;
  h: { story: number; chapter: number; noise: number; loose: number };
  /** 22 at Chapter and Step, 0 at Session (chips). */
  labelH: number;
  storyCap: number;
  rMax: number;
  colGap: number;
  turnGap: number;
  breakGap: number;
  rowGap: number;
  channelH: number;
  channelLanes: number;
  railLanes: number;
  pps: number;
  slack: number;
  breakMinMs: number;
  minZoom: number;
  maxZoom: number;
  /** Derived: w + colGap; storyCap·(h.story + rowGap) − rowGap; storyBand + channelH. */
  pitch: number;
  storyBand: number;
  workTop: number;
}

type LevelBase = Omit<LevelSpec, "pitch" | "storyBand" | "workTop">;

function derive(base: LevelBase): LevelSpec {
  const storyBand = base.storyCap * (base.h.story + base.rowGap) - base.rowGap;
  return { ...base, pitch: base.w + base.colGap, storyBand, workTop: storyBand + base.channelH };
}

/** Spec §7.5 level table. World px at zoom 1; each slot includes its label row. */
export const LEVEL_SPECS: { readonly [L in Level]: LevelSpec } = {
  session: derive({
    level: "session",
    w: 168,
    h: { story: 28, chapter: 28, noise: 28, loose: 28 },
    labelH: 0,
    storyCap: 3,
    rMax: 12,
    colGap: 24,
    turnGap: 48,
    breakGap: 40,
    rowGap: 8,
    channelH: 16,
    channelLanes: 2,
    railLanes: 1,
    pps: 0.5,
    slack: 32,
    breakMinMs: 300_000,
    minZoom: 0.25,
    maxZoom: 2,
  }),
  chapter: derive({
    level: "chapter",
    w: 224,
    h: { story: 118, chapter: 134, noise: 58, loose: 66 },
    labelH: 22,
    storyCap: 1,
    rMax: 4,
    colGap: 40,
    turnGap: 72,
    breakGap: 64,
    rowGap: 16,
    channelH: 32,
    channelLanes: 4,
    railLanes: 3,
    pps: 8,
    slack: 64,
    breakMinMs: 60_000,
    minZoom: 0.2,
    maxZoom: 2,
  }),
  step: derive({
    level: "step",
    w: 320,
    h: { story: 118, chapter: 294, noise: 58, loose: 66 },
    labelH: 22,
    storyCap: 1,
    rMax: 3,
    colGap: 48,
    turnGap: 80,
    breakGap: 72,
    rowGap: 16,
    channelH: 32,
    channelLanes: 4,
    railLanes: 3,
    pps: 8,
    slack: 64,
    breakMinMs: 60_000,
    minZoom: 0.2,
    maxZoom: 2,
  }),
};

/** Label row height inside the slot's labelH (the remaining 6 px is the gap above the card). */
export const LABEL_ROW_PX = 16;
/** Step level: a fixed list of nine 24 px rows under a 56 px header (294 = 22 + 56 + 9 · 24). */
export const STEP_LIST_ROWS = 9;
export const STEP_ROW_PX = 24;
/** Below GRAPHIC_MIN_K cards hide their mini graphic; below ICON_ONLY_K only icon and state fill show. */
export const GRAPHIC_MIN_K = 0.5;
export const ICON_ONLY_K = 0.35;

const STORY_KINDS: ReadonlySet<CanvasItemKind> = new Set<CanvasItemKind>([
  "intent",
  "instruction",
  "plan",
  "decision",
  "claim",
]);

export function isStoryKind(kind: CanvasItemKind): boolean {
  return STORY_KINDS.has(kind);
}

/** P10: a frame's size depends only on (level, kind), so content growth never moves a neighbor. */
export function frameSize(level: Level, kind: CanvasItemKind): { w: number; h: number } {
  const spec = LEVEL_SPECS[level];
  if (isStoryKind(kind)) return { w: spec.w, h: spec.h.story };
  if (kind === "chapter") return { w: spec.w, h: spec.h.chapter };
  if (kind === "noise") return { w: spec.w, h: spec.h.noise };
  return { w: spec.w, h: spec.h.loose };
}

/**
 * Finds a step by id through its firstSeq (StepId is step:<firstSeq>, and the model sorts steps by seq),
 * so canvas modules need no 5,000-entry Map per layout run. Sorts a copy only when the list is out of order.
 */
export function stepFinder(steps: readonly Step[]): (id: string) => Step | undefined {
  let sorted = steps;
  for (let i = 1; i < steps.length; i += 1) {
    if ((steps[i - 1]?.firstSeq ?? 0) > (steps[i]?.firstSeq ?? 0)) {
      sorted = [...steps].sort((a, b) => a.firstSeq - b.firstSeq);
      break;
    }
  }
  return (id) => {
    if (!id.startsWith("step:")) return undefined;
    const seq = Number(id.slice("step:".length));
    let lo = 0;
    let hi = sorted.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const step = sorted[mid];
      if (step === undefined) return undefined;
      if (step.firstSeq === seq) return step;
      if (step.firstSeq < seq) lo = mid + 1;
      else hi = mid - 1;
    }
    return undefined;
  };
}
