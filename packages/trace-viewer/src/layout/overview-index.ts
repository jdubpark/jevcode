import {
  LANES,
  type Chapter, type Finding, type FindingId, type Lane, type Step, type StepId, type StepKind, type TraceSession,
  type TurnTrigger, type UnitStableId,
} from "../model/index.js";
import type { ScaleSegment, TimeScale } from "./time-scale.js";
import { anchoredFindings, stepTone, worstSeverity, type Tone } from "./tone.js";
import { traceIndexChanges, type IndexEntry, type TraceIndex } from "./trace-index.js";

export type Glyph = "dot" | "ring" | "bar" | "hist" | "wait";
export type PinRule = "always" | "finding" | "never";

/** Spec §7.6.1: the lane is a model fact; the glyph and pin rule are drawing choices. */
export const PLACEMENT: { readonly [K in StepKind]: { glyph: Glyph; pin: PinRule; echo?: Lane } } = {
  instruction: { glyph: "dot", pin: "always" },
  decision: { glyph: "wait", pin: "always" },
  approval: { glyph: "wait", pin: "always" },
  message: { glyph: "dot", pin: "finding" },
  reasoning: { glyph: "dot", pin: "finding" },
  lifecycle: { glyph: "dot", pin: "finding" },
  tool: { glyph: "bar", pin: "finding" },
  command: { glyph: "bar", pin: "finding" },
  test: { glyph: "bar", pin: "finding", echo: "commands" },
  check: { glyph: "bar", pin: "finding", echo: "commands" },
  edit: { glyph: "hist", pin: "finding" },
  dependency: { glyph: "hist", pin: "finding" },
  revert: { glyph: "hist", pin: "finding" },
  read: { glyph: "ring", pin: "never" },
  // A warning-or-worse clamp anchors a guardrail_clamp finding; info clamps are pipeline noise and
  // attention rows never pin, so the lane's pins are real guardrail hits only (visual audit 2-10).
  guardrail: { glyph: "dot", pin: "finding" },
  attention: { glyph: "dot", pin: "never" },
};

export const GLYPH_CODE: { readonly [G in Glyph]: number } = { dot: 0, ring: 1, bar: 2, hist: 3, wait: 4 };
export const TONE_CODE: { readonly [T in Tone]: number } = { neutral: 0, bad: 1, good: 2 };

export type PinKind = "critical_finding" | "failed" | "decision" | "approval" | "instruction" | "guardrail" | "finding" | "other";
/** Higher wins a cluster's icon: critical finding > failed > decision/approval > instruction > guardrail > other. */
export const PIN_PRIORITY: { readonly [K in PinKind]: number } = {
  critical_finding: 7, failed: 6, decision: 5, approval: 5, instruction: 4, guardrail: 3, finding: 2, other: 1,
};

export interface LaneMarks {
  readonly count: number;
  /** Sorted ascending by u0. */
  readonly u0: Float64Array;
  readonly u1: Float64Array;
  /** Index into session.steps. */
  readonly step: Int32Array;
  readonly glyph: Uint8Array;
  readonly tone: Uint8Array;
  readonly added: Float64Array;
  readonly removed: Float64Array;
  readonly problem: Uint8Array;
  /** 1 when the step is noise (drawn per level). */
  readonly noise: Uint8Array;
  /** Longest u1 − u0 on the lane, for the visible-range binary search. */
  readonly maxSpan: number;
}
export interface PinCandidate { stepIndex: number; lane: Lane; u: number; kind: PinKind; critical: boolean; findingId: FindingId | null }
export interface BandSpan { key: `ch:${number}` | `turn:${number}`; id: UnitStableId | null; u0: number; u1: number; title: string }
export interface OverviewIndex {
  readonly endU: number;
  readonly lanes: { readonly [L in Lane]: LaneMarks };
  readonly pins: readonly PinCandidate[];
  /** Chapters, or turns when the session has no chapters. */
  readonly bands: readonly BandSpan[];
  readonly turns: readonly { index: number; u: number; trigger: TurnTrigger }[];
  readonly links: readonly { findingId: FindingId; fromStep: number; toStep: number }[];
}

