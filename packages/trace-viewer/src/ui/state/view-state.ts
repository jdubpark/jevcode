import type { Level, UnitStableId } from "../../model/index.js";
import {
  autoExpandingFindings, brushSeqRange, effectivePlayheadSeq, isKeyExpanded,
  type Brush, type Playhead, type SelectionId, type TraceIndex,
} from "../../layout/trace-index.js";
import type { ViewerLocation } from "./location.js";

/** Built-in views (spec §8.5, §8.6); a host view uses its own lower-case kind, e.g. "surfaces". */
export type ViewKind = "console" | "canvas" | "hybrid" | "map" | (string & { readonly __host?: true });
export type FocusBy = ViewKind | "shell";
export type InspectorTab = "summary" | "evidence" | "raw";
export type Tool = "select" | "hand";
export type Gesture = null | "pan" | "zoom" | "brush" | "playhead";
export type PlayheadOrigin = "spine" | "overview" | "canvas" | "keys" | "outline" | "search" | "finding" | "live" | "program";

export interface CanvasCamera { mode: "uniform"; tx: number; ty: number; k: number; syncedRev: number }
export interface HybridCamera { mode: "xOnly"; u0: number; k: number; spineAnchor: { key: string; offsetPx: number } | null; syncedRev: number }
export interface SearchState { query: string; matchIds: readonly SelectionId[]; cursor: number }

export interface ViewState {
  view: ViewKind;
  level: Level;
  /** Live = true. */
  follow: boolean;
  selection: SelectionId | null;
  /** Set when a re-cluster moved the selection; cleared by the next select. */
  selectionNote: { from: UnitStableId; to: UnitStableId } | null;
  playhead: Playhead;
  /** Origin of the last playhead write; the spine never scrolls for "spine". */
  playheadOrigin: PlayheadOrigin;
  brush: Brush;
  /** +1 on every selection, brush or level write a hidden view must catch up with; never on programmatic camera moves. */
  focusRev: number;
  focusBy: FocusBy;
  /** +1 when the Outline or the Brief (by "shell") picks the item that is already selected: a request to reveal it, with no selection change. */
  revealRev: number;
  /** Expanded row, frame and finding keys. */
  expanded: ReadonlySet<string>;
  /** Finding ids the reader collapsed; later folds never re-expand them. */
  collapsed: ReadonlySet<string>;
  inspectorTab: InspectorTab;
  /** B pinned the Brief over the selection, or on the Map over the selected component (spec §3.3, E4); a new or cleared selection unpins it. */
  brief: boolean;
  tool: Tool;
  search: SearchState | null;
  lastSeenSeq: number;
  gesture: Gesture;
  /** Terminal state reached and final apply done; Live disabled. */
  terminal: boolean;
  /** Load reached lastSeq at least once; the initial selection has run. */
  loaded: boolean;
  cameras: { canvas: CanvasCamera | null; hybrid: HybridCamera | null };
  /** Anchor seq of every unit id held in selection, expanded or collapsed (remaps regrouped units). */
  unitAnchors: Readonly<Record<string, number>>;
  /** Map view (spec §3.4): the selected component id. Separate from `selection`; not in the location hash. */
  mapSelection: string | null;
}

export type ViewAction =
  | { type: "session/applied"; loadedThroughSeq: number; terminal: boolean; loadComplete: boolean; initialSelection: SelectionId | null; chapterSpineRows: number }
  | { type: "select"; id: SelectionId | null; by: FocusBy; origin?: PlayheadOrigin }
  | { type: "nav"; target: "chapter" | "turn" | "finding"; dir: 1 | -1 }
  | { type: "nav/first" }
  | { type: "nav/last" }
  | { type: "view/switch"; view: ViewKind }
  | { type: "level/set"; level: Level; by: FocusBy }
  | { type: "follow/set"; follow: boolean }
  | { type: "playhead/set"; playhead: Playhead; origin: PlayheadOrigin }
  | { type: "playhead/step"; dir: 1 | -1 }
  | { type: "brush/set"; brush: Brush; by: ViewKind }
  | { type: "brush/edge"; edge: "from" | "to" }
  | { type: "brush/chapter" }
  | { type: "expand/toggle"; key: string }
  | { type: "expand/set"; key: string; expanded: boolean }
  | { type: "inspector/tab"; tab: InspectorTab }
  | { type: "tool/set"; tool: Tool }
  | { type: "gesture"; gesture: Gesture }
  | { type: "camera/sync"; view: "canvas"; camera: Omit<CanvasCamera, "syncedRev"> }
  | { type: "camera/sync"; view: "hybrid"; camera: Omit<HybridCamera, "syncedRev"> }
  | { type: "search/set"; query: string; matchIds: readonly SelectionId[] }
  | { type: "search/next"; dir: 1 | -1 }
  | { type: "esc" }
  | { type: "brief/toggle" }
  | { type: "seen"; seq: number }
  | { type: "map/select"; componentId: string | null };

