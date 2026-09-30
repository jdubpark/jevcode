import { decisionStableId, type Chapter, type FindingId, type Step, type StepId, type TraceSession } from "../model/index.js";
import type { CanvasColumn, CanvasFrame } from "./canvas-layout.js";
import { stepFinder, type LevelSpec } from "./canvas-levels.js";
import type { SelectionId } from "./trace-index.js";
import type { Point, Rect } from "./viewport.js";

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

export const RAIL_RADIUS_PX = 6;

const KIND_RANK: { readonly [K in EdgeKind]: number } = { trunk: 0, contradicts: 1, decides: 2, validates: 3 };

function n(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function laneY(spec: LevelSpec, lane: number): number {
  return spec.storyBand + Math.round((spec.channelH * (lane + 1)) / (spec.channelLanes + 1));
}

// ------------------------------------------------------------ context

interface RouteContext {
  input: RouteInput;
  stepOf: (id: string) => Step | undefined;
  chapterById: Map<string, Chapter>;
  frameBySel: Map<SelectionId, CanvasFrame>;
  order: Map<string, number>;
  byColumn: Map<number, CanvasFrame[]>;
}

function createContext(input: RouteInput): RouteContext {
  const frameBySel = new Map<SelectionId, CanvasFrame>();
  const order = new Map<string, number>();
  const byColumn = new Map<number, CanvasFrame[]>();
  input.frames.forEach((frame, index) => {
    order.set(frame.key, index);
    for (const selId of frame.memberSelIds) if (!frameBySel.has(selId)) frameBySel.set(selId, frame);
    const list = byColumn.get(frame.col);
    if (list === undefined) byColumn.set(frame.col, [frame]);
    else list.push(frame);
  });
  for (const list of byColumn.values()) list.sort((a, b) => a.row - b.row);
  return {
    input,
    stepOf: stepFinder(input.session.steps),
    chapterById: new Map(input.session.chapters.map((chapter) => [chapter.id, chapter])),
    frameBySel,
    order,
    byColumn,
  };
}

function anchorOf(ctx: RouteContext, chapter: Chapter): number {
  const stepSeqs = chapter.stepIds.map((id) => ctx.stepOf(id)?.firstSeq ?? Infinity);
  return Math.min(Infinity, ...chapter.factSeqs, ...stepSeqs);
}

function homeKey(ctx: RouteContext, stepId: string): string | undefined {
  const step = ctx.stepOf(stepId);
  if (step === undefined) return undefined;
  const loose = ctx.input.frameByKey.get(`step:${step.firstSeq}`);
  if (loose !== undefined && loose.kind === "loose") return loose.key;
  const story = ctx.frameBySel.get(step.id);
  if (story !== undefined && story.kind === "story") return story.key;
  const byAnchor = (a: Chapter, b: Chapter): number => anchorOf(ctx, a) - anchorOf(ctx, b) || compareText(a.id, b.id);
  const chapters = step.chapterIds
    .map((id) => ctx.chapterById.get(id))
    .filter((chapter): chapter is Chapter => chapter !== undefined && ctx.frameBySel.has(chapter.id))
    .sort(byAnchor);
  if (step.kind === "test" || step.kind === "check") {
    const tests = chapters.find((chapter) => chapter.category === "tests");
    if (tests !== undefined) return ctx.frameBySel.get(tests.id)?.key;
  }
  const lowest = chapters[0];
  return lowest === undefined ? undefined : ctx.frameBySel.get(lowest.id)?.key;
}

export function homeFrameKey(stepId: StepId, input: RouteInput): string | undefined {
  return homeKey(createContext(input), stepId);
}

// ------------------------------------------------------------ geometry

function center(frame: CanvasFrame): number {
  return frame.card.x + frame.card.w / 2;
}

function top(frame: CanvasFrame): Point {
  return { x: center(frame), y: frame.card.y };
}

function bottom(frame: CanvasFrame): Point {
  return { x: center(frame), y: frame.card.y + frame.card.h };
}

function left(frame: CanvasFrame): Point {
  return { x: frame.card.x, y: frame.card.y + frame.card.h / 2 };
}

function right(frame: CanvasFrame): Point {
  return { x: frame.card.x + frame.card.w, y: frame.card.y + frame.card.h / 2 };
}

function roundedPolyline(points: readonly Point[], radius: number): string {
  const pts = points.filter((point, index) => {
    const prev = points[index - 1];
    return prev === undefined || prev.x !== point.x || prev.y !== point.y;
  });
  const first = pts[0];
  if (first === undefined) return "";
  let d = `M${n(first.x)} ${n(first.y)}`;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const next = pts[i + 1];
    if (prev === undefined || cur === undefined || next === undefined) continue;
    const inLen = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const outLen = Math.hypot(next.x - cur.x, next.y - cur.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    const a = { x: cur.x - ((cur.x - prev.x) / inLen) * r, y: cur.y - ((cur.y - prev.y) / inLen) * r };
    const b = { x: cur.x + ((next.x - cur.x) / outLen) * r, y: cur.y + ((next.y - cur.y) / outLen) * r };
    d += `L${n(a.x)} ${n(a.y)}Q${n(cur.x)} ${n(cur.y)} ${n(b.x)} ${n(b.y)}`;
  }
  const last = pts[pts.length - 1];
  if (last !== undefined && pts.length > 1) d += `L${n(last.x)} ${n(last.y)}`;
  return d;
}

export function directPath(a: Rect, b: Rect): string {
  if (a.x + a.w <= b.x || b.x + b.w <= a.x) {
    const [l, r] = a.x <= b.x ? [a, b] : [b, a];
    const p0 = { x: l.x + l.w, y: l.y + l.h / 2 };
    const p3 = { x: r.x, y: r.y + r.h / 2 };
    const gx = (p0.x + p3.x) / 2;
    return `M${n(p0.x)} ${n(p0.y)}C${n(gx)} ${n(p0.y)} ${n(gx)} ${n(p3.y)} ${n(p3.x)} ${n(p3.y)}`;
  }
  const [u, v] = a.y <= b.y ? [a, b] : [b, a];
  const p0 = { x: u.x + u.w / 2, y: u.y + u.h };
  const p3 = { x: v.x + v.w / 2, y: v.y };
  const gy = (p0.y + p3.y) / 2;
  return `M${n(p0.x)} ${n(p0.y)}C${n(p0.x)} ${n(gy)} ${n(p3.x)} ${n(gy)} ${n(p3.x)} ${n(p3.y)}`;
}

function directBadge(a: Rect, b: Rect): Point {
  if (a.x + a.w <= b.x || b.x + b.w <= a.x) {
    const [l, r] = a.x <= b.x ? [a, b] : [b, a];
    return { x: (l.x + l.w + r.x) / 2, y: (l.y + l.h / 2 + r.y + r.h / 2) / 2 };
  }
  const [u, v] = a.y <= b.y ? [a, b] : [b, a];
  return { x: (u.x + u.w / 2 + v.x + v.w / 2) / 2, y: (u.y + u.h + v.y) / 2 };
}

export function samplePath(d: string, perSegment = 16): Point[] {
  const tokens = d.match(/[MLHVCQ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const points: Point[] = [];
  let i = 0;
  let cursor: Point = { x: 0, y: 0 };
  let command = "M";
  const num = (): number => Number(tokens[i++]);
  while (i < tokens.length) {
    const token = tokens[i];
    if (token !== undefined && /^[MLHVCQ]$/i.test(token)) {
      command = token.toUpperCase();
      i += 1;
    }
    if (command === "M") {
      cursor = { x: num(), y: num() };
      points.push(cursor);
      command = "L";
    } else if (command === "L" || command === "H" || command === "V") {
      const target =
        command === "L" ? { x: num(), y: num() } : command === "H" ? { x: num(), y: cursor.y } : { x: cursor.x, y: num() };
      for (let s = 1; s <= perSegment; s += 1) {
        const t = s / perSegment;
        points.push({ x: cursor.x + (target.x - cursor.x) * t, y: cursor.y + (target.y - cursor.y) * t });
      }
      cursor = target;
    } else if (command === "C") {
      const c1 = { x: num(), y: num() };
      const c2 = { x: num(), y: num() };
      const target = { x: num(), y: num() };
      for (let s = 1; s <= perSegment; s += 1) {
        const t = s / perSegment;
        const m = 1 - t;
        points.push({
          x: m * m * m * cursor.x + 3 * m * m * t * c1.x + 3 * m * t * t * c2.x + t * t * t * target.x,
          y: m * m * m * cursor.y + 3 * m * m * t * c1.y + 3 * m * t * t * c2.y + t * t * t * target.y,
        });
      }
      cursor = target;
    } else if (command === "Q") {
      const c = { x: num(), y: num() };
      const target = { x: num(), y: num() };
      for (let s = 1; s <= perSegment; s += 1) {
        const t = s / perSegment;
        const m = 1 - t;
        points.push({
          x: m * m * cursor.x + 2 * m * t * c.x + t * t * target.x,
          y: m * m * cursor.y + 2 * m * t * c.y + t * t * target.y,
        });
      }
      cursor = target;
    } else {
      i += 1;
    }
  }
  return points;
}

// ------------------------------------------------------------ lanes

class IntervalBook {
  private readonly used = new Map<string, Array<readonly [number, number]>>();

  free(slot: string, a: number, b: number): boolean {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return (this.used.get(slot) ?? []).every(([u0, u1]) => hi <= u0 || lo >= u1);
  }

  take(slot: string, a: number, b: number): void {
    const list = this.used.get(slot) ?? [];
    list.push([Math.min(a, b), Math.max(a, b)]);
    this.used.set(slot, list);
  }
}

/** x of rail lane j in the left gutter of column c (lane 0 nearest the column). */
function railX(ctx: RouteContext, column: number, lane: number): number {
  const { columns, spec } = ctx.input;
  const colX = columns[column]?.x ?? 0;
  const prev = columns[column - 1];
  const gutterLeft = prev === undefined ? colX - spec.colGap : prev.x + spec.w;
  return colX - Math.round(((colX - gutterLeft) * (lane + 1)) / (spec.railLanes + 1));
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let value = from; value < to; value += 1) out.push(value);
  return out;
}

/** "bottom" for the lowest story cell, "top" for the first work row, null for a frame with others between it and the channel. */
function directPort(ctx: RouteContext, frame: CanvasFrame): "bottom" | "top" | null {
  const { spec } = ctx.input;
  const column = ctx.byColumn.get(frame.col) ?? [];
  if (frame.row < spec.storyCap) {
    return column.some((other) => other.row > frame.row && other.row < spec.storyCap) ? null : "bottom";
  }
  return column.some((other) => other.row >= spec.storyCap && other.row < frame.row) ? null : "top";
}

interface Routed {
  shape: EdgeShape;
  lane: number | null;
  d: string | null;
  badge: Point;
}

function stackedRoute(a: CanvasFrame, b: CanvasFrame): Routed {
  const [upper, lower] = a.row < b.row ? [a, b] : [b, a];
  const p0 = bottom(upper);
  const p1 = top(lower);
  return { shape: "stacked", lane: null, d: `M${n(p0.x)} ${n(p0.y)}V${n(p1.y)}`, badge: { x: p0.x, y: (p0.y + p1.y) / 2 } };
}

function adjacentRoute(a: CanvasFrame, b: CanvasFrame): Routed {
  const [l, r] = a.col < b.col ? [a, b] : [b, a];
  const p0 = right(l);
  const p3 = left(r);
  const gx = (p0.x + p3.x) / 2;
  return {
    shape: "adjacent",
    lane: null,
    d: `M${n(p0.x)} ${n(p0.y)}C${n(gx)} ${n(p0.y)} ${n(gx)} ${n(p3.y)} ${n(p3.x)} ${n(p3.y)}`,
    badge: { x: gx, y: (p0.y + p3.y) / 2 },
  };
}

function railLanesFor(ctx: RouteContext, kind: EdgeKind): number[] {
  return kind === "contradicts" ? range(0, ctx.input.spec.railLanes) : range(1, ctx.input.spec.railLanes);
}

function railRoute(ctx: RouteContext, book: IntervalBook, kind: EdgeKind, a: CanvasFrame, b: CanvasFrame): Routed | null {
  const [upper, lower] = a.row < b.row ? [a, b] : [b, a];
  const ya = left(upper).y;
  const yb = left(lower).y;
  for (const lane of railLanesFor(ctx, kind)) {
    const slot = `rail:${a.col}:${lane}`;
    if (!book.free(slot, ya, yb)) continue;
    book.take(slot, ya, yb);
    const x = railX(ctx, a.col, lane);
    return {
      shape: "rail",
      lane,
      d: roundedPolyline([left(upper), { x, y: ya }, { x, y: yb }, left(lower)], RAIL_RADIUS_PX),
      badge: { x, y: (ya + yb) / 2 },
    };
  }
  return null;
}

function channelRoute(ctx: RouteContext, book: IntervalBook, kind: EdgeKind, a: CanvasFrame, b: CanvasFrame): Routed | null {
  const { spec } = ctx.input;
  const [l, r] = a.col < b.col ? [a, b] : [b, a];
  const lPort = directPort(ctx, l);
  const rPort = directPort(ctx, r);
  const lanes = kind === "contradicts" ? [1, 2] : range(2, spec.channelLanes);
  for (const lane of lanes.filter((value) => value < spec.channelLanes)) {
    const y = laneY(spec, lane);
    const lRail =
      lPort === null
        ? railLanesFor(ctx, kind).find((j) => book.free(`rail:${l.col + 1}:${j}`, right(l).y, y))
        : undefined;
    const rRail =
      rPort === null ? railLanesFor(ctx, kind).find((j) => book.free(`rail:${r.col}:${j}`, y, left(r).y)) : undefined;
    if ((lPort === null && lRail === undefined) || (rPort === null && rRail === undefined)) continue;
    const x0 = lPort === null ? railX(ctx, l.col + 1, lRail ?? 0) : center(l);
    const x1 = rPort === null ? railX(ctx, r.col, rRail ?? 0) : center(r);
    if (!book.free(`lane:${lane}`, x0, x1)) continue;
    book.take(`lane:${lane}`, x0, x1);
    if (lPort === null) book.take(`rail:${l.col + 1}:${lRail ?? 0}`, right(l).y, y);
    if (rPort === null) book.take(`rail:${r.col}:${rRail ?? 0}`, y, left(r).y);
    const points: Point[] = [];
    if (lPort === "bottom") points.push(bottom(l), { x: x0, y });
    else if (lPort === "top") points.push(top(l), { x: x0, y });
    else points.push(right(l), { x: x0, y: right(l).y }, { x: x0, y });
    if (rPort === "bottom") points.push({ x: x1, y }, bottom(r));
    else if (rPort === "top") points.push({ x: x1, y }, top(r));
    else points.push({ x: x1, y }, { x: x1, y: left(r).y }, left(r));
    return { shape: "channel", lane, d: roundedPolyline(points, RAIL_RADIUS_PX), badge: { x: (x0 + x1) / 2, y } };
  }
  return null;
}

function nothingBetween(ctx: RouteContext, a: CanvasFrame, b: CanvasFrame): boolean {
  const lo = Math.min(a.row, b.row);
  const hi = Math.max(a.row, b.row);
  return !(ctx.byColumn.get(a.col) ?? []).some((frame) => frame.row > lo && frame.row < hi);
}

// ------------------------------------------------------------ edges

interface EdgeSpec {
  kind: EdgeKind;
  from: string;
  to: string;
  findingId: FindingId | null;
}

function wantedEdges(ctx: RouteContext): EdgeSpec[] {
  const { session, frames } = ctx.input;
  const specs: EdgeSpec[] = [];
  for (const finding of session.findings) {
    if (finding.ruleId !== "claim_contradicted") continue;
    const from = homeKey(ctx, finding.claimStepId ?? finding.anchorStepId);
    if (from === undefined) continue;
    for (const evidence of finding.evidenceStepIds ?? []) {
      const to = homeKey(ctx, evidence);
      if (to !== undefined && to !== from) specs.push({ kind: "contradicts", from, to, findingId: finding.id });
    }
  }
  for (const frame of frames) {
    if (frame.item !== "decision") continue;
    const step = ctx.stepOf(frame.selId);
    const decisionId = step?.decision?.decisionId ?? step?.target;
    if (decisionId === undefined) continue;
    const stableId = decisionStableId(decisionId);
    for (const chapter of session.chapters) {
      if (!chapter.decisionIds.includes(stableId)) continue;
      const to = ctx.frameBySel.get(chapter.id);
      if (to !== undefined && to.key !== frame.key) specs.push({ kind: "decides", from: frame.key, to: to.key, findingId: null });
    }
  }
  for (const chapter of session.chapters) {
    const from = ctx.frameBySel.get(chapter.id);
    if (from === undefined) continue;
    for (const stepId of chapter.validationStepIds) {
      const to = homeKey(ctx, stepId);
      if (to !== undefined && to !== from.key) specs.push({ kind: "validates", from: from.key, to, findingId: null });
    }
  }
  const unique = new Map<string, EdgeSpec>();
  for (const spec of specs) {
    const id = `${spec.kind}|${spec.from}|${spec.to}`;
    const seen = unique.get(id);
    if (seen === undefined || compareText(spec.findingId ?? "", seen.findingId ?? "") < 0) unique.set(id, spec);
  }
  const order = (key: string): number => ctx.order.get(key) ?? Number.MAX_SAFE_INTEGER;
  return [...unique.values()].sort(
    (a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || order(a.from) - order(b.from) || order(a.to) - order(b.to),
  );
}

function trunkEdges(ctx: RouteContext): { edges: CanvasEdge[]; junctions: Point[] } {
  const { columns, spec } = ctx.input;
  const y = laneY(spec, 0);
  const byTurn = new Map<number, CanvasColumn[]>();
  for (const column of columns) {
    const list = byTurn.get(column.turn);
    if (list === undefined) byTurn.set(column.turn, [column]);
    else list.push(column);
  }
  const edges: CanvasEdge[] = [];
  const junctions: Point[] = [];
  for (const [turn, turnColumns] of [...byTurn].sort((a, b) => a[0] - b[0])) {
    const stubs: string[] = [];
    const xs: number[] = [];
    const keys: string[] = [];
    const turnJunctions: Point[] = [];
    for (const column of turnColumns) {
      const frames = ctx.byColumn.get(column.index) ?? [];
      const story = frames.filter((frame) => frame.row < spec.storyCap);
      const work = frames.filter((frame) => frame.row >= spec.storyCap);
      const x = column.x + spec.w / 2;
      for (let i = 0; i + 1 < story.length; i += 1) {
        const upper = story[i];
        const lower = story[i + 1];
        if (upper !== undefined && lower !== undefined) stubs.push(`M${n(x)} ${n(bottom(upper).y)}V${n(top(lower).y)}`);
      }
      const lastStory = story[story.length - 1];
      const firstWork = work[0];
      if (lastStory !== undefined) {
        stubs.push(`M${n(x)} ${n(bottom(lastStory).y)}V${n(y)}`);
        xs.push(x);
        keys.push(...story.map((frame) => frame.key));
      }
      if (firstWork !== undefined) {
        stubs.push(`M${n(x)} ${n(y)}V${n(top(firstWork).y)}`);
        xs.push(x);
        keys.push(firstWork.key);
      }
      if (lastStory !== undefined && firstWork !== undefined) turnJunctions.push({ x, y });
    }
    if (xs.length < 2) continue;
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const ordered = [...keys].sort((a, b) => (ctx.order.get(a) ?? 0) - (ctx.order.get(b) ?? 0));
    edges.push({
      id: `trunk:turn:${turn}`,
      kind: "trunk",
      from: ordered[0] ?? "",
      to: ordered[ordered.length - 1] ?? "",
      shape: "comb",
      lane: 0,
      d: `${x1 > x0 ? `M${n(x0)} ${n(y)}H${n(x1)}` : ""}${stubs.join("")}`,
      rest: true,
      tone: "neutral",
      badge: null,
      findingId: null,
    });
    junctions.push(...turnJunctions);
  }
  return { edges, junctions };
}

/** Spec §7.5 "Edges": routes through gutters and channel lanes only; the ≠ connector is always drawn. */
export function routeEdges(input: RouteInput): { edges: CanvasEdge[]; junctions: Point[]; hiddenEdges: number } {
  const ctx = createContext(input);
  const trunk = trunkEdges(ctx);
  const book = new IntervalBook();
  const edges: CanvasEdge[] = [...trunk.edges];
  let hiddenEdges = 0;
  for (const spec of wantedEdges(ctx)) {
    const a = input.frameByKey.get(spec.from);
    const b = input.frameByKey.get(spec.to);
    if (a === undefined || b === undefined) continue;
    let routed: Routed | null;
    if (a.col === b.col) {
      routed = nothingBetween(ctx, a, b) ? stackedRoute(a, b) : railRoute(ctx, book, spec.kind, a, b);
    } else if (Math.abs(a.col - b.col) === 1) {
      routed = adjacentRoute(a, b);
    } else {
      routed = channelRoute(ctx, book, spec.kind, a, b);
    }
    if (routed === null && spec.kind === "contradicts") {
      routed = { shape: "direct", lane: null, d: directPath(a.card, b.card), badge: directBadge(a.card, b.card) };
    }
    const shape: EdgeShape =
      routed?.shape ?? (a.col === b.col ? "rail" : Math.abs(a.col - b.col) === 1 ? "adjacent" : "channel");
    const d = routed?.d ?? null;
    if (d === null) hiddenEdges += 1;
    const rest =
      spec.kind === "contradicts"
        ? true
        : input.spec.level !== "session" && d !== null && (shape === "stacked" || shape === "adjacent" || shape === "rail");
    edges.push({
      id: `${spec.kind}:${spec.from}>${spec.to}`,
      kind: spec.kind,
      from: spec.from,
      to: spec.to,
      shape,
      lane: routed?.lane ?? null,
      d,
      rest,
      tone: spec.kind === "contradicts" ? "bad" : "neutral",
      badge: spec.kind === "contradicts" && routed !== null ? routed.badge : null,
      findingId: spec.findingId,
    });
  }
  return { edges, junctions: trunk.junctions, hiddenEdges };
}