interface Row { u0: number; u1: number; step: number; glyph: number; tone: number; added: number; removed: number; problem: number; noise: number }


/** The pin's own finding: the first anchored finding in FINDING_ORDER; one that only cites the step never names it. */
function mostSevere(step: Step, findingsById: ReadonlyMap<FindingId, Finding>): FindingId | null {
  return anchoredFindings(step, findingsById)[0]?.id ?? null;
}

function toMarks(rows: Row[]): LaneMarks {
  rows.sort((a, b) => a.u0 - b.u0 || a.step - b.step);
  const n = rows.length;
  const marks = {
    count: n,
    u0: new Float64Array(n), u1: new Float64Array(n), step: new Int32Array(n), glyph: new Uint8Array(n), tone: new Uint8Array(n),
    added: new Float64Array(n), removed: new Float64Array(n), problem: new Uint8Array(n), noise: new Uint8Array(n), maxSpan: 0,
  };
  rows.forEach((r, i) => {
    marks.u0[i] = r.u0;
    marks.u1[i] = r.u1;
    marks.step[i] = r.step;
    marks.glyph[i] = r.glyph;
    marks.tone[i] = r.tone;
    marks.added[i] = r.added;
    marks.removed[i] = r.removed;
    marks.problem[i] = r.problem;
    marks.noise[i] = r.noise;
    marks.maxSpan = Math.max(marks.maxSpan, r.u1 - r.u0);
  });
  return marks;
}

function pinKind(step: Step, critical: boolean, hasFinding: boolean): PinKind {
  if (critical) return "critical_finding";
  if (step.status === "failed") return "failed";
  if (step.kind === "decision") return "decision";
  if (step.kind === "approval") return "approval";
  if (step.kind === "instruction") return "instruction";
  if (step.kind === "guardrail") return "guardrail";
  return hasFinding ? "finding" : "other";
}

/** A step's marks and pin, as the step at `position` reads them: kept while the step object, its position, the findings
 *  it lists and the scale up to `tEnd` are unchanged. */
interface StepMarks {
  readonly step: Step;
  readonly position: number;
  /** The latest time the marks read through the scale. */
  readonly tEnd: number;
  readonly findings: readonly (Finding | undefined)[];
  readonly own: Row;
  readonly echo: { lane: Lane; row: Row } | null;
  readonly pin: PinCandidate | null;
}

/** A current chapter's band pieces: kept while the chapter object, its key, the index entries of its footprint steps
 *  and the scale up to `tEnd` are unchanged. */
interface ChapterBands {
  readonly chapter: Chapter;
  readonly key: BandSpan["key"];
  readonly ids: readonly StepId[];
  readonly entries: readonly (IndexEntry | undefined)[];
  readonly tEnd: number;
  readonly pieces: readonly BandSpan[];
  /** The build that last kept or made it; a set left behind drops out of `footprints`. */
  seenIn: number;
}

/** What a build keeps for the next one; taken by the first build that starts from it. */
interface OverviewState {
  readonly session: TraceSession;
  readonly scale: TimeScale;
  readonly findingsById: ReadonlyMap<FindingId, Finding>;
  readonly steps: readonly StepMarks[];
  readonly index: TraceIndex;
  /** By position in session.chapters; null for a chapter that is not current or has no key. */
  readonly chapters: readonly (ChapterBands | null)[];
  /** Footprint step id → the band sets that read its entry; moved to the next build. */
  readonly footprints: Map<StepId, Set<ChapterBands>>;
  consumed: boolean;
}

let generation = 0;

/** Marks and band sets a build computed (not reused): a regression gauge for tests. */
export interface OverviewWork { steps: number; chapters: number; lanes: number; full: boolean }