export interface InitialViewStateInput {
  live: boolean;
  location?: ViewerLocation;
  /** The opening view TraceViewer resolved (openingView); wins over location.view. */
  view?: ViewKind;
}

/** Spec §7.8: the brush stays `session` when the Chapter-level spine has at most this many rows. */
export const SPINE_ROWS_BRUSH_LIMIT = 150;

const EMPTY: ReadonlySet<string> = new Set<string>();

export function initialViewState(input: InitialViewStateInput): ViewState {
  const location = input.location;
  const selected = location?.selected;
  const selection = selected !== undefined && (selected.startsWith("step:") || selected.startsWith("unit:"))
    ? (selected as SelectionId)
    : null;
  return {
    view: input.view ?? location?.view ?? "hybrid",
    level: location?.level ?? "chapter",
    follow: input.live,
    selection,
    selectionNote: null,
    playhead: location?.playhead ?? (input.live ? { kind: "live" } : { kind: "selection" }),
    playheadOrigin: "program",
    brush: location?.brush ?? { kind: "session" },
    focusRev: 0,
    focusBy: "shell",
    revealRev: 0,
    expanded: EMPTY,
    collapsed: EMPTY,
    inspectorTab: "summary",
    brief: false,
    tool: "select",
    search: null,
    lastSeenSeq: 0,
    gesture: null,
    terminal: false,
    loaded: false,
    cameras: { canvas: null, hybrid: null },
    unitAnchors: {},
    mapSelection: null,
  };
}

// ------------------------------------------------------------ helpers

function lastIndexWhere<T>(items: readonly T[], pred: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item !== undefined && pred(item)) return i;
  }
  return -1;
}

const anchorOf = (id: UnitStableId, index: TraceIndex): number | undefined => {
  const key = index.chapterKey(id);
  return key === undefined ? undefined : Number(key.slice(3));
};

function rememberAnchors(anchors: Readonly<Record<string, number>>, keys: readonly (string | null)[], index: TraceIndex): Readonly<Record<string, number>> {
  let next: Record<string, number> | null = null;
  for (const key of keys) {
    if (key === null || !key.startsWith("unit:")) continue;
    const anchor = anchorOf(key as UnitStableId, index);
    if (anchor === undefined || anchors[key] === anchor) continue;
    next ??= { ...anchors };
    next[key] = anchor;
  }
  return next ?? anchors;
}

function withKey(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  if (set.has(key)) return set;
  const next = new Set(set);
  next.add(key);
  return next;
}

function withoutKey(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  if (!set.has(key)) return set;
  const next = new Set(set);
  next.delete(key);
  return next;
}

function originFor(by: FocusBy): PlayheadOrigin {
  return by === "canvas" ? "canvas" : by === "hybrid" ? "overview" : "outline";
}

function leaveLive(state: ViewState, index: TraceIndex): ViewState {
  if (!state.follow) return state;
  const playhead: Playhead = state.playhead.kind === "live" ? { kind: "free", seq: index.loadedThroughSeq } : state.playhead;
  return { ...state, follow: false, playhead };
}

