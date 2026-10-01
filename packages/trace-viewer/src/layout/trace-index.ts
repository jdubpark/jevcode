import type {
  Chapter, Finding, FindingId, Step, StepId, TraceSession, Turn, UnitStableId,
} from "../model/index.js";

export type SelectionId = StepId | UnitStableId;
export type Playhead = { kind: "selection" } | { kind: "free"; seq: number } | { kind: "live" };
export type Brush =
  | { kind: "session" }
  | { kind: "chapter"; anchorSeq: number }
  | { kind: "range"; fromSeq: number; toSeq: number | "live" };

export interface IndexEntry {
  id: SelectionId;
  kind: "step" | "chapter";
  /** Display clock. */
  t0: number;
  t1: number;
  firstSeq: number;
  lastSeq: number;
  /** step → its lowest-anchor chapter; chapter → null. */
  parent: UnitStableId | null;
  /** Position in session.steps or session.chapters. */
  position: number;
}

export interface TraceIndex {
  readonly sessionId: string;
  readonly session: TraceSession | null;
  readonly loadedThroughSeq: number;
  /** session.steps' firstSeq, ascending. */
  readonly stepFirstSeqs: Int32Array;
  entry(id: string): IndexEntry | undefined;
  /** Last step index with firstSeq ≤ seq, or −1. */
  stepIndexAtOrBefore(seq: number): number;
  /** First step index with firstSeq ≥ seq, or steps.length. */
  stepIndexAtOrAfter(seq: number): number;
  /** "ch:<anchorSeq>", anchorSeq = min over factSeqs and step firstSeqs (spec §7.5). Chapters can share it. */
  chapterKey(id: UnitStableId): `ch:${number}` | undefined;
  /** The anchorSeq in chapterKey; undefined for an unknown chapter. */
  chapterAnchor(id: UnitStableId): number | undefined;
  /** First of chaptersByAnchor, else a superseded chapter with that anchor. */
  chapterByAnchor(anchorSeq: number): UnitStableId | undefined;
  /**
   * Current chapters with this anchor seq, ordered by id. Lane B links a decision or a multi-file step to
   * several units, so units can share an anchor; the first is keyed ch:<anchor>, the rest ch:<anchor>.<n> (spec §7.5).
   */
  chaptersByAnchor(anchorSeq: number): readonly UnitStableId[];
  /** The current chapter whose step span holds seq (latest anchor wins). */
  chapterAtSeq(seq: number): Chapter | undefined;
  turnAtSeq(seq: number): Turn | undefined;
  /** Findings in seq order (n/N). */
  readonly findingsBySeq: readonly Finding[];
  /** The tail step: highest firstSeq. */
  readonly tailStepId: StepId | null;
  readonly findingsById: ReadonlyMap<FindingId, Finding>;
}