const STATES = new WeakMap<OverviewIndex, OverviewState>();
const WORK = new WeakMap<OverviewIndex, OverviewWork>();

export function overviewIndexWork(overview: OverviewIndex): OverviewWork | undefined {
  return WORK.get(overview);
}

/** Two segments that map time to u the same way (toU reads t0, u0, the idle-ness and the span, not the idle reason). */
function sameMapping(a: ScaleSegment | undefined, b: ScaleSegment | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return a.t0 === b.t0 && a.t1 === b.t1 && a.u0 === b.u0 && a.u1 === b.u1 && (a.idle === null) === (b.idle === null);
}

/**
 * A time below which both scales map every t to the same u: the start of the first segment where they differ, or
 * that segment's nearer end when only its end moved (a live end grows the last gap), or +∞ when they map alike.
 * Marks and bands that read only times below it keep their u.
 */
export function stableBeforeT(a: TimeScale, b: TimeScale): number {
  if (a === b) return Number.POSITIVE_INFINITY;
  const n = Math.min(a.segments.length, b.segments.length);
  let k = 0;
  while (k < n && sameMapping(a.segments[k], b.segments[k])) k += 1;
  const sa = a.segments[k];
  const sb = b.segments[k];
  if (sa === undefined && sb === undefined) {
    // Same segments: past the end, toU is endU + (t − endT).
    return a.endT === b.endT && a.endU === b.endU ? Number.POSITIVE_INFINITY : Math.min(a.endT, b.endT);
  }
  // The same start and kind: both map t in [t0, the nearer end) by the same formula.
  if (sa !== undefined && sb !== undefined && sa.t0 === sb.t0 && sa.u0 === sb.u0 && (sa.idle === null) === (sb.idle === null)) {
    return Math.min(sa.t1, sb.t1);
  }
  return Math.min(sa?.t0 ?? a.endT, sb?.t0 ?? b.endT);
}

function sameFindings(step: Step, findingsById: ReadonlyMap<FindingId, Finding>, kept: readonly (Finding | undefined)[]): boolean {
  if (step.findingIds.length !== kept.length) return false;
  for (let i = 0; i < kept.length; i += 1) if (findingsById.get(step.findingIds[i] as FindingId) !== kept[i]) return false;
  return true;
}

function stepMarks(step: Step, position: number, findingsById: ReadonlyMap<FindingId, Finding>, scale: TimeScale): StepMarks {
  const place = PLACEMENT[step.kind];
  const end = step.tMs + Math.max(0, step.durationMs ?? 0);
  const u0 = scale.toU(step.tMs);
  const u1 = Math.max(u0, scale.toU(end));
  const tone = stepTone(step, findingsById);
  const own: Row = {
    u0, u1, step: position, glyph: GLYPH_CODE[place.glyph], tone: TONE_CODE[tone],
    added: step.edit?.added ?? 0, removed: step.edit?.removed ?? 0, problem: tone === "bad" ? 1 : 0, noise: step.noise === null ? 0 : 1,
  };
  const echo = place.echo === undefined
    ? null
    : { lane: place.echo, row: { u0, u1, step: position, glyph: GLYPH_CODE.bar, tone: TONE_CODE.neutral, added: 0, removed: 0, problem: 0, noise: 0 } };
  const hasFinding = step.findingIds.length > 0;
  const pinned = place.pin === "always" || (place.pin === "finding" && (hasFinding || step.status === "failed"));
  let pin: PinCandidate | null = null;
  if (pinned) {
    const critical = worstSeverity(step, findingsById) === "critical";
    pin = {
      stepIndex: position, lane: step.lane, u: place.glyph === "wait" ? u1 : u0,
      kind: pinKind(step, critical, hasFinding), critical, findingId: mostSevere(step, findingsById),
    };
  }
  return {
    step, position, tEnd: Math.max(step.tMs, end), findings: step.findingIds.map((id) => findingsById.get(id)),
    own, echo, pin,
  };
}