/** Moves the brush the least (keeping its width) so its range meets [lo, hi]. */
function slideToInclude(brush: Brush, index: TraceIndex, lo: number, hi: number, liveEdge: boolean): Brush {
  const r = brushSeqRange(brush, index);
  if (r.toSeq >= lo && r.fromSeq <= hi) return brush;
  if (brush.kind === "session") return brush;
  if (brush.kind === "chapter") {
    const chapter = index.chapterAtSeq(lo);
    const anchor = chapter === undefined ? undefined : anchorOf(chapter.id, index);
    if (anchor !== undefined) {
      const candidate: Brush = { kind: "chapter", anchorSeq: anchor };
      const c = brushSeqRange(candidate, index);
      if (c.toSeq >= lo && c.fromSeq <= hi) return candidate;
    }
  }
  const width = r.toSeq - r.fromSeq;
  if (hi < r.fromSeq) {
    const toSeq = hi;
    return { kind: "range", fromSeq: Math.max(1, toSeq - width), toSeq: Math.max(1, toSeq) };
  }
  const fromSeq = Math.max(1, lo);
  if (liveEdge || (brush.kind === "range" && brush.toSeq === "live")) {
    return { kind: "range", fromSeq: Math.max(1, Math.min(fromSeq, index.loadedThroughSeq - width)), toSeq: "live" };
  }
  return { kind: "range", fromSeq, toSeq: fromSeq + width };
}

/** Selection ∩ brush and playhead ∈ brush (UI index §2.3); bumps focusRev when the brush moves. */
function ensureInvariants(state: ViewState, index: TraceIndex): ViewState {
  if (index.session === null || index.session.steps.length === 0) return state;
  const live = state.playhead.kind === "live";
  let brush = state.brush;
  const sel = state.selection === null ? undefined : index.entry(state.selection);
  if (sel !== undefined) brush = slideToInclude(brush, index, sel.firstSeq, sel.lastSeq, live);
  const p = effectivePlayheadSeq(state.playhead, state.selection, index);
  brush = slideToInclude(brush, index, p, p, live);
  if (sel !== undefined) {
    const r = brushSeqRange(brush, index);
    if (!(r.toSeq >= sel.firstSeq && r.fromSeq <= sel.lastSeq)) {
      brush = { kind: "range", fromSeq: Math.max(1, Math.min(r.fromSeq, sel.lastSeq)), toSeq: Math.max(r.toSeq, sel.firstSeq) };
    }
  }
  return brush === state.brush ? state : { ...state, brush, focusRev: state.focusRev + 1 };
}

function isTail(id: SelectionId, index: TraceIndex): boolean {
  const tail = index.tailStepId;
  if (tail === null) return false;
  if (id === tail) return true;
  if (!id.startsWith("unit:")) return false;
  if (index.entry(tail)?.parent === id) return true;
  return index.session?.chapters.some((c) => c.id === id && c.stepIds.includes(tail)) ?? false;
}

/**
 * Selecting a step or unit also drops the Map's component selection (lane 06 fix I-1): the right panel shows the
 * component while one is selected, so a step picked from the Outline, the keys or a search must take the panel.
 */
function selectId(state: ViewState, id: SelectionId | null, by: FocusBy, origin: PlayheadOrigin, index: TraceIndex): ViewState {
  if (id !== null && index.entry(id) === undefined) return state;
  const same = id !== null && id === state.selection && by === "shell";
  const mapSelection = id === null ? state.mapSelection : null;
  if (id === state.selection && (id === null || state.playhead.kind === "selection")) {
    if (same) return { ...state, revealRev: state.revealRev + 1, mapSelection };
    return mapSelection === state.mapSelection ? state : { ...state, mapSelection };
  }
  const prevP = effectivePlayheadSeq(state.playhead, state.selection, index);
  const follow = state.follow && (id === null || isTail(id, index));
  let playhead: Playhead;
  if (id === null) playhead = state.playhead.kind === "selection" ? { kind: "free", seq: prevP } : state.playhead;
  else playhead = follow ? { kind: "live" } : { kind: "selection" };
  if (!follow && playhead.kind === "live") playhead = { kind: "free", seq: index.loadedThroughSeq };
  const next: ViewState = {
    ...state,
    selection: id,
    selectionNote: null,
    playhead,
    playheadOrigin: origin,
    focusRev: state.focusRev + 1,
    focusBy: by,
    revealRev: same ? state.revealRev + 1 : state.revealRev,
    inspectorTab: state.inspectorTab === "raw" && id !== state.selection ? "summary" : state.inspectorTab,
    brief: false,
    follow,
    unitAnchors: rememberAnchors(state.unitAnchors, [id], index),
    mapSelection,
  };
  return ensureInvariants(next, index);
}

