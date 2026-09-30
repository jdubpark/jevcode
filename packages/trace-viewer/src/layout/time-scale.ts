import type { StepKind, TraceSession } from "../model/index.js";
import type { XOnlyCamera } from "./viewport.js";

export const IDLE_KNEE_MS = 10_000;
export const IDLE_LOG_MS = 5_000;
export const BREAK_MIN_MS = 60_000;
export const SESSION_BREAK_MIN_MS = 300_000;

/** g ≤ 10 s: g; else 10 s + 5 s · log2(g / 10 s). 20 s → 15 s, 60 s → 22.9 s, 5 min → 34.5 s, 1 h → 52.5 s. */
export function displayGapMs(gapMs: number): number {
  if (!(gapMs > 0)) return 0;
  return gapMs <= IDLE_KNEE_MS ? gapMs : IDLE_KNEE_MS + IDLE_LOG_MS * Math.log2(gapMs / IDLE_KNEE_MS);
}

function realGapMs(displayMs: number): number {
  if (!(displayMs > 0)) return 0;
  return displayMs <= IDLE_KNEE_MS ? displayMs : IDLE_KNEE_MS * 2 ** ((displayMs - IDLE_KNEE_MS) / IDLE_LOG_MS);
}

export type IdleReason = "awaiting_supervisor" | "agent_quiet";
export interface ScaleSegment {
  t0: number; t1: number; u0: number; u1: number;
  idle: null | { reason: IdleReason; ms: number };
}
export interface TimeScale {
  originMs: number;
  endT: number;
  endU: number;
  segments: readonly ScaleSegment[];
  toU(tMs: number): number;
  toT(u: number): number;
  /** Idle segments intersecting [u0, u1] whose real gap is ≥ minMs (default BREAK_MIN_MS). */
  breaks(u0: number, u1: number, minMs?: number): readonly ScaleSegment[];
}
export interface TimeScaleInput {
  originMs: number;
  /** Step spans [tMs, tMs + durationMs]; lifecycle steps and decision/approval waits excluded. */
  work: ReadonlyArray<readonly [number, number]>;
  /** Turn ends, decisions and approvals opened: gaps starting here read "awaiting_supervisor". */
  awaitingFrom: readonly number[];
  /** max(last step tMs, source.now() − originMs) while live. */
  liveTMs?: number;
}

/** Last index i with key(items[i]) ≤ value, or −1. */
function lastAtOrBefore<T>(items: readonly T[], value: number, key: (item: T) => number): number {
  let lo = 0;
  let hi = items.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const item = items[mid];
    if (item !== undefined && key(item) <= value) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export function buildTimeScale(input: TimeScaleInput): TimeScale {
  const spans = input.work
    .map(([a, b]) => [Math.max(0, a), Math.max(0, a, b)] as [number, number])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged: [number, number][] = [];
  for (const [a, b] of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const workEnd = merged[merged.length - 1]?.[1] ?? 0;
  const endT = Math.max(workEnd, input.liveTMs ?? 0, 0);
  const awaiting = input.awaitingFrom;
  const segments: ScaleSegment[] = [];
  let t = 0;
  let u = 0;
  const pushGap = (t1: number): void => {
    const ms = t1 - t;
    if (ms <= 0) return;
    const du = displayGapMs(ms);
    const start = t;
    const awaited = awaiting.some((v) => v >= start && v < t1);
    segments.push({ t0: t, t1, u0: u, u1: u + du, idle: { reason: awaited ? "awaiting_supervisor" : "agent_quiet", ms } });
    t = t1;
    u += du;
  };
  for (const [a, b] of merged) {
    pushGap(a);
    if (b > t) {
      segments.push({ t0: t, t1: b, u0: u, u1: u + (b - t), idle: null });
      u += b - t;
      t = b;
    }
  }
  pushGap(endT);
  const endU = u;

  const toU = (tMs: number): number => {
    if (tMs <= 0) return tMs;
    if (tMs >= endT) return endU + (tMs - endT);
    const seg = segments[lastAtOrBefore(segments, tMs, (s) => s.t0)];
    if (seg === undefined) return tMs;
    return seg.idle === null ? seg.u0 + (tMs - seg.t0) : seg.u0 + displayGapMs(tMs - seg.t0);
  };
  const toT = (value: number): number => {
    if (value <= 0) return value;
    if (value >= endU) return endT + (value - endU);
    const seg = segments[lastAtOrBefore(segments, value, (s) => s.u0)];
    if (seg === undefined) return value;
    return seg.idle === null ? seg.t0 + (value - seg.u0) : seg.t0 + realGapMs(value - seg.u0);
  };
  // Segments tile [0, endU] in u order, so the first one that can reach u0 is the last with s.u0 ≤ u0.
  // buildSpineRows calls this once per inter-step gap, so it must not scan every segment.
  const breaks = (u0: number, u1: number, minMs = BREAK_MIN_MS): readonly ScaleSegment[] => {
    const out: ScaleSegment[] = [];
    for (let i = Math.max(0, lastAtOrBefore(segments, u0, (s) => s.u0)); i < segments.length; i += 1) {
      const s = segments[i];
      if (s === undefined || s.u0 >= u1) break;
      if (s.idle !== null && s.idle.ms >= minMs && s.u1 > u0) out.push(s);
    }
    return out;
  };
  return {
    originMs: input.originMs,
    endT,
    endU,
    segments,
    toU,
    toT,
    breaks,
  };
}

const NOT_WORK: ReadonlySet<StepKind> = new Set<StepKind>(["lifecycle", "decision", "approval"]);

export function timeScaleInputOf(session: TraceSession, liveTMs?: number): TimeScaleInput {
  const work = session.steps.map((s): readonly [number, number] =>
    NOT_WORK.has(s.kind) ? [s.tMs, s.tMs] : [s.tMs, s.tMs + Math.max(0, s.durationMs ?? 0)]);
  const awaitingFrom = [
    ...session.turns.map((turn) => turn.endTMs),
    ...session.steps.filter((s) => s.kind === "decision" || s.kind === "approval").map((s) => s.tMs),
  ];
  return liveTMs === undefined
    ? { originMs: session.originMs, work, awaitingFrom }
    : { originMs: session.originMs, work, awaitingFrom, liveTMs };
}

/** Monotone map between display time and screen x. */
export interface XMap { xOf(tMs: number): number; tOf(x: number): number }

/** Hybrid: x = (toU(t) − u0) · k. */
export function xOnlyXMap(scale: TimeScale, camera: XOnlyCamera): XMap {
  return {
    xOf: (tMs) => (scale.toU(tMs) - camera.u0) * camera.k,
    tOf: (x) => scale.toT(x / camera.k + camera.u0),
  };
}