const NO_CHAPTERS: readonly UnitStableId[] = [];

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** First index with arr[i] ≥ value. */
function lowerBound(arr: Int32Array, value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((arr[mid] ?? 0) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index with arr[i] > value. */
function upperBound(arr: Int32Array, value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((arr[mid] ?? 0) <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const GONE: unique symbol = Symbol("gone");

/**
 * A read-mostly map that shares an older generation's entries: a build copies only the changes since the last
 * flatten, and an index keeps reading the generation it was built with (it never changes after it is returned).
 */
class LayeredMap<K, V> {
  private constructor(
    private readonly base: ReadonlyMap<K, V>,
    private readonly top: Map<K, V | typeof GONE>,
    private count: number,
  ) {}

  static from<K, V>(map: Map<K, V>): LayeredMap<K, V> {
    return new LayeredMap(map, new Map(), map.size);
  }

  get size(): number {
    return this.count;
  }

  get(key: K): V | undefined {
    const value = this.top.get(key);
    if (value !== undefined) return value === GONE ? undefined : value;
    return this.base.get(key);
  }

  set(key: K, value: V): void {
    if (this.get(key) === undefined) this.count += 1;
    this.top.set(key, value);
  }

  delete(key: K): void {
    if (this.get(key) === undefined) return;
    this.count -= 1;
    if (this.base.has(key)) this.top.set(key, GONE);
    else this.top.delete(key);
  }

  /** A copy to change: shares the base until the changes reach an eighth of it. */
  fork(): LayeredMap<K, V> {
    if (this.top.size * 8 <= this.base.size) return new LayeredMap(this.base, new Map(this.top), this.count);
    const flat = new Map(this.base);
    for (const [key, value] of this.top) {
      if (value === GONE) flat.delete(key);
      else flat.set(key, value);
    }
    return new LayeredMap(flat, new Map(), flat.size);
  }
}

interface Joins {
  /** chapter.stepIds reversed. */
  chaptersOfStep: Map<StepId, Set<UnitStableId>>;
  /** step.chapterIds reversed. */
  stepsOfChapter: Map<UnitStableId, Set<StepId>>;
  /** Chapter ids by anchor. */
  chaptersAtAnchor: Map<number, Set<UnitStableId>>;
}

/**
 * What a build derived beyond the public index, kept so the next build can start from it. The public maps are
 * forked before a later build changes them; the joins are moved to the next build, so only one build may start
 * from a given index.
 */
interface IndexState {
  readonly session: TraceSession;
  readonly entries: LayeredMap<string, IndexEntry>;
  readonly anchorOf: LayeredMap<UnitStableId, number>;
  readonly byAnchor: LayeredMap<number, UnitStableId>;
  readonly currentByAnchor: LayeredMap<number, readonly UnitStableId[]>;
  readonly stepFirstSeqs: Int32Array;
  readonly turns: readonly Turn[];
  readonly findingsBySeq: readonly Finding[];
  readonly findingsById: ReadonlyMap<FindingId, Finding>;
  /** Unique ids across steps and chapters: false keeps the next build fresh. */
  readonly incremental: boolean;
  /** Made by the first build that starts from this lineage. */
  joins: Joins | null;
  /** A later build took the joins. */
  consumed: boolean;
  /** What this build changed from the index it started from; null for a fresh build. */
  readonly changes: { readonly entries: ReadonlySet<string>; readonly anchors: ReadonlySet<UnitStableId> } | null;
}

type CoreState = Omit<IndexState, "turns" | "findingsBySeq" | "findingsById">;

/** Entries a build computed (not reused) and the chapter-step links it read: a regression gauge for tests. */
export interface IndexWork { stepEntries: number; chapterEntries: number; anchors: number; links: number; full: boolean }

const STATES = new WeakMap<TraceIndex, IndexState>();
const WORK = new WeakMap<TraceIndex, IndexWork>();

/** The work of the build that returned `index`; undefined for an index this module did not build. */
export function traceIndexWork(index: TraceIndex): IndexWork | undefined {
  return WORK.get(index);
}

interface EntryLookup { get(id: string): IndexEntry | undefined }

function stepPosition(entries: EntryLookup, id: string): number {
  const entry = entries.get(id);
  return entry?.kind === "step" ? entry.position : -1;
}

/** Anchor, span and entry of one chapter (spec §7.5): anchorSeq = min over factSeqs and step firstSeqs. */
function chapterEntry(
  chapter: Chapter, position: number, steps: readonly Step[], entries: EntryLookup, work: IndexWork,
): { anchor: number; entry: IndexEntry } {
  let anchor = Number.POSITIVE_INFINITY;
  for (const seq of chapter.factSeqs) if (seq < anchor) anchor = seq;
  let firstSeq = Number.POSITIVE_INFINITY;
  let lastSeq = Number.NEGATIVE_INFINITY;
  for (const id of chapter.stepIds) {
    const step = steps[stepPosition(entries, id)];
    if (step === undefined) continue;
    if (step.firstSeq < firstSeq) firstSeq = step.firstSeq;
    if (step.lastSeq > lastSeq) lastSeq = step.lastSeq;
  }
  work.links += chapter.stepIds.length;
  work.chapterEntries += 1;
  if (firstSeq < anchor) anchor = firstSeq;
  if (anchor === Number.POSITIVE_INFINITY) anchor = chapter.firstSeq;
  const hasSteps = firstSeq !== Number.POSITIVE_INFINITY;
  return {
    anchor,
    entry: {
      id: chapter.id, kind: "chapter", t0: chapter.tMs, t1: chapter.endTMs,
      firstSeq: hasSteps ? firstSeq : anchor, lastSeq: hasSteps ? lastSeq : anchor, parent: null, position,
    },
  };
}

/** step → its lowest-anchor chapter (the first in chapterIds on a tie). */
function stepEntry(step: Step, position: number, anchorOf: { get(id: UnitStableId): number | undefined }, work: IndexWork): IndexEntry {
  let parent: UnitStableId | null = null;
  let best = Number.POSITIVE_INFINITY;
  for (const chapterId of step.chapterIds) {
    const anchor = anchorOf.get(chapterId);
    if (anchor !== undefined && anchor < best) {
      best = anchor;
      parent = chapterId;
    }
  }
  work.links += step.chapterIds.length;
  work.stepEntries += 1;
  return {
    id: step.id, kind: "step", t0: step.tMs, t1: step.endTMs ?? step.tMs,
    firstSeq: step.firstSeq, lastSeq: step.lastSeq, parent, position,
  };
}

function sortedTurns(session: TraceSession, previous: IndexState | null): readonly Turn[] {
  if (previous !== null && previous.session.turns === session.turns) return previous.turns;
  return [...session.turns].sort((a, b) => a.startSeq - b.startSeq);
}

function findingMaps(session: TraceSession, previous: IndexState | null) {
  if (previous !== null && previous.session.findings === session.findings) {
    return { findingsBySeq: previous.findingsBySeq, findingsById: previous.findingsById };
  }
  return {
    findingsBySeq: [...session.findings].sort((a, b) => a.anchorSeq - b.anchorSeq || compareText(a.id, b.id)),
    findingsById: new Map<FindingId, Finding>(session.findings.map((f) => [f.id, f])),
  };
}

function freshState(session: TraceSession, work: IndexWork): CoreState {
  const steps = session.steps;
  const entries = new Map<string, IndexEntry>();
  // Step positions first: a chapter reads its steps' seqs through them.
  steps.forEach((step, position) => {
    entries.set(step.id, { id: step.id, kind: "step", t0: 0, t1: 0, firstSeq: 0, lastSeq: 0, parent: null, position });
  });
  const anchorOf = new Map<UnitStableId, number>();
  const chapterEntries: IndexEntry[] = [];
  const byAnchor = new Map<number, UnitStableId>();
  const currentByAnchor = new Map<number, UnitStableId[]>();
  session.chapters.forEach((chapter, position) => {
    const { anchor, entry } = chapterEntry(chapter, position, steps, entries, work);
    anchorOf.set(chapter.id, anchor);
    chapterEntries.push(entry);
    // Per chapter, not through anchorOf: with a repeated chapter id, anchorOf keeps only the last one's anchor.
    if (!byAnchor.has(anchor)) byAnchor.set(anchor, chapter.id);
    if (chapter.current) {
      const shared = currentByAnchor.get(anchor);
      if (shared === undefined) currentByAnchor.set(anchor, [chapter.id]);
      else shared.push(chapter.id);
    }
  });
  for (const shared of currentByAnchor.values()) shared.sort(compareText);
  for (const entry of chapterEntries) entries.set(entry.id, entry);
  steps.forEach((step, position) => entries.set(step.id, stepEntry(step, position, anchorOf, work)));
  return {
    session,
    entries: LayeredMap.from(entries),
    anchorOf: LayeredMap.from(anchorOf),
    byAnchor: LayeredMap.from(byAnchor),
    currentByAnchor: LayeredMap.from<number, readonly UnitStableId[]>(currentByAnchor),
    stepFirstSeqs: Int32Array.from(steps, (s) => s.firstSeq),
    incremental: entries.size === steps.length + session.chapters.length,
    joins: null,
    consumed: false,
    changes: null,
  };
}

/** First index in the id-sorted list whose id is not below `id`. */
function sortedIndex(list: readonly UnitStableId[], id: UnitStableId): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareText(list[mid] ?? "", id) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function addJoin<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key);
  if (set === undefined) map.set(key, new Set([value]));
  else set.add(value);
}

function dropJoin<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key);
  if (set === undefined) return;
  set.delete(value);
  if (set.size === 0) map.delete(key);
}

