import {
  LANES,
  type Finding, type FindingId, type Lane, type Severity, type SignalId, type Step, type StepKind, type TraceSession,
  type TurnTrigger, type UnitStableId,
} from "../model/index.js";
import type { TimeScale } from "./time-scale.js";
import { stepTone, worstSeverity, type Tone } from "./tone.js";
import type { TraceIndex } from "./trace-index.js";

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
  guardrail: { glyph: "dot", pin: "always" },
  attention: { glyph: "dot", pin: "finding" },
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

const SEVERITY_RANK: { readonly [S in Severity]: number } = { info: 0, warning: 1, critical: 2 };
const RULE_RANK: { readonly [K in SignalId]: number } = {
  claim_contradicted: 0, destructive_command: 1, failing_tests: 2, guardrail_clamp: 3, recovery_arc: 4,
};

function mostSevere(step: Step, findingsById: ReadonlyMap<FindingId, Finding>): FindingId | null {
  let best: Finding | null = null;
  for (const id of step.findingIds) {
    const f = findingsById.get(id);
    if (f === undefined) continue;
    if (best === null || SEVERITY_RANK[f.severity] > SEVERITY_RANK[best.severity]
      || (f.severity === best.severity && RULE_RANK[f.ruleId] < RULE_RANK[best.ruleId])) best = f;
  }
  return best?.id ?? null;
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

/** Rebuilt once per fold: struct-of-arrays marks per lane, pin candidates, band spans, turns and ≠ links. */
export function buildOverviewIndex(session: TraceSession, index: TraceIndex, scale: TimeScale): OverviewIndex {
  const rows = new Map<Lane, Row[]>(LANES.map((lane) => [lane, []]));
  const pins: PinCandidate[] = [];
  session.steps.forEach((step, i) => {
    const place = PLACEMENT[step.kind];
    const u0 = scale.toU(step.tMs);
    const u1 = Math.max(u0, scale.toU(step.tMs + Math.max(0, step.durationMs ?? 0)));
    const tone = stepTone(step, index.findingsById);
    rows.get(step.lane)?.push({
      u0, u1, step: i, glyph: GLYPH_CODE[place.glyph], tone: TONE_CODE[tone],
      added: step.edit?.added ?? 0, removed: step.edit?.removed ?? 0, problem: tone === "bad" ? 1 : 0, noise: step.noise === null ? 0 : 1,
    });
    if (place.echo !== undefined) {
      rows.get(place.echo)?.push({ u0, u1, step: i, glyph: GLYPH_CODE.bar, tone: TONE_CODE.neutral, added: 0, removed: 0, problem: 0, noise: 0 });
    }
    const hasFinding = step.findingIds.length > 0;
    const pinned = place.pin === "always" || (place.pin === "finding" && (hasFinding || step.status === "failed"));
    if (!pinned) return;
    const critical = worstSeverity(step, index.findingsById) === "critical";
    pins.push({
      stepIndex: i, lane: step.lane, u: place.glyph === "wait" ? u1 : u0,
      kind: pinKind(step, critical, hasFinding), critical, findingId: mostSevere(step, index.findingsById),
    });
  });
  const lanes = Object.fromEntries(LANES.map((lane) => [lane, toMarks(rows.get(lane) ?? [])])) as { [L in Lane]: LaneMarks };

  const bands: BandSpan[] = [];
  const current = session.chapters.filter((c) => c.current);
  if (current.length > 0) {
    for (const chapter of current) {
      const key = index.chapterKey(chapter.id);
      if (key === undefined) continue;
      const spans = chapter.stepIds
        .map((id) => index.entry(id))
        .filter((e): e is NonNullable<typeof e> => e !== undefined)
        .map((e): [number, number] => [scale.toU(e.t0), scale.toU(e.t1)])
        .sort((a, b) => a[0] - b[0]);
      if (spans.length === 0) spans.push([scale.toU(chapter.tMs), scale.toU(chapter.endTMs)]);
      let piece: [number, number] | null = null;
      for (const span of spans) {
        if (piece !== null && span[0] <= piece[1]) piece[1] = Math.max(piece[1], span[1]);
        else {
          if (piece !== null) bands.push({ key, id: chapter.id, u0: piece[0], u1: piece[1], title: chapter.title });
          piece = [span[0], span[1]];
        }
      }
      if (piece !== null) bands.push({ key, id: chapter.id, u0: piece[0], u1: piece[1], title: chapter.title });
    }
  } else {
    for (const turn of session.turns) {
      bands.push({ key: `turn:${turn.index}`, id: null, u0: scale.toU(turn.tMs), u1: scale.toU(turn.endTMs), title: `Turn ${turn.index + 1}` });
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

  return {
    endU: scale.endU,
    lanes,
    pins,
    bands,
    turns: session.turns.map((turn) => ({ index: turn.index, u: scale.toU(turn.tMs), trigger: turn.trigger })),
    links,
  };
}
