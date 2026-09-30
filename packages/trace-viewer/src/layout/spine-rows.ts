import {
  LANES,
  type Finding, type Lane, type Level, type NoiseReason, type Severity, type SignalId, type Step, type StepId, type StepKind,
  type TraceSession, type UnitStableId,
} from "../model/index.js";
import { BREAK_MIN_MS, type IdleReason, type TimeScale } from "./time-scale.js";
import { worstSeverity } from "./tone.js";
import { brushSeqRange, isStepExpanded, type Brush, type SelectionId, type TraceIndex } from "./trace-index.js";

export type SpineRow =
  | { t: "step"; key: StepId; step: number; expanded: boolean }
  | { t: "chapter"; key: `ch:${number}`; chapter: number }
  | { t: "noise"; key: `noise:${number}`; steps: number[]; label: string }
  | { t: "elided"; key: `elided:${number}`; steps: number[]; byLane: Record<Lane, number>; spanMs: number }
  | { t: "turn"; key: `turn:${number}`; turn: number }
  | { t: "idle"; key: `idle:${number}`; ms: number; reason: IdleReason }
  | { t: "gap"; key: `gap:${number}`; gap: number };

export const SPINE_ROW_PX = 32;
export const SPINE_SEPARATOR_PX = 24;
export const ELIDE_ABOVE_ROWS = 11;
export const ELIDE_HEAD = 3;
export const ELIDE_TAIL = 5;

export interface SpineRowsInput {
  brush: Brush;
  level: Level;
  playheadSeq: number;
  selection: SelectionId | null;
  expanded: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  matches?: ReadonlySet<string>;
  /** The still-growing tail segment is never elided. */
  live: boolean;
}

const PINNED_KINDS: ReadonlySet<StepKind> = new Set<StepKind>(["instruction", "decision", "approval"]);
const FINDING_ROW_PX: { readonly [K in SignalId]: number } = {
  claim_contradicted: 124, failing_tests: 112, destructive_command: 96, guardrail_clamp: 88, recovery_arc: 96,
};
const EXPANDED_ROW_PX = 96;
const SEVERITY_RANK: { readonly [S in Severity]: number } = { info: 0, warning: 1, critical: 2 };
const RULE_RANK: { readonly [K in SignalId]: number } = {
  claim_contradicted: 0, destructive_command: 1, failing_tests: 2, guardrail_clamp: 3, recovery_arc: 4,
};

const EDIT_ADJECTIVE: Partial<Record<NoiseReason, string>> = {
  lockfile: "lockfile", formatting: "formatting", superseded: "superseded", duplicate_poll: "repeated",
};
const NOUN: { readonly [R in NoiseReason]: [string, string] } = {
  read: ["read", "reads"],
  lockfile: ["lockfile edit", "lockfile edits"],
  formatting: ["formatting edit", "formatting edits"],
  duplicate_poll: ["repeated poll", "repeated polls"],
  lifecycle: ["lifecycle event", "lifecycle events"],
  pipeline: ["pipeline event", "pipeline events"],
  superseded: ["superseded edit", "superseded edits"],
  passing_test: ["passing test run", "passing test runs"],
};

/** "3 reads", "2 lockfile and formatting edits", "4 noise steps: reads, lifecycle events".
 *  Reasons are in first-appearance order. */
function noiseLabel(n: number, reasons: readonly NoiseReason[]): string {
  const only = reasons[0];
  if (reasons.length === 1 && only !== undefined) return `${n} ${NOUN[only][n === 1 ? 0 : 1]}`;
  if (reasons.length > 1 && reasons.every((r) => EDIT_ADJECTIVE[r] !== undefined)) {
    return `${n} ${reasons.map((r) => EDIT_ADJECTIVE[r]).join(" and ")} ${n === 1 ? "edit" : "edits"}`;
  }
  return `${n} noise steps: ${reasons.map((r) => NOUN[r][1]).join(", ")}`;
}

/** An open noise row's distinct reasons, kept while steps append so each label is built once. */
interface NoiseRun { row: Extract<SpineRow, { t: "noise" }>; reasons: NoiseReason[] }