function joinsOf(state: IndexState): Joins {
  const { session, anchorOf } = state;
  const chaptersOfStep = new Map<StepId, Set<UnitStableId>>();
  const stepsOfChapter = new Map<UnitStableId, Set<StepId>>();
  const chaptersAtAnchor = new Map<number, Set<UnitStableId>>();
  for (const chapter of session.chapters) {
    for (const id of chapter.stepIds) addJoin(chaptersOfStep, id, chapter.id);
    const anchor = anchorOf.get(chapter.id);
    if (anchor !== undefined) addJoin(chaptersAtAnchor, anchor, chapter.id);
  }
  for (const step of session.steps) for (const id of step.chapterIds) addJoin(stepsOfChapter, id, step.id);
  return { chaptersOfStep, stepsOfChapter, chaptersAtAnchor };
}

/**
 * Positions whose object is new, replaced or moved since `before`, and how many of `before`'s ids are still
 * present. Same-position identity is checked first, so an append-only commit costs no map reads for kept items.
 */
function diffList<T extends { id: string }>(
  items: readonly T[], before: readonly T[], kind: IndexEntry["kind"], entries: EntryLookup,
  onChanged: (item: T, position: number, was: T | undefined) => void,
): number {
  let kept = 0;
  /** Ids the slow path has already counted: a repeated id keeps one earlier entry, not one per copy. */
  const counted = new Set<string>();
  for (let position = 0; position < items.length; position += 1) {
    const item = items[position] as T;
    if (before[position] === item) {
      kept += 1;
      continue;
    }
    const old = entries.get(item.id);
    const was = old?.kind === kind ? before[old.position] : undefined;
    // Each earlier id counts once: a second copy of an id that still sits at its old position keeps nothing, and
    // a repeat anywhere keeps nothing more, so [A, B] -> [A, A] and [A, B, C] -> [B, A, A] report the removed ids
    // as gone and the entry-count guard sees the repeat (review m1).
    if (
      was !== undefined && was.id === item.id && !counted.has(item.id) &&
      (old?.position === position || items[old?.position ?? -1]?.id !== item.id)
    ) {
      counted.add(item.id);
      kept += 1;
    }
    onChanged(item, position, was?.id === item.id ? was : undefined);
  }
  return kept;
}