/** Brush writes keep the written brush; a selection outside it clears and the playhead clamps into it. */
function writeBrush(state: ViewState, brush: Brush, by: FocusBy, index: TraceIndex): ViewState {
  const base = leaveLive(state, index);
  const prevP = effectivePlayheadSeq(base.playhead, base.selection, index);
  const r = brushSeqRange(brush, index);
  const sel = base.selection === null ? undefined : index.entry(base.selection);
  const keep = sel === undefined || (sel.lastSeq >= r.fromSeq && sel.firstSeq <= r.toSeq);
  const selection = keep ? base.selection : null;
  let playhead: Playhead = base.playhead;
  if (!keep && playhead.kind === "selection") playhead = { kind: "free", seq: prevP };
  const p = effectivePlayheadSeq(playhead, selection, index);
  if (p < r.fromSeq || p > r.toSeq) playhead = { kind: "free", seq: Math.min(r.toSeq, Math.max(r.fromSeq, p)) };
  return {
    ...base,
    brush,
    selection,
    selectionNote: keep ? base.selectionNote : null,
    brief: keep ? base.brief : false,
    playhead,
    focusRev: base.focusRev + 1,
    focusBy: by,
  };
}

function setExpanded(state: ViewState, key: string, want: boolean, index: TraceIndex): ViewState {
  if (isKeyExpanded(key, index, state.expanded, state.collapsed) === want) return state;
  if (want) {
    return { ...state, expanded: withKey(state.expanded, key), unitAnchors: rememberAnchors(state.unitAnchors, [key], index) };
  }
  let collapsed = state.collapsed;
  if (key.startsWith("finding:")) collapsed = withKey(collapsed, key);
  if (key.startsWith("step:")) {
    const entry = index.entry(key);
    const step = entry === undefined ? undefined : index.session?.steps[entry.position];
    // Only the findings that open this row; a claim that cites the step keeps its own expansion.
    for (const finding of step === undefined ? [] : autoExpandingFindings(step, index.findingsById)) collapsed = withKey(collapsed, finding.id);
  }
  return { ...state, expanded: withoutKey(state.expanded, key), collapsed };
}

function chapterBrushFor(id: SelectionId | null, index: TraceIndex): Brush | null {
  if (id === null) return null;
  const unit = id.startsWith("unit:") ? (id as UnitStableId) : index.entry(id)?.parent ?? null;
  const anchor = unit === null ? undefined : anchorOf(unit, index);
  return anchor === undefined ? null : { kind: "chapter", anchorSeq: anchor };
}

function applySession(state: ViewState, action: Extract<ViewAction, { type: "session/applied" }>, index: TraceIndex): ViewState {
  let s = state;
  const remap = (key: string): UnitStableId | null => {
    if (!key.startsWith("unit:") || index.entry(key) !== undefined) return null;
    const anchor = s.unitAnchors[key];
    if (anchor === undefined) return null;
    const to = index.chapterByAnchor(anchor) ?? index.chapterAtSeq(anchor)?.id;
    return to !== undefined && to !== key ? to : null;
  };
  let anchors = s.unitAnchors;
  const carry = (from: string, to: UnitStableId): void => {
    const anchor = anchors[from];
    if (anchor !== undefined && anchors[to] !== anchor) anchors = { ...anchors, [to]: anchor };
  };
  if (s.selection !== null) {
    const from = s.selection;
    const to = remap(from);
    if (to !== null) {
      carry(from, to);
      s = { ...s, selection: to, selectionNote: { from: from as UnitStableId, to }, focusRev: s.focusRev + 1, focusBy: "shell" };
    }
  }
  let expanded = s.expanded;
  for (const key of s.expanded) {
    const to = remap(key);
    if (to === null) continue;
    carry(key, to);
    expanded = withKey(withoutKey(expanded, key), to);
  }
  let collapsed = s.collapsed;
  for (const key of s.collapsed) {
    const to = remap(key);
    if (to === null) continue;
    carry(key, to);
    collapsed = withKey(collapsed, to);
  }
  if (expanded !== s.expanded || collapsed !== s.collapsed || anchors !== s.unitAnchors) s = { ...s, expanded, collapsed, unitAnchors: anchors };

  // lastSeenSeq advances while following, including the terminal apply that ends Live, and through the
  // initial load, so rows present when loading ends are never "new" (spec §7.10).
  const wasFollowing = s.follow;
  if (action.terminal && !s.terminal) s = { ...leaveLive(s, index), terminal: true };
  if ((wasFollowing || !state.loaded) && action.loadedThroughSeq > s.lastSeenSeq) s = { ...s, lastSeenSeq: action.loadedThroughSeq };

  if (action.loadComplete && !s.loaded) {
    s = { ...s, loaded: true };
    const small = action.chapterSpineRows <= SPINE_ROWS_BRUSH_LIMIT;
    if (!s.follow) {
      if (s.selection === null) {
        const initial = action.initialSelection ?? index.tailStepId;
        if (initial !== null && index.entry(initial) !== undefined) {
          s = {
            ...s, selection: initial, playhead: { kind: "selection" }, playheadOrigin: "program",
            focusRev: s.focusRev + 1, focusBy: "shell", unitAnchors: rememberAnchors(s.unitAnchors, [initial], index),
          };
        }
      }
      if (!small && s.brush.kind === "session") {
        const brush = chapterBrushFor(s.selection, index);
        if (brush !== null) s = { ...s, brush, focusRev: s.focusRev + 1 };
      }
    } else {
      s = { ...s, playhead: { kind: "live" }, playheadOrigin: "live" };
      if (!small && s.brush.kind === "session") {
        const latest = index.chapterAtSeq(index.loadedThroughSeq);
        const brush = latest === undefined ? null : chapterBrushFor(latest.id, index);
        if (brush !== null) s = { ...s, brush, focusRev: s.focusRev + 1 };
      }
    }
  }
  return ensureInvariants(s, index);
}

