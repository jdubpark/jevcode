import type { Finding, FindingId, Level, Step, TraceSession, Turn } from "../model/index.js";
import { routeEdges, type CanvasEdge } from "./canvas-routes.js";
import {
  LABEL_ROW_PX,
  LEVEL_SPECS,
  frameSize,
  isStoryKind,
  stepFinder,
  type CanvasItemKind,
  type LevelSpec,
} from "./canvas-levels.js";
import type { TimeScale, XMap } from "./time-scale.js";
import { worstSeverity } from "./tone.js";
import type { SelectionId, TraceIndex } from "./trace-index.js";
import type { Point, Rect } from "./viewport.js";

/** codex-adapter.ts:289 resumes a turn with this prompt; such a turn adds no story frame. */
export const RESUME_DEFAULT_PROMPT = "Continue the task.";

export interface CanvasItem {
  key: string;
  selId: SelectionId;
  kind: CanvasItemKind;
  band: "story" | "work";
  /** Display clock (Step.tMs or Chapter.tMs). */
  start: number;
  end: number;
  anchorSeq: number;
  turn: number;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Index of the last turn whose tMs ≤ t (turns are in seq order, so tMs is non-decreasing). */
function turnLocator(turns: readonly Turn[]): (t: number) => number {
  return (t) => {
    let lo = 0;
    let hi = turns.length - 1;
    let found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const turn = turns[mid];
      if (turn !== undefined && turn.tMs <= t) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return turns[found]?.index ?? 0;
  };
}

/** Equal keys keep the first (by selection id) and suffix the rest with .1, .2, … */
function disambiguate(items: CanvasItem[]): CanvasItem[] {
  const groups = new Map<string, CanvasItem[]>();
  for (const item of items) {
    const group = groups.get(item.key);
    if (group === undefined) groups.set(item.key, [item]);
    else group.push(item);
  }
  const out: CanvasItem[] = [];
  for (const [key, group] of groups) {
    group.sort((a, b) => compareText(a.selId, b.selId) || compareText(a.kind, b.kind));
    group.forEach((item, index) => out.push(index === 0 ? item : { ...item, key: `${key}.${index}` }));
  }
  return out;
}

function compareItems(a: CanvasItem, b: CanvasItem): number {
  return a.start - b.start || a.anchorSeq - b.anchorSeq || compareText(a.key, b.key);
}

/** Spec §7.5 "Items": story items per turn, decisions, current chapters and loose finding steps. */
export function collectItems(session: TraceSession, index: TraceIndex): CanvasItem[] {
  const stepOf = stepFinder(session.steps);
  const findingsById = new Map<FindingId, Finding>(session.findings.map((finding) => [finding.id, finding]));
  const currentChapters = new Set<string>(
    session.chapters.filter((chapter) => chapter.current).map((chapter) => chapter.id),
  );
  const turnAt = turnLocator(session.turns);
  const stepContaining = (seq: number): Step | undefined => {
    const at = index.stepIndexAtOrBefore(seq);
    const step = session.steps[at];
    if (step !== undefined && step.seqs.includes(seq)) return step;
    return session.steps.find((candidate) => candidate.seqs.includes(seq));
  };
  const firstStepOf = (turn: Turn): Step | undefined => {
    for (const id of turn.stepIds) {
      const step = stepOf(id);
      if (step !== undefined) return step;
    }
    return undefined;
  };
  const items: CanvasItem[] = [];
  const storySteps = new Set<string>();

  const story = (kind: CanvasItemKind, key: string, step: Step, start: number, anchorSeq: number): void => {
    storySteps.add(step.id);
    items.push({
      key,
      selId: step.id,
      kind,
      band: "story",
      start,
      end: Math.max(start, step.endTMs ?? step.tMs),
      anchorSeq,
      turn: turnAt(start),
    });
  };

  for (const turn of session.turns) {
    const resumeDefault = turn.trigger === "resume" && turn.prompt.trim() === RESUME_DEFAULT_PROMPT;
    // Spec §7.5: the opener is the step whose seqs include turn.startSeq. A queued instruction or a
    // decision relaunch opens a turn without being in turn.stepIds. A decision opener adds no instruction
    // item (the decision item covers it). Fallback when no step holds startSeq: the turn's first step.
    const opener = stepContaining(turn.startSeq) ?? firstStepOf(turn);
    if (!resumeDefault && opener !== undefined && opener.kind !== "decision") {
      story(turn.index === 0 ? "intent" : "instruction", `turn:${turn.startSeq}`, opener, opener.tMs, turn.startSeq);
    }
    const plan = turn.planStepId === undefined ? undefined : stepOf(turn.planStepId);
    if (plan !== undefined) story("plan", `plan:${plan.firstSeq}`, plan, plan.tMs, plan.firstSeq);
    const claim = turn.claimStepId === undefined ? undefined : stepOf(turn.claimStepId);
    if (claim !== undefined) story("claim", `claim:${claim.firstSeq}`, claim, claim.tMs, claim.firstSeq);
  }

  for (const step of session.steps) {
    if (step.kind !== "decision") continue;
    story("decision", `decision:${step.target ?? String(step.firstSeq)}`, step, step.tMs, step.firstSeq);
  }

  for (const chapter of session.chapters) {
    if (!chapter.current) continue;
    const key = index.chapterKey(chapter.id);
    if (key === undefined) continue;
    const own = chapter.stepIds.flatMap((id) => stepOf(id)?.firstSeq ?? []);
    const seqs = [...chapter.factSeqs, ...own];
    // Same rule as trace-index: min over factSeqs and step firstSeqs (spec §7.5).
    const anchorSeq = seqs.length > 0 ? Math.min(...seqs) : chapter.firstSeq;
    const flagged =
      chapter.findingIds.length > 0 ||
      chapter.stepIds.some((id) => (stepOf(id)?.findingIds.length ?? 0) > 0);
    items.push({
      key,
      selId: chapter.id,
      kind: chapter.noise && !flagged ? "noise" : "chapter",
      band: "work",
      start: chapter.tMs,
      end: Math.max(chapter.tMs, chapter.endTMs),
      anchorSeq,
      turn: turnAt(chapter.tMs),
    });
  }

  for (const step of session.steps) {
    if (step.findingIds.length === 0 || storySteps.has(step.id)) continue;
    if (step.chapterIds.some((id) => currentChapters.has(id))) continue;
    const severity = worstSeverity(step, findingsById);
    if (severity !== "warning" && severity !== "critical") continue;
    items.push({
      key: `step:${step.firstSeq}`,
      selId: step.id,
      kind: "loose",
      band: "work",
      start: step.tMs,
      end: Math.max(step.tMs, step.endTMs ?? step.tMs),
      anchorSeq: step.firstSeq,
      turn: turnAt(step.tMs),
    });
  }

  return disambiguate(items).sort(compareItems);
}

// ------------------------------------------------------------ public layout types

export interface CanvasFrame {
  key: string;
  selId: SelectionId;
  kind: "story" | "chapter" | "noise" | "loose";
  item: CanvasItemKind;
  col: number;
  row: number;
  slot: Rect;
  card: Rect;
  label: Rect | null;
  /** Noise stack members (item keys); [key] otherwise. */
  members: readonly string[];
  /** Selection ids of `members`, same order. */
  memberSelIds: readonly SelectionId[];
  late: boolean;
}

export interface CanvasColumn {
  key: string;
  index: number;
  x: number;
  t0: number;
  turn: number;
}

export interface CanvasSeparator {
  kind: "turn" | "break";
  x: number;
  t: number;
  turn: number;
  label: string;
}

export interface TimeBreakpoint {
  t: number;
  xIn: number;
  xOut: number;
}

export interface CanvasLayoutStats {
  late: number;
  rMaxExceeded: number;
  holes: number;
  hiddenEdges: number;
}

declare const layoutStateBrand: unique symbol;
export interface CanvasLayoutState {
  readonly [layoutStateBrand]: true;
}

export interface CanvasLayout {
  level: Level;
  sessionId: string;
  frames: readonly CanvasFrame[];
  frameByKey: ReadonlyMap<string, CanvasFrame>;
  holes: readonly Rect[];
  columns: readonly CanvasColumn[];
  separators: readonly CanvasSeparator[];
  edges: readonly CanvasEdge[];
  junctions: readonly Point[];
  time: { bps: readonly TimeBreakpoint[]; pps: number };
  bounds: Rect;
  /** Columns left → right; story cells, then work rows top → bottom. */
  readingOrder: readonly SelectionId[];
  stats: CanvasLayoutStats;
  state: CanvasLayoutState;
}

// ------------------------------------------------------------ opaque sticky state (plain data, deep-equal friendly)

interface Slot {
  id: string;
  stack: boolean;
  band: "story" | "work";
  placedAs: CanvasItemKind;
  col: number;
  row: number;
  x: number;
  y: number;
  w: number;
  h: number;
  members: string[];
  late: boolean;
}

interface ColumnState {
  key: string;
  index: number;
  x: number;
  t0: number;
  turn: number;
  story: number;
  workY: number;
  workRows: number;
  noiseSlot: string | null;
}

interface SeparatorState {
  kind: "turn" | "break";
  x: number;
  t: number;
  turn: number;
  idleMs: number;
}

interface StateData {
  level: Level;
  sessionId: string;
  cols: ColumnState[];
  slots: Slot[];
  /** Item key → slot id. */
  memberSlot: Record<string, string>;
  bps: TimeBreakpoint[];
  seps: SeparatorState[];
  rMaxExceeded: number;
}

function packState(data: StateData): CanvasLayoutState {
  return data as unknown as CanvasLayoutState;
}

function unpackState(state: CanvasLayoutState): StateData {
  return state as unknown as StateData;
}

function emptyState(level: Level, sessionId: string): StateData {
  return { level, sessionId, cols: [], slots: [], memberSlot: {}, bps: [], seps: [], rMaxExceeded: 0 };
}

function cloneState(data: StateData): StateData {
  return {
    level: data.level,
    sessionId: data.sessionId,
    cols: data.cols.map((col) => ({ ...col })),
    slots: data.slots.map((slot) => ({ ...slot, members: [...slot.members] })),
    memberSlot: { ...data.memberSlot },
    bps: data.bps.map((bp) => ({ ...bp })),
    seps: data.seps.map((sep) => ({ ...sep })),
    rMaxExceeded: data.rMaxExceeded,
  };
}

// ------------------------------------------------------------ placement (spec §7.5 "Column map")

interface Run {
  st: StateData;
  spec: LevelSpec;
  scale: TimeScale;
  slotById: Map<string, Slot>;
}

function advance(run: Run, t: number): number {
  const last = run.st.bps.at(-1);
  if (last === undefined) return 0;
  const du = Math.max(0, run.scale.toU(t) - run.scale.toU(last.t));
  return last.xOut + Math.min((du / 1_000) * run.spec.pps, run.spec.pitch + run.spec.slack);
}

function fits(col: ColumnState, item: CanvasItem, x: number, spec: LevelSpec): boolean {
  if (x >= col.x + spec.pitch) return false;
  return item.band === "story" ? col.story < spec.storyCap : col.workRows < spec.rMax;
}

/** Last column with t0 ≤ t; column 0 when none. */
function columnAt(cols: readonly ColumnState[], t: number): ColumnState {
  let lo = 0;
  let hi = cols.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const col = cols[mid];
    if (col !== undefined && col.t0 <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const col = cols[found];
  if (col === undefined) throw new Error("columnAt on an empty layout");
  return col;
}

function openColumn(run: Run, item: CanvasItem, x: number, sep: "turn" | "break" | null, idleMs: number): ColumnState {
  const { st, spec } = run;
  const prev = st.cols.at(-1);
  const gap = sep === "turn" ? spec.turnGap : sep === "break" ? spec.breakGap : spec.colGap;
  // Whole world px keep column gaps exact and cards crisp; ceil keeps xOut ≥ xIn, so the time map stays monotone.
  const cx = prev === undefined ? 0 : Math.max(Math.ceil(x), prev.x + spec.w + gap);
  const col: ColumnState = {
    key: `col:${item.key}`,
    index: st.cols.length,
    x: cx,
    t0: item.start,
    turn: item.turn,
    story: 0,
    workY: spec.workTop,
    workRows: 0,
    noiseSlot: null,
  };
  st.cols.push(col);
  if (prev !== undefined && sep !== null) {
    st.seps.push({ kind: sep, x: (prev.x + spec.w + cx) / 2, t: item.start, turn: item.turn, idleMs });
  }
  return col;
}

function putItem(run: Run, col: ColumnState, item: CanvasItem, late: boolean): void {
  const { st, spec, slotById } = run;
  if (item.kind === "noise" && col.noiseSlot !== null) {
    const stack = slotById.get(col.noiseSlot);
    if (stack !== undefined) {
      stack.members.push(item.key);
      st.memberSlot[item.key] = stack.id;
      return;
    }
  }
  const size = frameSize(spec.level, item.kind);
  let slot: Slot;
  if (item.band === "story" && col.story < spec.storyCap) {
    slot = {
      id: item.key,
      stack: false,
      band: "story",
      placedAs: item.kind,
      col: col.index,
      row: col.story,
      x: col.x,
      y: col.story * (spec.h.story + spec.rowGap),
      w: size.w,
      h: size.h,
      members: [item.key],
      late,
    };
    col.story += 1;
  } else {
    const stack = item.kind === "noise";
    slot = {
      id: stack ? `stack:${item.key}` : item.key,
      stack,
      band: "work",
      placedAs: item.kind,
      col: col.index,
      row: spec.storyCap + col.workRows,
      x: col.x,
      y: col.workY,
      w: size.w,
      h: size.h,
      members: [item.key],
      late,
    };
    col.workY += size.h + spec.rowGap;
    col.workRows += 1;
    if (stack) col.noiseSlot = slot.id;
    if (col.workRows > spec.rMax) st.rMaxExceeded += 1;
  }
  st.slots.push(slot);
  slotById.set(slot.id, slot);
  st.memberSlot[item.key] = slot.id;
}

function placeItem(run: Run, item: CanvasItem): void {
  const { st, spec, scale } = run;
  const front = st.cols.at(-1);
  const last = st.bps.at(-1);
  // Late (deviation 6): earlier than the last breakpoint; goes to its own time column, pushes no breakpoint.
  if (front !== undefined && last !== undefined && item.start < last.t) {
    putItem(run, columnAt(st.cols, item.start), item, true);
    return;
  }
  const x = advance(run, item.start);
  let sep: "turn" | "break" | null = null;
  let idleMs = 0;
  if (front !== undefined && last !== undefined) {
    const u0 = scale.toU(last.t);
    const u1 = scale.toU(item.start);
    // A break needs at least breakMinMs of real time between the two starts; most items are closer.
    const breaks =
      item.start - last.t >= spec.breakMinMs
        ? scale.breaks(u0, u1, spec.breakMinMs).filter((seg) => seg.u1 > u0 && seg.u0 < u1)
        : [];
    idleMs = breaks.reduce((sum, seg) => sum + (seg.idle?.ms ?? 0), 0);
    sep = item.turn !== front.turn ? "turn" : breaks.length > 0 ? "break" : null;
  }
  const joinable = front !== undefined && sep === null && (item.kind === "noise" || fits(front, item, x, spec));
  const col = joinable ? front : openColumn(run, item, x, sep, idleMs);
  putItem(run, col, item, false);
  st.bps.push({ t: item.start, xIn: x, xOut: joinable ? x : col.x });
}

// ------------------------------------------------------------ finalize

export function formatIdle(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1_000))} s`;
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

function separatorLabel(sep: SeparatorState, session: TraceSession, spec: LevelSpec): string {
  if (sep.kind === "break") return `⫽ ${formatIdle(sep.idleMs)}`;
  const trigger = session.turns.find((turn) => turn.index === sep.turn)?.trigger ?? "resume";
  const idle = sep.idleMs >= spec.breakMinMs ? ` · after ${formatIdle(sep.idleMs)}` : "";
  return `Turn ${sep.turn + 1} · ${trigger}${idle}`;
}

function frameKindOf(item: CanvasItemKind): CanvasFrame["kind"] {
  if (isStoryKind(item)) return "story";
  if (item === "chapter") return "chapter";
  if (item === "noise") return "noise";
  return "loose";
}

function finalize(run: Run, session: TraceSession, itemByKey: ReadonlyMap<string, CanvasItem>): CanvasLayout {
  const { st, spec } = run;
  const frames: CanvasFrame[] = [];
  const holes: Rect[] = [];
  let right = 0;
  let bottom = 0;
  for (const slot of st.slots) {
    const slotRect: Rect = { x: slot.x, y: slot.y, w: slot.w, h: slot.h };
    right = Math.max(right, slot.x + slot.w);
    bottom = Math.max(bottom, slot.y + slot.h);
    const live = slot.members
      .map((key) => itemByKey.get(key))
      .filter((item): item is CanvasItem => item !== undefined);
    const head = live[0];
    if (head === undefined) {
      holes.push(slotRect);
      continue;
    }
    const item: CanvasItemKind = slot.stack ? "noise" : head.kind;
    frames.push({
      key: slot.id,
      selId: head.selId,
      kind: frameKindOf(item),
      item,
      col: slot.col,
      row: slot.row,
      slot: slotRect,
      card: { x: slot.x, y: slot.y + spec.labelH, w: slot.w, h: slot.h - spec.labelH },
      label: spec.labelH > 0 ? { x: slot.x, y: slot.y, w: slot.w, h: LABEL_ROW_PX } : null,
      members: live.map((member) => member.key),
      memberSelIds: live.map((member) => member.selId),
      late: slot.late,
    });
  }
  frames.sort((a, b) => a.col - b.col || a.row - b.row);
  const readingOrder: SelectionId[] = [];
  const seen = new Set<SelectionId>();
  for (const frame of frames) {
    for (const selId of frame.memberSelIds) {
      if (seen.has(selId)) continue;
      seen.add(selId);
      readingOrder.push(selId);
    }
  }
  const columns: CanvasColumn[] = st.cols.map((col) => ({
    key: col.key,
    index: col.index,
    x: col.x,
    t0: col.t0,
    turn: col.turn,
  }));
  const frameByKey = new Map(frames.map((frame) => [frame.key, frame]));
  const routed = routeEdges({ session, frames, frameByKey, columns, spec });
  const edges: readonly CanvasEdge[] = routed.edges;
  const junctions: readonly Point[] = routed.junctions;
  const hiddenEdges = routed.hiddenEdges;
  return {
    level: st.level,
    sessionId: st.sessionId,
    frames,
    frameByKey,
    holes,
    columns,
    separators: st.seps.map((sep) => ({
      kind: sep.kind,
      x: sep.x,
      t: sep.t,
      turn: sep.turn,
      label: separatorLabel(sep, session, spec),
    })),
    edges,
    junctions,
    time: { bps: st.bps.map((bp) => ({ ...bp })), pps: spec.pps },
    bounds: { x: 0, y: 0, w: right, h: bottom },
    readingOrder,
    stats: {
      late: frames.filter((frame) => frame.late).length,
      rMaxExceeded: st.rMaxExceeded,
      holes: holes.length,
      hiddenEdges,
    },
    state: packState(st),
  };
}

/** Pure, deterministic and sticky (spec §7.5; P1–P10). A different level or session lays out fresh. */
export function layoutCanvas(
  session: TraceSession,
  index: TraceIndex,
  scale: TimeScale,
  level: Level,
  prev?: CanvasLayout,
): CanvasLayout {
  const spec = LEVEL_SPECS[level];
  const sessionId = session.meta.sessionId;
  const st =
    prev !== undefined && prev.level === level && prev.sessionId === sessionId
      ? cloneState(unpackState(prev.state))
      : emptyState(level, sessionId);
  const run: Run = { st, spec, scale, slotById: new Map(st.slots.map((slot) => [slot.id, slot])) };
  const items = collectItems(session, index);
  const itemByKey = new Map(items.map((item) => [item.key, item]));
  for (const item of items) {
    const slotId = st.memberSlot[item.key];
    const slot = slotId === undefined ? undefined : run.slotById.get(slotId);
    if (slot === undefined) {
      placeItem(run, item);
      continue;
    }
    if (slot.stack && item.kind !== "noise") {
      // A noise item that became a chapter leaves its stack and lands late at the bottom of its column.
      slot.members = slot.members.filter((key) => key !== item.key);
      delete st.memberSlot[item.key];
      const col = st.cols[slot.col];
      if (col !== undefined) putItem(run, col, item, true);
    }
  }
  return finalize(run, session, itemByKey);
}

/** World x ↔ display time over the breakpoints, linear in toU between them, pps past the last. */
export function canvasXMap(layout: CanvasLayout, scale: TimeScale): XMap {
  const bps = layout.time.bps;
  const perU = layout.time.pps / 1_000;
  const us = bps.map((bp) => scale.toU(bp.t));
  const lastAtOrBefore = (tMs: number): number => {
    let lo = 0;
    let hi = bps.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((bps[mid]?.t ?? Infinity) <= tMs) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  };
  const xOf = (tMs: number): number => {
    const first = bps[0];
    const u0 = us[0];
    const u = scale.toU(tMs);
    if (first === undefined || u0 === undefined) return u * perU;
    const i = lastAtOrBefore(tMs);
    if (i < 0) return first.xOut - (u0 - u) * perU;
    const bp = bps[i];
    const ui = us[i];
    if (bp === undefined || ui === undefined) return u * perU;
    const next = bps[i + 1];
    const un = us[i + 1];
    if (next === undefined || un === undefined) return bp.xOut + (u - ui) * perU;
    if (un <= ui) return bp.xOut;
    return bp.xOut + ((u - ui) / (un - ui)) * (next.xIn - bp.xOut);
  };
  const tOf = (x: number): number => {
    const first = bps[0];
    const u0 = us[0];
    if (first === undefined || u0 === undefined) return scale.toT(x / perU);
    if (x <= first.xOut) return scale.toT(u0 - (first.xOut - x) / perU);
    let lo = 0;
    let hi = bps.length - 1;
    let i = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((bps[mid]?.xOut ?? Infinity) <= x) {
        i = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const bp = bps[i];
    const ui = us[i];
    if (bp === undefined || ui === undefined) return scale.toT(u0);
    const next = bps[i + 1];
    const un = us[i + 1];
    if (next === undefined || un === undefined) return scale.toT(ui + (x - bp.xOut) / perU);
    if (x >= next.xIn) return next.t; // inside the push [xIn, xOut) of the next breakpoint
    if (next.xIn <= bp.xOut) return bp.t;
    return scale.toT(ui + ((x - bp.xOut) / (next.xIn - bp.xOut)) * (un - ui));
  };
  return { xOf, tOf };
}