/**
 * The previous build's state updated to `session`. Relies only on the session's own fields, and on object identity
 * as a shortcut: an unchanged Step or Chapter object (spec §6.4) keeps its entry unless a join it reads moved. A
 * chapter entry reads its steps' firstSeq and lastSeq; a step entry reads its chapters' anchors; the anchor maps
 * read chapter anchors, positions and `current`.
 */
function nextState(prev: IndexState, session: TraceSession, work: IndexWork): CoreState {
  const before = prev.session;
  const joins = prev.joins ?? joinsOf(prev);
  const { chaptersOfStep, stepsOfChapter, chaptersAtAnchor } = joins;
  const steps = session.steps;
  const chapters = session.chapters;
  const entries = prev.entries.fork();
  const anchorOf = prev.anchorOf.fork();
  /** Ids whose entry this build set or removed: every other entry is the previous index's object. */
  const changed = new Set<string>();

  // Steps: new, moved or replaced objects get a new entry below; a changed firstSeq or lastSeq (or a step that
  // appeared or went) reaches every chapter that lists the step.
  const dirtySteps = new Set<number>();
  const seqMoved: StepId[] = [];
  if (steps !== before.steps) {
    const kept = diffList(steps, before.steps, "step", prev.entries, (step, position, was) => {
      dirtySteps.add(position);
      if (was === undefined || was.firstSeq !== step.firstSeq || was.lastSeq !== step.lastSeq) seqMoved.push(step.id);
      if (was !== step) {
        if (was !== undefined) for (const id of was.chapterIds) dropJoin(stepsOfChapter, id, was.id);
        for (const id of step.chapterIds) addJoin(stepsOfChapter, id, step.id);
      }
      // The position must be current before any chapter reads it; the rest is filled in below.
      entries.set(step.id, { id: step.id, kind: "step", t0: 0, t1: 0, firstSeq: 0, lastSeq: 0, parent: null, position });
      changed.add(step.id);
    });
    if (kept < before.steps.length) {
      const present = new Set<string>(steps.map((step) => step.id));
      for (const was of before.steps) {
        if (present.has(was.id)) continue;
        entries.delete(was.id);
        changed.add(was.id);
        seqMoved.push(was.id);
        for (const id of was.chapterIds) dropJoin(stepsOfChapter, id, was.id);
      }
    }
  }

  // Chapters: new, moved or replaced objects, plus those listing a step whose seqs moved. The anchors of any
  // chapter touched here (old and new) have their byAnchor and currentByAnchor rows redone.
  const dirtyChapters = new Set<number>();
  const anchorMoved = new Set<UnitStableId>();
  /** Per anchor, the chapters that left or joined it, or changed position or object while at it. */
  const touched = new Map<number, Set<UnitStableId>>();
  const moveAnchor = (id: UnitStableId, anchor: number | undefined): void => {
    const old = anchorOf.get(id);
    if (old !== undefined) addJoin(touched, old, id);
    if (anchor !== undefined) addJoin(touched, anchor, id);
    if (old === anchor) return;
    anchorMoved.add(id);
    if (old !== undefined) dropJoin(chaptersAtAnchor, old, id);
    if (anchor === undefined) anchorOf.delete(id);
    else {
      anchorOf.set(id, anchor);
      addJoin(chaptersAtAnchor, anchor, id);
    }
  };
  if (chapters !== before.chapters) {
    const kept = diffList(chapters, before.chapters, "chapter", prev.entries, (chapter, position, was) => {
      dirtyChapters.add(position);
      if (was !== chapter) {
        if (was !== undefined) for (const id of was.stepIds) dropJoin(chaptersOfStep, id, was.id);
        for (const id of chapter.stepIds) addJoin(chaptersOfStep, id, chapter.id);
      }
    });
    if (kept < before.chapters.length) {
      const present = new Set<string>(chapters.map((chapter) => chapter.id));
      for (const was of before.chapters) {
        if (present.has(was.id)) continue;
        entries.delete(was.id);
        changed.add(was.id);
        moveAnchor(was.id, undefined);
        for (const id of was.stepIds) dropJoin(chaptersOfStep, id, was.id);
      }
    }
  }
  for (const id of seqMoved) {
    for (const chapterId of chaptersOfStep.get(id) ?? []) {
      const entry = entries.get(chapterId);
      if (entry?.kind === "chapter") dirtyChapters.add(entry.position);
    }
  }
  for (const position of dirtyChapters) {
    const chapter = chapters[position];
    if (chapter === undefined) continue;
    const built = chapterEntry(chapter, position, steps, entries, work);
    moveAnchor(chapter.id, built.anchor);
    entries.set(chapter.id, built.entry);
    changed.add(chapter.id);
  }

  // Steps whose parent can change: their own object changed, or a chapter they list moved its anchor.
  for (const chapterId of anchorMoved) {
    for (const stepId of stepsOfChapter.get(chapterId) ?? []) {
      const entry = entries.get(stepId);
      if (entry?.kind === "step") dirtySteps.add(entry.position);
    }
  }
  for (const position of dirtySteps) {
    const step = steps[position];
    if (step === undefined) continue;
    entries.set(step.id, stepEntry(step, position, anchorOf, work));
    changed.add(step.id);
  }

  // byAnchor: the first chapter (by position) at an anchor; currentByAnchor: the current ones by id. Chapters no
  // build touched keep their position and anchor, so only the touched ones are placed (soak chapters share a few
  // anchors by the thousand: the first shared run's seq).
  let byAnchor = prev.byAnchor;
  let currentByAnchor = prev.currentByAnchor;
  if (touched.size > 0) {
    byAnchor = byAnchor.fork();
    currentByAnchor = currentByAnchor.fork();
    const positionOf = (id: UnitStableId): number => {
      const entry = entries.get(id);
      return entry?.kind === "chapter" ? entry.position : -1;
    };
    for (const [anchor, ids] of touched) {
      work.anchors += 1;
      const here = chaptersAtAnchor.get(anchor);
      let first = byAnchor.get(anchor);
      if (first === undefined || ids.has(first)) {
        // The old first moved: scan every chapter at the anchor.
        first = undefined;
        for (const id of here ?? []) if (first === undefined || positionOf(id) < positionOf(first)) first = id;
      } else {
        for (const id of ids) if (here?.has(id) === true && positionOf(id) < positionOf(first)) first = id;
      }
      if (first === undefined) byAnchor.delete(anchor);
      else byAnchor.set(anchor, first);

      const current = [...(currentByAnchor.get(anchor) ?? NO_CHAPTERS)];
      for (const id of ids) {
        const at = sortedIndex(current, id);
        const listed = current[at] === id;
        const wanted = here?.has(id) === true && chapters[positionOf(id)]?.current === true;
        if (listed && !wanted) current.splice(at, 1);
        else if (!listed && wanted) current.splice(at, 0, id);
      }
      if (current.length === 0) currentByAnchor.delete(anchor);
      else currentByAnchor.set(anchor, current);
    }
  }

  prev.consumed = true;
  return {
    session,
    entries,
    anchorOf,
    byAnchor,
    currentByAnchor,
    stepFirstSeqs: steps === before.steps ? prev.stepFirstSeqs : Int32Array.from(steps, (s) => s.firstSeq),
    incremental: entries.size === steps.length + chapters.length,
    joins,
    consumed: false,
    changes: { entries: changed, anchors: anchorMoved },
  };
}