function chapterBands(chapter: Chapter, key: BandSpan["key"], index: TraceIndex, scale: TimeScale): ChapterBands {
  // A run the chapter reaches only through a (often shared) validation is not its footprint:
  // otherwise every band stacks over the one test run all units cite (ruling M6).
  const validationOnly = chapter.validationOnlyStepIds ?? [];
  const skip = validationOnly.length === 0 ? null : new Set(validationOnly);
  const ids = skip === null ? chapter.stepIds : chapter.stepIds.filter((id) => !skip.has(id));
  const entries = ids.map((id) => index.entry(id));
  // Band labels are short (§7.6.1); placeholder unit titles do not fit any band (ruling M2).
  const title = chapter.shortTitle ?? chapter.title;
  let tEnd = Number.NEGATIVE_INFINITY;
  const spans: [number, number][] = [];
  for (const e of entries) {
    if (e === undefined) continue;
    spans.push([scale.toU(e.t0), scale.toU(e.t1)]);
    tEnd = Math.max(tEnd, e.t0, e.t1);
  }
  spans.sort((a, b) => a[0] - b[0]);
  if (spans.length === 0) {
    spans.push([scale.toU(chapter.tMs), scale.toU(chapter.endTMs)]);
    tEnd = Math.max(chapter.tMs, chapter.endTMs);
  }
  const pieces: BandSpan[] = [];
  let piece: [number, number] | null = null;
  for (const span of spans) {
    if (piece !== null && span[0] <= piece[1]) piece[1] = Math.max(piece[1], span[1]);
    else {
      if (piece !== null) pieces.push({ key, id: chapter.id, u0: piece[0], u1: piece[1], title });
      piece = [span[0], span[1]];
    }
  }
  if (piece !== null) pieces.push({ key, id: chapter.id, u0: piece[0], u1: piece[1], title });
  return { chapter, key, ids, entries, tEnd, pieces, seenIn: generation };
}

function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key);
  if (set === undefined) map.set(key, new Set([value]));
  else set.add(value);
}

/** The per-link check, when the index was not built straight from the previous overview's index. */
function keptBands(kept: ChapterBands, chapter: Chapter, key: BandSpan["key"], index: TraceIndex, stableBefore: number): boolean {
  if (kept.chapter !== chapter || kept.key !== key || !(kept.tEnd < stableBefore)) return false;
  for (let i = 0; i < kept.ids.length; i += 1) if (index.entry(kept.ids[i] as StepId) !== kept.entries[i]) return false;
  return true;
}

/**
 * Struct-of-arrays marks per lane, pin candidates, band spans, turns and ≠ links. With `previous` (the overview of an
 * earlier commit of the same trace), a step's marks and a chapter's band pieces are kept while what they read is
 * unchanged, including the scale below the point where it moved (stableBeforeT); a lane whose marks are all kept keeps
 * its LaneMarks. The result always equals a fresh build (overview-index.incremental.property.test.ts).
 */
