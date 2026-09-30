import { LANES, type FindingId, type Lane, type Level, type UnitStableId } from "../model/index.js";
import { bandGroupsOf, GLYPH_CODE, PIN_PRIORITY, type LaneMarks, type OverviewIndex, type PinCandidate, type PinKind } from "./overview-index.js";
import type { TimeScale } from "./time-scale.js";
import type { Tone } from "./tone.js";
import type { Brush, TraceIndex } from "./trace-index.js";
import { fitRange, type XOnlyCamera } from "./viewport.js";

export const OVERVIEW_H = 288;
export const LABELS_H = 36;
export const RULER_TOP = 36;
export const LANES_TOP = 58;
export const LANE_H = 28;
export const STRIP_H = 6;
export const GUTTER_W = 112;
export const GUTTER_W_NARROW = 40;
export const NARROW_CONTAINER_PX = 1180;
export const BIN_PX = 6;
export const PIN_PX = 22;
export const PIN_MIN_GAP_PX = 26;
export const DOT_MIN_GAP_PX = 8;
export const BAR_MIN_W_PX = 3;
export const HIST_CAP_PX = 12;
export const BAND_MERGE_GAP_PX = 24;
export const K_MAX = 0.4;
export const MAX_OVERLAY_NODES = 150;

const LABEL_ICON_PX = 22;
const LABEL_CHAR_PX = 7;
const LABEL_GAP_PX = 8;
const ICON_ONLY_PX = 20;
const BAR_MERGE_PX = 2;
const CHAPTER_MIN_SPAN_MS = 20_000;

export type MarkOp =
  | { op: "dot"; lane: Lane; x: number; tone: Tone }
  | { op: "ring"; lane: Lane; x: number }
  | { op: "bar"; lane: Lane; x0: number; x1: number; tone: Tone; endTone?: Tone }
  | { op: "heat"; lane: Lane; x: number; count: number; h: 2 | 4 | 6 | 8 }
  | { op: "hist"; lane: Lane; x: number; upPx: number; downPx: number }
  | { op: "wait"; lane: Lane; x0: number; x1: number }
  | { op: "noise"; lane: Lane; x0: number; x1: number }
  | { op: "problem"; lane: Lane; x: number };
export interface PinPlacement { key: string; lane: Lane; x: number; kind: PinKind; critical: boolean; stepIndexes: readonly number[]; cluster: boolean; findingId: FindingId | null }
export interface BandPlacement {
  key: string; id: UnitStableId | null; x0: number; x1: number;
  /** Where a placed label starts: x0, or 0 when the band begins left of the viewport. */
  labelX: number;
  title: string; tier: 0 | 1 | null; iconOnly: boolean;
}
export interface OverviewLayout {
  marks: readonly MarkOp[];
  pins: readonly PinPlacement[];
  bands: readonly BandPlacement[];
  /** Hairline plus ruler chip "T2 · steer". */
  turnLines: readonly { x: number; label: string }[];
  /** claim_contradicted: quote pin ↔ evidence pin with ≠ at the midpoint. */
  links: readonly { findingId: FindingId; fromPin: string; toPin: string }[];
  /** 1 px density bins across the full session for the 6 px strip. */
  strip: Float64Array;
}
export interface OverviewLayoutInput { overview: OverviewIndex; camera: XOnlyCamera; widthPx: number; level: Level }
export interface OverviewPresetInput {
  level: Level; overview: OverviewIndex; index: TraceIndex; scale: TimeScale;
  widthPx: number; playheadSeq: number; live: boolean;
}

const TONES: readonly Tone[] = ["neutral", "bad", "good"];
const TONE_RANK: { readonly [T in Tone]: number } = { good: 0, neutral: 1, bad: 2 };
const worse = (a: Tone, b: Tone): Tone => (TONE_RANK[b] > TONE_RANK[a] ? b : a);
const SESSION_PINS: ReadonlySet<PinKind> = new Set<PinKind>(["critical_finding", "instruction", "decision"]);

function heatHeight(count: number): 2 | 4 | 6 | 8 {
  if (count >= 10) return 8;
  if (count >= 4) return 6;
  if (count >= 2) return 4;
  return 2;
}