/**
 * The index of `session`. With `previous` (the index of an earlier session of the same trace, typically the last
 * commit's), it starts from that index's state and recomputes only the entries the changed objects reach; the result
 * always equals a fresh build (trace-index.incremental.property.test.ts). An index can seed one later build; a second
 * build from it, or one for another session id, is a fresh build.
 */
export function buildTraceIndex(session: TraceSession, previous?: TraceIndex): TraceIndex {
  const prev = previous === undefined ? undefined : STATES.get(previous);
  if (previous !== undefined && prev?.session === session) return previous;
  const usable = prev !== undefined && !prev.consumed && prev.incremental && prev.session.meta.sessionId === session.meta.sessionId;
  const work: IndexWork = { stepEntries: 0, chapterEntries: 0, anchors: 0, links: 0, full: !usable };
  let core = usable ? nextState(prev, session, work) : freshState(session, work);
  if (!core.incremental && usable) {
    // A repeated id: positions and joins by id no longer describe the session.
    Object.assign(work, { stepEntries: 0, chapterEntries: 0, anchors: 0, links: 0, full: true });
    core = freshState(session, work);
  }
  const state: IndexState = {
    ...core,
    turns: sortedTurns(session, usable ? prev : null),
    ...findingMaps(session, usable ? prev : null),
  };
  const index = indexOf(state);
  STATES.set(index, state);
  WORK.set(index, work);
  if (usable && state.changes !== null && previous !== undefined) CHANGES.set(index, { from: previous, ...state.changes });
  // Only the newest link keeps its predecessor: an entry here holds `from` strongly, so leaving the previous index's
  // entry would keep every Live commit's index and session reachable from the newest one (review I2). The overview
  // reads the changes of the index it is building for, never of an older one.
  if (previous !== undefined) CHANGES.delete(previous);
  return index;
}