export function buildOverviewIndex(session: TraceSession, index: TraceIndex, scale: TimeScale, previous?: OverviewIndex): OverviewIndex {
  const found = previous === undefined ? undefined : STATES.get(previous);
  const prev = found !== undefined && !found.consumed && found.session.meta.sessionId === session.meta.sessionId ? found : null;
  if (prev !== null) prev.consumed = true;
  const work: OverviewWork = { steps: 0, chapters: 0, lanes: 0, full: prev === null };
  const stableBefore = prev === null ? Number.NEGATIVE_INFINITY : stableBeforeT(prev.scale, scale);
  const findingsById = index.findingsById;
  const findingsSame = prev?.findingsById === findingsById;
  const prevSteps = prev?.steps ?? [];
  const prevChapters = prev?.chapters ?? [];

  const dirtyLanes = new Set<Lane>();
  const touch = (marks: StepMarks): void => {
    dirtyLanes.add(marks.step.lane);
    if (marks.echo !== null) dirtyLanes.add(marks.echo.lane);
  };
  const steps: StepMarks[] = [];
  session.steps.forEach((step, position) => {
    const kept = prevSteps[position];
    if (
      kept !== undefined && kept.step === step && kept.tEnd < stableBefore &&
      (findingsSame || sameFindings(step, findingsById, kept.findings))
    ) {
      steps.push(kept);
      return;
    }
    const marks = stepMarks(step, position, findingsById, scale);
    work.steps += 1;
    if (kept !== undefined) touch(kept);
    touch(marks);
    steps.push(marks);
  });
  for (let position = session.steps.length; position < prevSteps.length; position += 1) {
    const gone = prevSteps[position];
    if (gone !== undefined) touch(gone);
  }

  const previousLanes = prev !== null && previous !== undefined ? previous.lanes : null;
  const lanes = {} as { [L in Lane]: LaneMarks };
  const rows = new Map<Lane, Row[]>();
  for (const lane of LANES) {
    const kept = previousLanes?.[lane];
    if (kept !== undefined && !dirtyLanes.has(lane)) lanes[lane] = kept;
    else rows.set(lane, []);
  }
  if (rows.size > 0) {
    for (const marks of steps) {
      rows.get(marks.step.lane)?.push(marks.own);
      if (marks.echo !== null) rows.get(marks.echo.lane)?.push(marks.echo.row);
    }
    for (const [lane, laneRows] of rows) {
      lanes[lane] = toMarks(laneRows);
      work.lanes += 1;
    }
  }
  const pins: PinCandidate[] = [];
  for (const marks of steps) if (marks.pin !== null) pins.push(marks.pin);

  const bands: BandSpan[] = [];
  const chapters: (ChapterBands | null)[] = [];
  const footprints = prev?.footprints ?? new Map<StepId, Set<ChapterBands>>();
  const gen = (generation += 1);
  // Built straight from the previous overview's index: only the ids it lists have a new entry, and only the chapters
  // it lists have a new key. Otherwise each kept band set checks its footprint entries one by one.
  const changes = traceIndexChanges(index);
  const direct = prev !== null && changes?.from === prev.index ? changes : null;
  let dirty: Set<ChapterBands> | null = null;
  if (direct !== null) {
    dirty = new Set();
    for (const id of direct.entries) for (const set of footprints.get(id as StepId) ?? []) dirty.add(set);
  }
  const current = session.chapters.filter((c) => c.current);
  if (current.length > 0) {
    let byObject: Map<Chapter, ChapterBands> | null = null;
    session.chapters.forEach((chapter, position) => {
      if (!chapter.current) {
        chapters.push(null);
        return;
      }
      let kept = prevChapters[position];
      // Another chapter id here: this one may have moved. The same id with a new object was replaced, not moved.
      if (kept?.chapter !== chapter && kept?.chapter.id !== chapter.id && prevChapters.length > 0) {
        byObject ??= new Map(prevChapters.filter((c): c is ChapterBands => c !== null).map((c) => [c.chapter, c]));
        kept = byObject.get(chapter);
      }
      const known = kept?.chapter === chapter ? kept : null;
      const key = direct !== null && known !== null && !direct.anchors.has(chapter.id) ? known.key : index.chapterKey(chapter.id);
      if (key === undefined) {
        chapters.push(null);
        return;
      }
      let entry: ChapterBands;
      if (
        known !== null && known.key === key && known.tEnd < stableBefore &&
        (dirty !== null ? !dirty.has(known) : keptBands(known, chapter, key, index, stableBefore))
      ) {
        entry = known;
      } else {
        entry = chapterBands(chapter, key, index, scale);
        for (const id of entry.ids) addTo(footprints, id, entry);
        work.chapters += 1;
      }
      entry.seenIn = gen;
      chapters.push(entry);
      for (const piece of entry.pieces) bands.push(piece);
    });
  } else {
    for (const turn of session.turns) {
      bands.push({ key: `turn:${turn.index}`, id: null, u0: scale.toU(turn.tMs), u1: scale.toU(turn.endTMs), title: `Turn ${turn.index + 1}` });
    }
  }
  for (const gone of prevChapters) {
    if (gone === null || gone === undefined || gone.seenIn === gen) continue;
    for (const id of gone.ids) {
      const sets = footprints.get(id);
      sets?.delete(gone);
      if (sets?.size === 0) footprints.delete(id);
    }
  }
  bands.sort((a, b) => a.u0 - b.u0 || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const links: { findingId: FindingId; fromStep: number; toStep: number }[] = [];
  for (const finding of session.findings) {
    if (finding.ruleId !== "claim_contradicted") continue;
    const from = index.entry(finding.claimStepId ?? finding.anchorStepId)?.position;
    const evidence = finding.evidenceStepIds?.[0];
    const to = evidence === undefined ? undefined : index.entry(evidence)?.position;
    if (from !== undefined && to !== undefined) links.push({ findingId: finding.id, fromStep: from, toStep: to });
  }

  const overview: OverviewIndex = {
    endU: scale.endU,
    lanes,
    pins,
    bands,
    turns: session.turns.map((turn) => ({ index: turn.index, u: scale.toU(turn.tMs), trigger: turn.trigger })),
    links,
  };
  bandGroupsOf(overview);
  STATES.set(overview, { session, scale, findingsById, steps, index, chapters, footprints, consumed: false });
  WORK.set(overview, work);
  return overview;
}

/** One band key's pieces, sorted by u0, with overlapping or touching pieces merged (they merge at
 *  every k). The merged piece keeps its first piece's id and title. u0 and u1 both ascend. */
export interface BandGroup {
  readonly key: BandSpan["key"];
  readonly id: readonly (UnitStableId | null)[];
  readonly title: readonly string[];
  readonly u0: Float64Array;
  readonly u1: Float64Array;
}

const BAND_GROUPS = new WeakMap<OverviewIndex, readonly BandGroup[]>();

/** The camera-independent half of band placement, computed once per OverviewIndex: soak-sized
 *  sessions have ~10^5 band pieces over a few hundred keys (spec §7.6.1, §10). */
export function bandGroupsOf(overview: OverviewIndex): readonly BandGroup[] {
  const cached = BAND_GROUPS.get(overview);
  if (cached !== undefined) return cached;
  const byKey = new Map<BandSpan["key"], BandSpan[]>();
  for (const band of overview.bands) {
    const list = byKey.get(band.key);
    if (list === undefined) byKey.set(band.key, [band]);
    else list.push(band);
  }
  const groups: BandGroup[] = [];
  for (const [key, pieces] of byKey) {
    // Stable: equal u0 keeps the index order, as the per-frame sort did.
    const sorted = [...pieces].sort((a, b) => a.u0 - b.u0);
    const id: (UnitStableId | null)[] = [];
    const title: string[] = [];
    const u0: number[] = [];
    const u1: number[] = [];
    for (const piece of sorted) {
      const last = u1.length - 1;
      if (last >= 0 && piece.u0 <= (u1[last] ?? Number.NEGATIVE_INFINITY)) {
        u1[last] = Math.max(u1[last] ?? piece.u1, piece.u1);
        continue;
      }
      id.push(piece.id);
      title.push(piece.title);
      u0.push(piece.u0);
      u1.push(piece.u1);
    }
    groups.push({ key, id, title, u0: Float64Array.from(u0), u1: Float64Array.from(u1) });
  }
  BAND_GROUPS.set(overview, groups);
  return groups;
}