/** First index in [0, count) with arr[i] ≥ value. */
function lowerBound(arr: Float64Array, count: number, value: number): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((arr[mid] ?? 0) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface BarRun { u0: number; u1: number; tone: Tone; endTone: Tone | undefined }
interface Dot { u: number; tone: Tone; ring: boolean }

function layoutLane(lane: Lane, m: LaneMarks, camera: XOnlyCamera, uStart: number, uEnd: number, level: Level, marks: MarkOp[]): void {
  const k = camera.k;
  const xOf = (u: number): number => (u - camera.u0) * k;
  const binX = (bin: number): number => bin * BIN_PX + BIN_PX / 2 - camera.u0 * k;
  const barOp = (run: BarRun): MarkOp => (run.endTone === undefined || run.endTone === run.tone
    ? { op: "bar", lane, x0: xOf(run.u0), x1: xOf(run.u1), tone: run.tone }
    : { op: "bar", lane, x0: xOf(run.u0), x1: xOf(run.u1), tone: run.tone, endTone: run.endTone });
  const noiseOp = (u0: number, u1: number): MarkOp => ({ op: "noise", lane, x0: xOf(u0), x1: Math.max(xOf(u1), xOf(u0) + 1) });
  const heat = new Map<number, number>();
  const hist = new Map<number, { added: number; removed: number }>();
  const dots: Dot[] = [];
  let bar: BarRun | null = null;
  let noise: { u0: number; u1: number } | null = null;

  for (let i = lowerBound(m.u0, m.count, uStart - m.maxSpan); i < m.count; i += 1) {
    const u0 = m.u0[i] ?? 0;
    if (u0 > uEnd) break;
    const u1 = m.u1[i] ?? u0;
    if (u1 < uStart) continue;
    const tone = TONES[m.tone[i] ?? 0] ?? "neutral";
    const glyph = m.glyph[i] ?? GLYPH_CODE.dot;
    if ((m.problem[i] ?? 0) === 1) marks.push({ op: "problem", lane, x: xOf(u0) });
    if ((m.noise[i] ?? 0) === 1 && level !== "step") {
      if (level === "session") continue;
      if (noise !== null) noise.u1 = Math.max(noise.u1, u1);
      else noise = { u0, u1 };
      continue;
    }
    if (noise !== null) {
      marks.push(noiseOp(noise.u0, noise.u1));
      noise = null;
    }
    if (glyph === GLYPH_CODE.wait) {
      marks.push({ op: "wait", lane, x0: xOf(u0), x1: Math.max(xOf(u1), xOf(u0) + 1) });
      continue;
    }
    if (glyph === GLYPH_CODE.hist) {
      const bin = Math.floor((u0 * k) / BIN_PX);
      const h = hist.get(bin) ?? { added: 0, removed: 0 };
      h.added += m.added[i] ?? 0;
      h.removed += m.removed[i] ?? 0;
      hist.set(bin, h);
      continue;
    }
    if (glyph === GLYPH_CODE.bar && level !== "session" && (u1 - u0) * k >= BAR_MIN_W_PX) {
      if (bar !== null && (u0 - bar.u1) * k < BAR_MERGE_PX) {
        bar.u1 = Math.max(bar.u1, u1);
        bar.endTone = worse(bar.endTone ?? bar.tone, tone);
      } else {
        if (bar !== null) marks.push(barOp(bar));
        bar = { u0, u1, tone, endTone: undefined };
      }
      continue;
    }
    dots.push({ u: u0, tone, ring: glyph === GLYPH_CODE.ring });
  }
  if (bar !== null) marks.push(barOp(bar));
  if (noise !== null) marks.push(noiseOp(noise.u0, noise.u1));

  dots.forEach((dot, j) => {
    const prev = dots[j - 1];
    const next = dots[j + 1];
    const isolated = level !== "session"
      && (prev === undefined || (dot.u - prev.u) * k >= DOT_MIN_GAP_PX)
      && (next === undefined || (next.u - dot.u) * k >= DOT_MIN_GAP_PX);
    if (isolated) {
      marks.push(dot.ring ? { op: "ring", lane, x: xOf(dot.u) } : { op: "dot", lane, x: xOf(dot.u), tone: dot.tone });
      return;
    }
    const bin = Math.floor((dot.u * k) / BIN_PX);
    heat.set(bin, (heat.get(bin) ?? 0) + 1);
  });
  for (const [bin, count] of [...heat].sort((a, b) => a[0] - b[0])) {
    marks.push({ op: "heat", lane, x: binX(bin), count, h: heatHeight(count) });
  }
  for (const [bin, h] of [...hist].sort((a, b) => a[0] - b[0])) {
    marks.push({
      op: "hist", lane, x: binX(bin),
      upPx: Math.min(HIST_CAP_PX, Math.log2(1 + h.added)), downPx: Math.min(HIST_CAP_PX, Math.log2(1 + h.removed)),
    });
  }
}

function placePins(overview: OverviewIndex, camera: XOnlyCamera, widthPx: number, level: Level, gapPx: number): PinPlacement[] {
  const k = camera.k;
  const xOf = (u: number): number => (u - camera.u0) * k;
  const byLane = new Map<Lane, PinCandidate[]>();
  for (const pin of overview.pins) {
    if (level === "session" && !SESSION_PINS.has(pin.kind)) continue;
    const x = xOf(pin.u);
    if (x < -PIN_PX || x > widthPx + PIN_PX) continue;
    const list = byLane.get(pin.lane) ?? [];
    list.push(pin);
    byLane.set(pin.lane, list);
  }
  const out: PinPlacement[] = [];
  const place = (lane: Lane, members: readonly PinCandidate[], u: number): void => {
    let top = members[0];
    if (top === undefined) return;
    for (const m of members) if (PIN_PRIORITY[m.kind] > PIN_PRIORITY[top.kind]) top = m;
    const first = members[0]?.stepIndex ?? top.stepIndex;
    out.push({
      key: members.length === 1 ? `pin:${top.stepIndex}` : `cl:${lane}:${first}`,
      lane, x: xOf(u), kind: top.kind, critical: members.some((m) => m.critical),
      stepIndexes: members.map((m) => m.stepIndex), cluster: members.length > 1, findingId: top.findingId,
    });
  };
  for (const lane of LANES) {
    const list = [...(byLane.get(lane) ?? [])].sort((a, b) => a.u - b.u || a.stepIndex - b.stepIndex);
    let members: PinCandidate[] = [];
    let clusterU = 0;
    for (const pin of list) {
      if (members.length > 0 && (pin.u - clusterU) * k < gapPx) {
        members.push(pin);
      } else {
        place(lane, members, clusterU);
        members = [pin];
        clusterU = pin.u;
      }
    }
    place(lane, members, clusterU);
  }
  return out;
}

interface VisibleBand { key: string; id: UnitStableId | null; u0: number; u1: number; title: string }

/** First index in [0, n) whose value satisfies pred, for a pred that is monotone over the array. */
function firstIndex(n: number, pred: (i: number) => boolean): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pred(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Bands merged where the pixel gap is under BAND_MERGE_GAP_PX, clipped to the viewport: per key,
 *  a binary search finds the first piece reaching x = 0, the merge walks back to its chain start and
 *  forward to the first chain past the right edge. Cost follows the visible pieces, not the index. */
function visibleBands(overview: OverviewIndex, camera: XOnlyCamera, widthPx: number): VisibleBand[] {
  const k = camera.k;
  const xOf = (u: number): number => (u - camera.u0) * k;
  const out: VisibleBand[] = [];
  for (const group of bandGroupsOf(overview)) {
    const n = group.u0.length;
    const first = firstIndex(n, (i) => xOf(group.u1[i] ?? 0) >= 0);
    if (first >= n) continue;
    let j = first;
    while (j > 0 && ((group.u0[j] ?? 0) - (group.u1[j - 1] ?? 0)) * k < BAND_MERGE_GAP_PX) j -= 1;
    let current: VisibleBand | null = null;
    for (; j < n; j += 1) {
      const u0 = group.u0[j] ?? 0;
      const u1 = group.u1[j] ?? u0;
      if (current !== null && (u0 - current.u1) * k < BAND_MERGE_GAP_PX) {
        current.u1 = Math.max(current.u1, u1);
        continue;
      }
      if (current !== null && xOf(current.u1) >= 0) out.push(current);
      if (xOf(u0) > widthPx) {
        current = null;
        break;
      }
      current = { key: group.key, id: group.id[j] ?? null, u0, u1, title: group.title[j] ?? "" };
    }
    if (current !== null && xOf(current.u1) >= 0) out.push(current);
  }
  return out.sort((a, b) => a.u0 - b.u0 || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Spec §7.6.1 labels: icon + name, greedy left to right in two tiers over the visible bands. A
 *  chapter's label goes on its first visible piece at least 20 px wide, else on its widest visible
 *  piece, and starts at that piece's visible left edge. The label may run past its band into free space: it collides
 *  only with the previous label in its tier, and a start with no free tier is left out. A name that
 *  would cross the viewport's right edge shows as the icon only. */
function placeBands(overview: OverviewIndex, camera: XOnlyCamera, widthPx: number): BandPlacement[] {
  const k = camera.k;
  const xOf = (u: number): number => (u - camera.u0) * k;
  const visible = visibleBands(overview, camera, widthPx);
  const uLeft = camera.u0;
  const uRight = camera.u0 + widthPx / k;
  const spanPx = (band: VisibleBand): number => (Math.min(band.u1, uRight) - Math.max(band.u0, uLeft)) * k;
  const target = new Map<string, VisibleBand>();
  for (const band of visible) {
    const chosen = target.get(band.key);
    if (chosen === undefined || (spanPx(chosen) < ICON_ONLY_PX && spanPx(band) > spanPx(chosen))) target.set(band.key, band);
  }
  const seen = new Map<string, number>();
  const tierEndU: [number, number] = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  return visible.map((band) => {
    const n = seen.get(band.key) ?? 0;
    seen.set(band.key, n + 1);
    const labelU = Math.max(band.u0, uLeft);
    let tier: 0 | 1 | null = null;
    let iconOnly = false;
    if (target.get(band.key) === band) {
      const labelPx = LABEL_ICON_PX + band.title.length * LABEL_CHAR_PX;
      for (const t of [0, 1] as const) {
        if (labelU >= tierEndU[t] + LABEL_GAP_PX / k) {
          tier = t;
          tierEndU[t] = labelU + labelPx / k;
          break;
        }
      }
      iconOnly = tier !== null && (uRight - labelU) * k < labelPx;
    }
    return {
      key: n === 0 ? band.key : `${band.key}#${n}`, id: band.id, x0: xOf(band.u0), x1: xOf(band.u1), labelX: xOf(labelU),
      title: band.title, tier, iconOnly,
    };
  });
}

function placeLinks(overview: OverviewIndex, pins: readonly PinPlacement[]): { findingId: FindingId; fromPin: string; toPin: string }[] {
  const keyOfStep = new Map<number, string>();
  for (const pin of pins) for (const i of pin.stepIndexes) keyOfStep.set(i, pin.key);
  const out: { findingId: FindingId; fromPin: string; toPin: string }[] = [];
  for (const link of overview.links) {
    const fromPin = keyOfStep.get(link.fromStep);
    const toPin = keyOfStep.get(link.toStep);
    if (fromPin !== undefined && toPin !== undefined && fromPin !== toPin) out.push({ findingId: link.findingId, fromPin, toPin });
  }
  return out;
}

export function layoutOverview(input: OverviewLayoutInput): OverviewLayout {
  const { overview, camera, widthPx, level } = input;
  const k = camera.k;
  const margin = PIN_PX / k;
  const uStart = camera.u0 - margin;
  const uEnd = camera.u0 + widthPx / k + margin;
  const marks: MarkOp[] = [];
  for (const lane of LANES) layoutLane(lane, overview.lanes[lane], camera, uStart, uEnd, level, marks);

  const bands = placeBands(overview, camera, widthPx);
  const labeled = bands.filter((b) => b.tier !== null).length;
  const turnLines = overview.turns
    .filter((t) => t.index > 0)
    .map((t) => ({ x: (t.u - camera.u0) * k, label: `T${t.index + 1} · ${t.trigger}` }))
    .filter((t) => t.x >= 0 && t.x <= widthPx);
  let gap = PIN_MIN_GAP_PX;
  let pins = placePins(overview, camera, widthPx, level, gap);
  let links = placeLinks(overview, pins);
  for (let tries = 0; tries < 12 && pins.length + labeled + turnLines.length + links.length > MAX_OVERLAY_NODES; tries += 1) {
    gap *= 2;
    pins = placePins(overview, camera, widthPx, level, gap);
    links = placeLinks(overview, pins);
  }

  const width = Math.max(1, Math.floor(widthPx));
  const strip = new Float64Array(width);
  const endU = Math.max(overview.endU, 1e-9);
  for (const lane of LANES) {
    const m = overview.lanes[lane];
    for (let i = 0; i < m.count; i += 1) {
      const bin = Math.min(width - 1, Math.max(0, Math.floor(((m.u0[i] ?? 0) / endU) * width)));
      strip[bin] = (strip[bin] ?? 0) + 1;
    }
  }
  return { marks, pins, bands, turnLines, links, strip };
}

/** Spec §7.6.1 semantic-zoom table: preset camera and preset brush per level. */
export function overviewPreset(input: OverviewPresetInput): { camera: XOnlyCamera; brush: Brush } {
  const { level, overview, index, scale, widthPx, playheadSeq, live } = input;
  const limits = { minK: 1e-9, maxK: K_MAX };
  if (level === "session") {
    const end = Math.max(1, overview.endU * (live ? 1.2 : 1));
    return { camera: fitRange(0, end, widthPx, { padFraction: 0.02, limits }), brush: { kind: "session" } };
  }
  if (level === "chapter") {
    let u0 = 0;
    let u1 = overview.endU;
    let brush: Brush = { kind: "session" };
    const chapter = index.chapterAtSeq(playheadSeq);
    const entry = chapter === undefined ? undefined : index.entry(chapter.id);
    const key = chapter === undefined ? undefined : index.chapterKey(chapter.id);
    if (entry !== undefined && key !== undefined) {
      u0 = scale.toU(entry.t0);
      u1 = scale.toU(entry.t1);
      brush = { kind: "chapter", anchorSeq: Number(key.slice(3)) };
    } else {
      const turn = index.turnAtSeq(playheadSeq);
      if (turn !== undefined) {
        u0 = scale.toU(turn.tMs);
        u1 = scale.toU(turn.endTMs);
        brush = { kind: "range", fromSeq: turn.startSeq, toSeq: Math.max(turn.startSeq, turn.endSeq) };
      }
    }
    if (u1 - u0 < CHAPTER_MIN_SPAN_MS) {
      const center = (u0 + u1) / 2;
      u0 = center - CHAPTER_MIN_SPAN_MS / 2;
      u1 = center + CHAPTER_MIN_SPAN_MS / 2;
    }
    return { camera: fitRange(u0, u1, widthPx, { padFraction: 0.08, limits }), brush };
  }
  const steps = index.session?.steps ?? [];
  const i = Math.max(0, index.stepIndexAtOrBefore(playheadSeq));
  const us: number[] = [];
  for (let j = Math.max(0, i - 20); j <= Math.min(steps.length - 1, i + 20); j += 1) us.push(scale.toU(steps[j]?.tMs ?? 0));
  const spacings = us.slice(1).map((u, j) => u - (us[j] ?? u)).filter((d) => d > 0).sort((a, b) => a - b);
  const median = spacings.length === 0 ? 0 : spacings[Math.floor(spacings.length / 2)] ?? 0;
  const k = median > 0 ? Math.min(K_MAX, 28 / median) : K_MAX;
  const center = scale.toU(steps[i]?.tMs ?? 0);
  const camera: XOnlyCamera = { mode: "xOnly", k, u0: center - widthPx / (2 * k) };
  const uLast = camera.u0 + widthPx / k;
  let first = -1;
  let last = -1;
  steps.forEach((step, j) => {
    const u = scale.toU(step.tMs);
    if (u >= camera.u0 && u <= uLast) {
      if (first < 0) first = j;
      last = j;
    }
  });
  const from = steps[first]?.firstSeq ?? playheadSeq;
  const to = steps[last]?.lastSeq ?? playheadSeq;
  return { camera, brush: { kind: "range", fromSeq: Math.max(1, Math.min(from, to)), toSeq: Math.max(from, to) } };
}