export interface TraceIndexChanges {
  /** The index this one was built from. */
  readonly from: TraceIndex;
  /** Ids whose entry differs from `from`'s (set or removed); every other id reads the same IndexEntry object. */
  readonly entries: ReadonlySet<string>;
  /** Chapters whose anchor (and so chapterKey) differs from `from`'s, or that appeared or went. */
  readonly anchors: ReadonlySet<UnitStableId>;
}

const CHANGES = new WeakMap<TraceIndex, TraceIndexChanges>();

/** How `index` differs from the index it was built from; undefined for a fresh build. */
export function traceIndexChanges(index: TraceIndex): TraceIndexChanges | undefined {
  return CHANGES.get(index);
}

function indexOf(state: IndexState): TraceIndex {
  const { session, entries, anchorOf, byAnchor, currentByAnchor, stepFirstSeqs, turns, findingsBySeq, findingsById } = state;
  const steps = session.steps;
  const atSeq = new Map<number, Chapter | undefined>();
  return {
    sessionId: session.meta.sessionId,
    session,
    loadedThroughSeq: session.loadedThroughSeq,
    stepFirstSeqs,
    entry: (id) => entries.get(id),
    stepIndexAtOrBefore: (seq) => upperBound(stepFirstSeqs, seq) - 1,
    stepIndexAtOrAfter: (seq) => lowerBound(stepFirstSeqs, seq),
    chapterKey: (id) => {
      const anchor = anchorOf.get(id);
      return anchor === undefined ? undefined : `ch:${anchor}`;
    },
    chapterAnchor: (id) => anchorOf.get(id),
    chapterByAnchor: (anchorSeq) => currentByAnchor.get(anchorSeq)?.[0] ?? byAnchor.get(anchorSeq),
    chaptersByAnchor: (anchorSeq) => currentByAnchor.get(anchorSeq) ?? NO_CHAPTERS,
    chapterAtSeq: (seq) => {
      // O(chapters), and several selectors ask each commit for the same seq (the live playhead).
      if (atSeq.has(seq)) return atSeq.get(seq);
      if (atSeq.size >= 64) atSeq.clear();
      let found: Chapter | undefined;
      let bestAnchor = Number.NEGATIVE_INFINITY;
      for (const chapter of session.chapters) {
        if (!chapter.current) continue;
        const e = entries.get(chapter.id);
        const anchor = anchorOf.get(chapter.id) ?? Number.NEGATIVE_INFINITY;
        if (e !== undefined && e.firstSeq <= seq && seq <= e.lastSeq && anchor > bestAnchor) {
          bestAnchor = anchor;
          found = chapter;
        }
      }
      atSeq.set(seq, found);
      return found;
    },
    turnAtSeq: (seq) => {
      let found: Turn | undefined = turns[0];
      for (const turn of turns) {
        if (turn.startSeq <= seq) found = turn;
        else break;
      }
      return found;
    },
    findingsBySeq,
    tailStepId: steps[steps.length - 1]?.id ?? null,
    findingsById,
  };
}