function addReason(run: NoiseRun, reason: NoiseReason | null): void {
  if (reason !== null && !run.reasons.includes(reason)) run.reasons.push(reason);
}

interface Segment { rows: SpineRow[]; parent: string | null; turn: number }

function emitSegment(out: SpineRow[], segment: Segment, input: SpineRowsInput, openTail: boolean, session: TraceSession): void {
  const rows: SpineRow[] = [];
  for (const row of segment.rows) {
    rows.push(row);
    if (row.t !== "noise" || !input.expanded.has(row.key)) continue;
    for (const i of row.steps) {
      const step = session.steps[i];
      if (step !== undefined) rows.push({ t: "step", key: step.id, step: i, expanded: input.expanded.has(step.id) });
    }
  }
  if (input.level !== "chapter" || openTail || rows.length <= ELIDE_ABOVE_ROWS) {
    out.push(...rows);
    return;
  }
  const middle = rows.slice(ELIDE_HEAD, rows.length - ELIDE_TAIL);
  const steps = middle.flatMap((r) => (r.t === "step" ? [r.step] : r.t === "noise" ? r.steps : []));
  const first = session.steps[steps[0] ?? -1];
  if (first === undefined) {
    out.push(...rows);
    return;
  }
  const key: `elided:${number}` = `elided:${first.firstSeq}`;
  if (input.expanded.has(key)) {
    out.push(...rows);
    return;
  }
  const byLane = Object.fromEntries(LANES.map((lane) => [lane, 0])) as Record<Lane, number>;
  let end = first.tMs;
  for (const i of steps) {
    const step = session.steps[i];
    if (step === undefined) continue;
    byLane[step.lane] += 1;
    end = Math.max(end, step.tMs + Math.max(0, step.durationMs ?? 0));
  }
  out.push(...rows.slice(0, ELIDE_HEAD), { t: "elided", key, steps, byLane, spanMs: end - first.tMs }, ...rows.slice(rows.length - ELIDE_TAIL));
}

/** ch:<anchor> for the first current chapter at an anchor (by id) and ch:<anchor>.<n> for the rest, as Canvas keys them (spec §7.5).
 *  `order` caches each anchor's id → n, so a session whose chapters share one anchor stays linear. */
function chapterRowKey(id: UnitStableId, index: TraceIndex, order: Map<number, Map<UnitStableId, number>>): `ch:${number}` | undefined {
  const key = index.chapterKey(id);
  if (key === undefined) return undefined;
  const anchor = Number(key.slice(3));
  let positions = order.get(anchor);
  if (positions === undefined) {
    positions = new Map(index.chaptersByAnchor(anchor).map((chapterId, n) => [chapterId, n]));
    order.set(anchor, positions);
  }
  const n = positions.get(id) ?? -1;
  return n > 0 ? (`${key}.${n}` as `ch:${number}`) : key;
}