function nav(state: ViewState, target: "chapter" | "turn" | "finding", dir: 1 | -1, index: TraceIndex): ViewState {
  const session = index.session;
  if (session === null || session.steps.length === 0) return state;
  const p = effectivePlayheadSeq(state.playhead, state.selection, index);
  if (target === "finding") {
    const list = index.findingsBySeq;
    if (list.length === 0) return state;
    const n = list.length;
    // On a finding's step, step from that finding: lane B anchors failing_tests and recovery_arc on the
    // test_result seq, after the step's firstSeq, so comparing anchorSeq with the playhead would reselect it.
    const sel = state.selection;
    const entry = sel === null ? undefined : index.entry(sel);
    const atSelection = entry !== undefined && p >= entry.firstSeq && p <= entry.lastSeq;
    const at = !atSelection ? -1 : dir > 0 ? lastIndexWhere(list, (f) => f.anchorStepId === sel) : list.findIndex((f) => f.anchorStepId === sel);
    let i: number;
    if (at >= 0) {
      i = at;
      for (let k = 1; k <= n; k += 1) {
        i = (((at + dir * k) % n) + n) % n;
        if (list[i]?.anchorStepId !== sel) break;
      }
    } else {
      i = dir > 0 ? list.findIndex((f) => f.anchorSeq > p) : lastIndexWhere(list, (f) => f.anchorSeq < p);
      if (i < 0) i = dir > 0 ? 0 : n - 1;
    }
    const finding = list[i];
    return finding === undefined ? state : selectId(state, finding.anchorStepId, "shell", "finding", index);
  }
  if (target === "turn") {
    const turns = session.turns;
    if (turns.length === 0) return state;
    const current = index.turnAtSeq(p)?.index ?? 0;
    const next = turns[Math.max(0, Math.min(turns.length - 1, current + dir))];
    if (next === undefined) return state;
    const step = session.steps[index.stepIndexAtOrAfter(next.startSeq)];
    return step === undefined ? state : selectId(state, step.id, "shell", "keys", index);
  }
  const chapters = session.chapters
    .filter((c) => c.current)
    .map((c) => ({ id: c.id, anchor: anchorOf(c.id, index) ?? c.firstSeq }))
    .sort((a, b) => a.anchor - b.anchor || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (chapters.length === 0) return state;
  const selected = state.selection === null ? null : state.selection.startsWith("unit:") ? state.selection : index.entry(state.selection)?.parent ?? null;
  const at = selected === null ? -1 : chapters.findIndex((c) => c.id === selected);
  let next: number;
  if (at >= 0) next = Math.max(0, Math.min(chapters.length - 1, at + dir));
  else {
    next = dir > 0 ? chapters.findIndex((c) => c.anchor > p) : lastIndexWhere(chapters, (c) => c.anchor < p);
    if (next < 0) next = dir > 0 ? chapters.length - 1 : 0;
  }
  const chosen = chapters[next];
  return chosen === undefined ? state : selectId(state, chosen.id, "shell", "keys", index);
}

/**
 * Whether B (the title bar's Brief toggle, Shift+B) has something to pin the Brief over: a selection, or on the Map a
 * selected component (lane 06 fix, minor 3). With neither, the Brief already fills the panel and the toggle is a no-op.
 * RightPanel.tsx re-exports it next to showsBrief.
 */
export function canToggleBrief(state: ViewState): boolean {
  return state.selection !== null || (state.view === "map" && state.mapSelection !== null);
}

// ------------------------------------------------------------ reduce

/** Pure. Returns the same object when nothing changes. */
export function reduce(state: ViewState, action: ViewAction, index: TraceIndex): ViewState {
  switch (action.type) {
    case "session/applied":
      return applySession(state, action, index);
    case "select":
      return selectId(state, action.id, action.by, action.origin ?? originFor(action.by), index);
    case "nav":
      return nav(state, action.target, action.dir, index);
    case "nav/first": {
      const first = index.session?.steps[0];
      return first === undefined ? state : selectId(leaveLive(state, index), first.id, "shell", "keys", index);
    }
    case "nav/last": {
      const tail = index.tailStepId;
      if (tail === null) return state;
      const canFollow = !state.terminal && index.session?.live === true;
      const base = canFollow ? { ...state, follow: true } : state;
      const next = selectId(base, tail, "shell", "keys", index);
      if (!canFollow) return next;
      return ensureInvariants({ ...next, follow: true, playhead: { kind: "live" }, playheadOrigin: "live", lastSeenSeq: Math.max(next.lastSeenSeq, index.loadedThroughSeq) }, index);
    }
    case "view/switch":
      return action.view === state.view ? state : { ...state, view: action.view };
    case "level/set": {
      if (action.level === state.level) return state;
      const base = action.by === "shell" ? state : leaveLive(state, index);
      return { ...base, level: action.level, focusRev: base.focusRev + 1, focusBy: action.by };
    }
    case "follow/set": {
      if (action.follow === state.follow) return state;
      if (!action.follow) return leaveLive(state, index);
      if (state.terminal) return state;
      return ensureInvariants({
        ...state, follow: true, playhead: { kind: "live" }, playheadOrigin: "live",
        lastSeenSeq: Math.max(state.lastSeenSeq, index.loadedThroughSeq),
      }, index);
    }
    case "playhead/set": {
      const base = action.origin === "live" ? state : leaveLive(state, index);
      const playhead: Playhead = action.playhead.kind === "free"
        ? { kind: "free", seq: Math.max(1, Math.min(Math.max(1, index.loadedThroughSeq), action.playhead.seq)) }
        : action.playhead;
      const effective = action.origin !== "live" && playhead.kind === "live" && !base.follow ? { kind: "free" as const, seq: index.loadedThroughSeq } : playhead;
      return ensureInvariants({ ...base, playhead: effective, playheadOrigin: action.origin }, index);
    }
    case "playhead/step": {
      const steps = index.session?.steps ?? [];
      if (steps.length === 0) return state;
      const base = leaveLive(state, index);
      const p = effectivePlayheadSeq(base.playhead, base.selection, index);
      const i = index.stepIndexAtOrBefore(p);
      const target = steps[Math.max(0, Math.min(steps.length - 1, i + action.dir))];
      if (target === undefined) return state;
      return ensureInvariants({ ...base, playhead: { kind: "free", seq: target.firstSeq }, playheadOrigin: "keys" }, index);
    }
    case "brush/set":
      return writeBrush(state, action.brush, action.by, index);
    case "brush/edge": {
      const p = effectivePlayheadSeq(state.playhead, state.selection, index);
      const r = brushSeqRange(state.brush, index);
      const liveTo = state.brush.kind === "range" && state.brush.toSeq === "live";
      const brush: Brush = action.edge === "from"
        ? { kind: "range", fromSeq: p, toSeq: liveTo ? "live" : Math.max(p, r.toSeq) }
        : { kind: "range", fromSeq: Math.min(r.fromSeq, p), toSeq: p };
      return writeBrush(state, brush, "hybrid", index);
    }
    case "brush/chapter": {
      const p = effectivePlayheadSeq(state.playhead, state.selection, index);
      const chapter = index.chapterAtSeq(p);
      const byChapter = chapter === undefined ? null : chapterBrushFor(chapter.id, index);
      if (byChapter !== null) return writeBrush(state, byChapter, "hybrid", index);
      const turn = index.turnAtSeq(p);
      if (turn === undefined) return state;
      return writeBrush(state, { kind: "range", fromSeq: turn.startSeq, toSeq: Math.max(turn.startSeq, turn.endSeq) }, "hybrid", index);
    }
    case "expand/toggle":
      return setExpanded(state, action.key, !isKeyExpanded(action.key, index, state.expanded, state.collapsed), index);
    case "expand/set":
      return setExpanded(state, action.key, action.expanded, index);
    case "inspector/tab":
      return action.tab === state.inspectorTab ? state : { ...state, inspectorTab: action.tab };
    case "tool/set":
      return action.tool === state.tool ? state : { ...state, tool: action.tool };
    case "gesture": {
      if (action.gesture === state.gesture) return state;
      const base = action.gesture === null ? state : leaveLive(state, index);
      return { ...base, gesture: action.gesture };
    }
    case "camera/sync":
      if (action.view === "canvas") return { ...state, cameras: { ...state.cameras, canvas: { ...action.camera, syncedRev: state.focusRev } } };
      return { ...state, cameras: { ...state.cameras, hybrid: { ...action.camera, syncedRev: state.focusRev } } };
    case "search/set": {
      const query = action.query.trim();
      if (query.length === 0) return state.search === null ? state : { ...state, search: null };
      return { ...state, search: { query: action.query, matchIds: action.matchIds, cursor: -1 } };
    }
    case "search/next": {
      const search = state.search;
      if (search === null || search.matchIds.length === 0) return state;
      const n = search.matchIds.length;
      const cursor = (((search.cursor + action.dir) % n) + n) % n;
      const id = search.matchIds[cursor];
      if (id === undefined) return state;
      const selected = selectId(state, id, "shell", "search", index);
      return { ...selected, search: { ...search, cursor } };
    }
    case "esc": {
      if (state.search !== null) return { ...state, search: null };
      if (state.tool === "hand") return { ...state, tool: "select" };
      // A pin over the component alone ends with it; a pin over a step selection stays (spec §3.7).
      if (state.view === "map" && state.mapSelection !== null) return { ...state, mapSelection: null, brief: state.selection === null ? false : state.brief };
      const selection = state.selection;
      if (selection === null) return state;
      // Spec §3.7: with the Brief pinned over a selection, Esc clears it, so the Brief stays (no step out to the parent).
      if (state.brief) return selectId(state, null, "shell", "keys", index);
      if (isKeyExpanded(selection, index, state.expanded, state.collapsed)) return setExpanded(state, selection, false, index);
      const parent = selection.startsWith("step:") ? index.entry(selection)?.parent ?? null : null;
      if (parent !== null) return selectId(state, parent, "shell", "keys", index);
      return selectId(state, null, "shell", "keys", index);
    }
    case "brief/toggle":
      return canToggleBrief(state) ? { ...state, brief: !state.brief } : state;
    case "map/select":
      // A new or cleared component selection unpins the Brief, as a step selection does.
      return action.componentId === state.mapSelection ? state : { ...state, mapSelection: action.componentId, brief: false };
    case "seen":
      return action.seq > state.lastSeenSeq ? { ...state, lastSeenSeq: action.seq } : state;
  }
}

// ------------------------------------------------------------ selectors

export function selectNewCount(state: ViewState, index: TraceIndex): number {
  const steps = index.session?.steps.length ?? 0;
  return steps - index.stepIndexAtOrAfter(state.lastSeenSeq + 1);
}

export function selectEffectivePlayheadSeq(state: ViewState, index: TraceIndex): number {
  const r = brushSeqRange(state.brush, index);
  const p = effectivePlayheadSeq(state.playhead, state.selection, index);
  return Math.min(r.toSeq, Math.max(r.fromSeq, p));
}

export function selectStepIsTail(id: SelectionId, index: TraceIndex): boolean {
  return isTail(id, index);
}

export function locationOf(state: ViewState, sessionId: string): ViewerLocation {
  const location: ViewerLocation = { v: 1, sessionId, view: state.view, level: state.level, brush: state.brush, playhead: state.playhead };
  if (state.selection !== null) location.selected = state.selection;
  return location;
}