export function emptyTraceIndex(sessionId: string): TraceIndex {
  return {
    sessionId,
    session: null,
    loadedThroughSeq: 0,
    stepFirstSeqs: new Int32Array(0),
    entry: () => undefined,
    stepIndexAtOrBefore: () => -1,
    stepIndexAtOrAfter: () => 0,
    chapterKey: () => undefined,
    chapterAnchor: () => undefined,
    chapterByAnchor: () => undefined,
    chaptersByAnchor: () => NO_CHAPTERS,
    chapterAtSeq: () => undefined,
    turnAtSeq: () => undefined,
    findingsBySeq: [],
    tailStepId: null,
    findingsById: new Map(),
  };
}

/**
 * Inclusive seq range; "live" → loadedThroughSeq. A chapter brush spans every current chapter that shares its
 * anchor, so `b` never drops a selection inside the playhead's chapter; with no chapter it falls back to its turn.
 */
export function brushSeqRange(brush: Brush, index: TraceIndex): { fromSeq: number; toSeq: number } {
  const loaded = Math.max(1, index.loadedThroughSeq);
  if (brush.kind === "session") return { fromSeq: 1, toSeq: loaded };
  if (brush.kind === "range") {
    const to = brush.toSeq === "live" ? loaded : brush.toSeq;
    const from = Math.max(1, Math.min(brush.fromSeq, to));
    return { fromSeq: from, toSeq: Math.max(from, to) };
  }
  let fromSeq = Number.POSITIVE_INFINITY;
  let toSeq = Number.NEGATIVE_INFINITY;
  for (const shared of index.chaptersByAnchor(brush.anchorSeq)) {
    const e = index.entry(shared);
    if (e === undefined) continue;
    fromSeq = Math.min(fromSeq, e.firstSeq);
    toSeq = Math.max(toSeq, e.lastSeq);
  }
  if (fromSeq <= toSeq) return { fromSeq, toSeq };
  const id = index.chapterByAnchor(brush.anchorSeq);
  const entry = id === undefined ? undefined : index.entry(id);
  if (entry !== undefined) return { fromSeq: entry.firstSeq, toSeq: entry.lastSeq };
  const turn = index.turnAtSeq(brush.anchorSeq);
  if (turn !== undefined) return { fromSeq: turn.startSeq, toSeq: Math.max(turn.startSeq, turn.endSeq) };
  return { fromSeq: brush.anchorSeq, toSeq: brush.anchorSeq };
}