function sessionRows(session: TraceSession, index: TraceIndex, input: SpineRowsInput, range: { fromSeq: number; toSeq: number }, i0: number, i1: number): SpineRow[] {
  const items: { seq: number; t: number; turn: number; id: string; row: SpineRow }[] = [];
  const current = session.chapters.filter((c) => c.current);
  const order = new Map<number, Map<UnitStableId, number>>();
  session.chapters.forEach((chapter, position) => {
    if (!chapter.current) return;
    const entry = index.entry(chapter.id);
    const key = chapterRowKey(chapter.id, index, order);
    if (entry === undefined || key === undefined || entry.firstSeq < range.fromSeq || entry.firstSeq > range.toSeq) return;
    items.push({
      seq: entry.firstSeq, t: chapter.tMs, turn: index.turnAtSeq(entry.firstSeq)?.index ?? 0, id: chapter.id,
      row: { t: "chapter", key, chapter: position },
    });
  });
  for (let i = i0; i <= i1; i += 1) {
    const step = session.steps[i];
    if (step === undefined) continue;
    if (!PINNED_KINDS.has(step.kind) && worstSeverity(step, index.findingsById) !== "critical") continue;
    items.push({
      seq: step.firstSeq, t: step.tMs, turn: step.turnIndex, id: step.id,
      row: { t: "step", key: step.id, step: i, expanded: isStepExpanded(step, index.findingsById, input.expanded, input.collapsed) },
    });
  }
  // Beats read in gutter-time order within a turn (a chapter shows its unit's start, which can
  // follow its first step: a decision-born chapter starts after the decision; visual audit 1-14).
  // Steps keep seq order (their times never decrease with seq); a chapter row leads a step at the
  // same time and seq; chapters that tie order by id, independent of chapter order.
  const rank = (row: SpineRow): number => (row.t === "chapter" ? 0 : 1);
  items.sort((a, b) => a.turn - b.turn || a.t - b.t || a.seq - b.seq || rank(a.row) - rank(b.row) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const showTurns = session.turns.length > 1 || current.length === 0;
  const out: SpineRow[] = [];
  let turn = -1;
  for (const item of items) {
    if (showTurns && item.turn !== turn) out.push({ t: "turn", key: `turn:${item.turn}`, turn: item.turn });
    turn = item.turn;
    out.push(item.row);
  }
  return out;
}

/** Binary-searches steps by firstSeq for the brushed range; keys survive refolds, churn and live ticks (spec §7.6.3). */
export function buildSpineRows(session: TraceSession, index: TraceIndex, scale: TimeScale, input: SpineRowsInput): SpineRow[] {
  const steps = session.steps;
  if (steps.length === 0) return [];
  const range = brushSeqRange(input.brush, index);
  const i0 = index.stepIndexAtOrAfter(range.fromSeq);
  const i1 = index.stepIndexAtOrBefore(range.toSeq);
  if (i0 > i1) return [];
  if (input.level === "session") return sessionRows(session, index, input, range, i0, i1);

  const playheadStep = index.stepIndexAtOrBefore(input.playheadSeq);
  const selected = input.selection === null ? undefined : index.entry(input.selection);
  const selectedStep = selected?.kind === "step" ? selected.position : -1;
  const gaps = session.gaps
    .map((gap, gi) => ({ gap, gi }))
    .filter(({ gap }) => gap.atSeq >= range.fromSeq && gap.atSeq <= range.toSeq)
    .sort((a, b) => a.gap.atSeq - b.gap.atSeq);
  let gapCursor = 0;
  const out: SpineRow[] = [];
  let segment: Segment | null = null;
  let prev: Step | null = null;
  // At most one noise row is open (the segment's last row); labels are written once per run.
  const runs: NoiseRun[] = [];
  let openRun: NoiseRun | null = null;

  for (let i = i0; i <= i1; i += 1) {
    const step = steps[i];
    if (step === undefined) continue;
    const separators: SpineRow[] = [];
    const turnStarts = prev === null
      ? step.turnIndex > 0 && (steps[i - 1]?.turnIndex ?? -1) !== step.turnIndex
      : step.turnIndex !== prev.turnIndex;
    if (turnStarts) separators.push({ t: "turn", key: `turn:${step.turnIndex}`, turn: step.turnIndex });
    if (prev !== null) {
      const prevEnd = prev.tMs + Math.max(0, prev.durationMs ?? 0);
      if (step.tMs > prevEnd) {
        const brk = scale.breaks(scale.toU(prevEnd), scale.toU(step.tMs), BREAK_MIN_MS)[0];
        if (brk?.idle) separators.push({ t: "idle", key: `idle:${step.firstSeq}`, ms: brk.idle.ms, reason: brk.idle.reason });
      }
    }
    for (let next = gaps[gapCursor]; next !== undefined && next.gap.atSeq < step.firstSeq; next = gaps[gapCursor]) {
      separators.push({ t: "gap", key: `gap:${next.gap.atSeq}`, gap: next.gi });
      gapCursor += 1;
    }
    if (separators.length > 0 && segment !== null) {
      emitSegment(out, segment, input, false, session);
      segment = null;
    }
    out.push(...separators);

    const parent = index.entry(step.id)?.parent ?? null;
    const pinned = PINNED_KINDS.has(step.kind) || step.findingIds.length > 0 || step.status === "failed"
      || i === playheadStep || i === selectedStep || (input.matches?.has(step.id) ?? false);
    const row: SpineRow = { t: "step", key: step.id, step: i, expanded: isStepExpanded(step, index.findingsById, input.expanded, input.collapsed) };
    if (pinned) {
      if (segment !== null) {
        emitSegment(out, segment, input, false, session);
        segment = null;
      }
      out.push(row);
      prev = step;
      continue;
    }
    const isNoise = step.noise !== null && input.level !== "step";
    const last = segment === null ? undefined : segment.rows[segment.rows.length - 1];
    if (isNoise && last !== undefined && last.t === "noise" && openRun?.row === last) {
      last.steps.push(i);
      addReason(openRun, step.noise);
      prev = step;
      continue;
    }
    if (segment !== null && (segment.parent !== parent || segment.turn !== step.turnIndex)) {
      emitSegment(out, segment, input, false, session);
      segment = null;
    }
    segment ??= { rows: [], parent, turn: step.turnIndex };
    if (isNoise) {
      const noise: NoiseRun = { row: { t: "noise", key: `noise:${step.firstSeq}`, steps: [i], label: "" }, reasons: [] };
      addReason(noise, step.noise);
      runs.push(noise);
      openRun = noise;
      segment.rows.push(noise.row);
    } else {
      segment.rows.push(row);
    }
    prev = step;
  }
  // Rows are shared with emitted segments (and elided bands drop theirs), so labelling here reaches every kept row.
  for (const run of runs) run.row.label = noiseLabel(run.row.steps.length, run.reasons);
  if (segment !== null) emitSegment(out, segment, input, input.live && i1 === steps.length - 1, session);
  for (let next = gaps[gapCursor]; next !== undefined; next = gaps[gapCursor]) {
    out.push({ t: "gap", key: `gap:${next.gap.atSeq}`, gap: next.gi });
    gapCursor += 1;
  }
  return out;
}

function firstFinding(step: Step, session: TraceSession): Finding | undefined {
  let best: Finding | undefined;
  for (const finding of session.findings) {
    if (!step.findingIds.includes(finding.id)) continue;
    if (best === undefined || SEVERITY_RANK[finding.severity] > SEVERITY_RANK[best.severity]
      || (finding.severity === best.severity && RULE_RANK[finding.ruleId] < RULE_RANK[best.ruleId])) best = finding;
  }
  return best;
}

/** 32 for step/chapter/noise/elided, 24 for separators, per signal for expanded finding rows (124 for claim_contradicted). */
export function estimateSpineRowSize(row: SpineRow, session: TraceSession): number {
  if (row.t === "turn" || row.t === "idle" || row.t === "gap") return SPINE_SEPARATOR_PX;
  if (row.t !== "step" || !row.expanded) return SPINE_ROW_PX;
  const step = session.steps[row.step];
  const finding = step === undefined ? undefined : firstFinding(step, session);
  return finding === undefined ? EXPANDED_ROW_PX : FINDING_ROW_PX[finding.ruleId];
}

/** Index of the row holding seq, or −1. */
export function spineRowIndexForSeq(rows: readonly SpineRow[], session: TraceSession, seq: number): number {
  let lo = 0;
  let hi = session.steps.length - 1;
  let si = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((session.steps[mid]?.firstSeq ?? Number.POSITIVE_INFINITY) <= seq) {
      si = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const target = session.steps[si];
  if (target === undefined) return -1;
  const exact = rows.findIndex((r) => r.t === "step" && r.step === si);
  if (exact >= 0) return exact;
  const group = rows.findIndex((r) => (r.t === "noise" || r.t === "elided") && r.steps.includes(si));
  if (group >= 0) return group;
  for (let j = rows.length - 1; j >= 0; j -= 1) {
    const row = rows[j];
    if (row?.t === "chapter" && session.chapters[row.chapter]?.stepIds.includes(target.id)) return j;
  }
  return -1;
}
