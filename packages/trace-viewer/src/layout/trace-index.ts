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

export function buildTraceIndex(session: TraceSession): TraceIndex {
  const steps = session.steps;
  const stepFirstSeqs = Int32Array.from(steps, (s) => s.firstSeq);
  const entries = new Map<string, IndexEntry>();
  const positionOf = new Map<string, number>();
  steps.forEach((step, i) => positionOf.set(step.id, i));
  const anchorOf = new Map<UnitStableId, number>();
  const byAnchor = new Map<number, UnitStableId>();
  const currentByAnchor = new Map<number, UnitStableId[]>();

  session.chapters.forEach((chapter, position) => {
    const own = chapter.stepIds
      .map((id) => steps[positionOf.get(id) ?? -1])
      .filter((s): s is Step => s !== undefined);
    const candidates = [...chapter.factSeqs, ...own.map((s) => s.firstSeq)];
    const anchor = candidates.length > 0 ? Math.min(...candidates) : chapter.firstSeq;
    anchorOf.set(chapter.id, anchor);
    if (!byAnchor.has(anchor)) byAnchor.set(anchor, chapter.id);
    if (chapter.current) {
      const shared = currentByAnchor.get(anchor);
      if (shared === undefined) currentByAnchor.set(anchor, [chapter.id]);
      else shared.push(chapter.id);
    }
    const firstSeq = own.length > 0 ? Math.min(...own.map((s) => s.firstSeq)) : anchor;
    const lastSeq = own.length > 0 ? Math.max(...own.map((s) => s.lastSeq)) : anchor;
    entries.set(chapter.id, { id: chapter.id, kind: "chapter", t0: chapter.tMs, t1: chapter.endTMs, firstSeq, lastSeq, parent: null, position });
  });

  for (const shared of currentByAnchor.values()) shared.sort(compareText);

  steps.forEach((step, position) => {
    let parent: UnitStableId | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const chapterId of step.chapterIds) {
      const anchor = anchorOf.get(chapterId);
      if (anchor !== undefined && anchor < best) {
        best = anchor;
        parent = chapterId;
      }
    }
    entries.set(step.id, {
      id: step.id, kind: "step", t0: step.tMs, t1: step.endTMs ?? step.tMs,
      firstSeq: step.firstSeq, lastSeq: step.lastSeq, parent, position,
    });
  });

  const turns = [...session.turns].sort((a, b) => a.startSeq - b.startSeq);
  const findingsBySeq = [...session.findings].sort((a, b) => a.anchorSeq - b.anchorSeq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const findingsById = new Map<FindingId, Finding>(session.findings.map((f) => [f.id, f]));

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
    chapterByAnchor: (anchorSeq) => currentByAnchor.get(anchorSeq)?.[0] ?? byAnchor.get(anchorSeq),
    chaptersByAnchor: (anchorSeq) => currentByAnchor.get(anchorSeq) ?? NO_CHAPTERS,
    chapterAtSeq: (seq) => {
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