export function effectivePlayheadSeq(playhead: Playhead, selection: SelectionId | null, index: TraceIndex): number {
  if (playhead.kind === "live") return index.loadedThroughSeq;
  if (playhead.kind === "free") return playhead.seq;
  const entry = selection === null ? undefined : index.entry(selection);
  return entry === undefined ? index.loadedThroughSeq : entry.firstSeq;
}

/**
 * The step's critical findings that open its row by themselves: only findings anchored on the step (one that merely
 * cites it never does), and none while another critical finding cites the step as evidence, because that finding's
 * card already shows it (a claim over its failing test run).
 */
export function autoExpandingFindings(step: Step, findingsById: ReadonlyMap<FindingId, Finding>): Finding[] {
  const own: Finding[] = [];
  for (const id of step.findingIds) {
    const finding = findingsById.get(id);
    if (finding?.severity !== "critical") continue;
    if (finding.anchorStepId !== step.id) return [];
    own.push(finding);
  }
  return own;
}

export function isStepExpanded(
  step: Step,
  findingsById: ReadonlyMap<FindingId, Finding>,
  expanded: ReadonlySet<string>,
  collapsed: ReadonlySet<string>,
): boolean {
  if (expanded.has(step.id)) return true;
  return autoExpandingFindings(step, findingsById).some((finding) => !collapsed.has(finding.id));
}

export function isKeyExpanded(key: string, index: TraceIndex, expanded: ReadonlySet<string>, collapsed: ReadonlySet<string>): boolean {
  if (expanded.has(key)) return true;
  if (key.startsWith("step:")) {
    const entry = index.entry(key);
    const step = entry === undefined ? undefined : index.session?.steps[entry.position];
    return step === undefined ? false : isStepExpanded(step, index.findingsById, expanded, collapsed);
  }
  if (key.startsWith("finding:")) {
    return index.findingsById.get(key as FindingId)?.severity === "critical" && !collapsed.has(key);
  }
  return false;
}
