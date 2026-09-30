import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { Level, TraceSession } from "../model/index.js";
import {
  arbCanvasMutation,
  arbCanvasSession,
  canvasPrefix,
  canvasScale,
  mutateCanvasSession,
} from "../test-support/canvas-arbitraries.js";
import { LEVEL_SPECS, frameSize } from "./canvas-levels.js";
import { canvasXMap, collectItems, layoutCanvas, type CanvasItem, type CanvasLayout } from "./canvas-layout.js";
import { homeFrameKey, samplePath, type RouteInput } from "./canvas-routes.js";
import { worstSeverity } from "./tone.js";
import { buildTraceIndex } from "./trace-index.js";
import type { Rect } from "./viewport.js";

// Spec §7.5 invariants P1–P10 (P9 is added by C3-3).

const levels = fc.constantFrom<Level>("session", "chapter", "step");
const RUNS = { numRuns: 150 };

function fresh(session: TraceSession, level: Level, prev?: CanvasLayout): CanvasLayout {
  return layoutCanvas(session, buildTraceIndex(session), canvasScale(session), level, prev);
}

function itemsOf(session: TraceSession): Map<string, CanvasItem> {
  return new Map(collectItems(session, buildTraceIndex(session)).map((item) => [item.key, item]));
}

function gap(a: Rect, b: Rect): { dx: number; dy: number } {
  const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  return { dx, dy };
}

function checkP1(layout: CanvasLayout): void {
  const spec = LEVEL_SPECS[layout.level];
  const rects = [...layout.frames.map((frame) => ({ rect: frame.slot, col: frame.col })), ...layout.holes.map((rect) => ({ rect, col: -1 }))];
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i];
      const b = rects[j];
      if (a === undefined || b === undefined) continue;
      const { dx, dy } = gap(a.rect, b.rect);
      expect(dx > 0 || dy > 0, "slots overlap").toBe(true);
      if (a.rect.x === b.rect.x) expect(dy).toBeGreaterThanOrEqual(spec.rowGap);
      else expect(dx).toBeGreaterThanOrEqual(spec.colGap);
    }
  }
}

function colOfItem(layout: CanvasLayout): Map<string, { col: number; x: number }> {
  const out = new Map<string, { col: number; x: number }>();
  for (const frame of layout.frames) for (const key of frame.members) out.set(key, { col: frame.col, x: frame.slot.x });
  return out;
}

function checkP2(layout: CanvasLayout, items: Map<string, CanvasItem>): void {
  const placed = [...colOfItem(layout)]
    .map(([key, at]) => ({ start: items.get(key)?.start ?? NaN, ...at }))
    .sort((a, b) => a.start - b.start);
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const a = placed[i];
      const b = placed[j];
      if (a === undefined || b === undefined || !(a.start < b.start)) continue;
      expect(a.col).toBeLessThanOrEqual(b.col);
      expect(a.x).toBeLessThanOrEqual(b.x);
    }
  }
}

function checkP3(layout: CanvasLayout, session: TraceSession, items: Map<string, CanvasItem>): void {
  const map = canvasXMap(layout, canvasScale(session));
  const first = layout.columns[0];
  for (const frame of layout.frames) {
    for (const key of frame.members) {
      const item = items.get(key);
      if (item === undefined || first === undefined || item.start < first.t0) continue;
      const column = layout.columns[frame.col];
      const next = layout.columns[frame.col + 1];
      const x = map.xOf(item.start);
      // At a push the map jumps from the first breakpoint's xIn to the last breakpoint's xOut at that time,
      // so items that share a start and open several columns all sit inside the jump.
      const atStart = layout.time.bps.filter((bp) => bp.t === item.start);
      const left = Math.min(x, ...atStart.map((bp) => bp.xIn));
      if (column !== undefined) expect(x).toBeGreaterThanOrEqual(column.x - 1e-6);
      if (next !== undefined) expect(left).toBeLessThanOrEqual(next.x + 1e-6);
      if (!frame.late) expect(Math.abs(map.tOf(x) - item.start)).toBeLessThan(1e-3);
    }
  }
  const starts = [...items.values()].map((item) => item.start).sort((a, b) => a - b);
  for (let i = 1; i < starts.length; i += 1) {
    expect(map.xOf(starts[i] ?? 0)).toBeGreaterThanOrEqual(map.xOf(starts[i - 1] ?? 0) - 1e-6);
  }
}

function checkP4(layout: CanvasLayout, session: TraceSession, items: Map<string, CanvasItem>): void {
  const spec = LEVEL_SPECS[layout.level];
  const scale = canvasScale(session);
  for (const frame of layout.frames) {
    const column = layout.columns[frame.col];
    for (const key of frame.members) expect(items.get(key)?.turn).toBe(column?.turn);
  }
  for (const sep of layout.separators) {
    const next = layout.columns.find((column) => column.x > sep.x);
    const prev = [...layout.columns].reverse().find((column) => column.x < sep.x);
    if (prev !== undefined) expect(prev.x + spec.w).toBeLessThan(sep.x);
    if (next !== undefined) expect(sep.x).toBeLessThan(next.x);
  }
  for (const column of layout.columns) {
    const starts = [
      ...new Set(
        layout.frames
          .filter((frame) => frame.col === column.index)
          .flatMap((frame) => frame.members.map((key) => items.get(key)?.start ?? column.t0)),
      ),
    ].sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i += 1) {
      if ((starts[i] ?? 0) - (starts[i - 1] ?? 0) < spec.breakMinMs) continue;
      const u0 = scale.toU(starts[i - 1] ?? 0);
      const u1 = scale.toU(starts[i] ?? 0);
      const inside = scale.breaks(u0, u1, spec.breakMinMs).filter((seg) => seg.u1 > u0 && seg.u0 < u1);
      expect(inside, `column ${column.index} spans a break`).toEqual([]);
    }
  }
}

function checkP8(layout: CanvasLayout, items: Map<string, CanvasItem>): void {
  const members = layout.frames.flatMap((frame) => frame.members);
  expect(new Set(members).size).toBe(members.length);
  expect(new Set(members)).toEqual(new Set(items.keys()));
}

function checkP10(layout: CanvasLayout): void {
  for (const frame of layout.frames) {
    const size = frameSize(layout.level, frame.item);
    expect({ w: frame.slot.w, h: frame.slot.h }).toEqual(size);
  }
}

describe("canvas layout invariants", () => {
  it("P1 no overlap, fresh and after mutations", () => {
    fc.assert(
      fc.property(arbCanvasSession(), fc.array(arbCanvasMutation, { maxLength: 6 }), levels, (session, ops, level) => {
        const first = fresh(session, level);
        checkP1(first);
        checkP1(fresh(mutateCanvasSession(session, ops), level, first));
      }),
      RUNS,
    );
  });

  it("P2 monotone x versus start, fresh and sticky", () => {
    fc.assert(
      fc.property(arbCanvasSession(), fc.array(arbCanvasMutation, { maxLength: 6 }), levels, (session, ops, level) => {
        const first = fresh(session, level);
        checkP2(first, itemsOf(session));
        const mutated = mutateCanvasSession(session, ops);
        checkP2(fresh(mutated, level, first), itemsOf(mutated));
      }),
      RUNS,
    );
  });

  it("P3 the ruler is truthful", () => {
    fc.assert(
      fc.property(arbCanvasSession(), fc.array(arbCanvasMutation, { maxLength: 4 }), levels, (session, ops, level) => {
        const first = fresh(session, level);
        checkP3(first, session, itemsOf(session));
        const mutated = mutateCanvasSession(session, ops);
        checkP3(fresh(mutated, level, first), mutated, itemsOf(mutated));
      }),
      RUNS,
    );
  });

  it("P4 turns and breaks sit in gutters (fresh layouts)", () => {
    fc.assert(
      fc.property(arbCanvasSession(), levels, (session, level) => {
        checkP4(fresh(session, level), session, itemsOf(session));
      }),
      RUNS,
    );
  });

  it("P5 append equals fresh", () => {
    fc.assert(
      fc.property(arbCanvasSession(), fc.nat(), levels, (session, pick, level) => {
        const index = buildTraceIndex(session);
        const scale = canvasScale(session);
        const starts = [...new Set(collectItems(session, index).map((item) => item.start))].sort((a, b) => a - b);
        const cut = starts[pick % Math.max(1, starts.length)] ?? 0;
        const prefix = canvasPrefix(session, cut);
        const first = layoutCanvas(prefix, buildTraceIndex(prefix), scale, level);
        expect(layoutCanvas(session, index, scale, level, first)).toEqual(layoutCanvas(session, index, scale, level));
      }),
      RUNS,
    );
  });

  it("P6 sticky under churn, merges, flips, late arrivals and appends", () => {
    fc.assert(
      fc.property(arbCanvasSession(), fc.array(arbCanvasMutation, { maxLength: 6 }), levels, (session, ops, level) => {
        const first = fresh(session, level);
        const next = fresh(mutateCanvasSession(session, ops), level, first);
        for (const [key, frame] of first.frameByKey) {
          const after = next.frameByKey.get(key);
          if (after !== undefined) expect(after.slot, key).toEqual(frame.slot);
        }
        expect(next.time.bps.slice(0, first.time.bps.length)).toEqual(first.time.bps);
      }),
      RUNS,
    );
  });

  it("P7 deterministic, including shuffled chapters, steps and findings", () => {
    fc.assert(
      fc.property(arbCanvasSession(), levels, (session, level) => {
        const index = buildTraceIndex(session);
        const scale = canvasScale(session);
        const once = layoutCanvas(session, index, scale, level);
        expect(layoutCanvas(session, index, scale, level)).toEqual(once);
        // Turns stay in seq order: the model contract sorts them and layout binary-searches them.
        const shuffled: TraceSession = {
          ...session,
          chapters: [...session.chapters].reverse(),
          steps: [...session.steps].reverse(),
          findings: [...session.findings].reverse(),
        };
        expect(layoutCanvas(shuffled, buildTraceIndex(shuffled), scale, level)).toEqual(once);
      }),
      RUNS,
    );
  });

  it("P8 every current item appears exactly once, fresh and sticky", () => {
    fc.assert(
      fc.property(arbCanvasSession(), fc.array(arbCanvasMutation, { maxLength: 6 }), levels, (session, ops, level) => {
        const first = fresh(session, level);
        checkP8(first, itemsOf(session));
        const mutated = mutateCanvasSession(session, ops);
        checkP8(fresh(mutated, level, first), itemsOf(mutated));
      }),
      RUNS,
    );
  });

  it("P10 slot size depends only on (level, kind) in fresh layouts", () => {
    fc.assert(fc.property(arbCanvasSession(), levels, (session, level) => checkP10(fresh(session, level))), RUNS);
  });

  it("P9 rest edges cross no card; only contradicts is red; one contradicts per evidence frame; lanes in range", () => {
    fc.assert(
      fc.property(arbCanvasSession(), levels, (session, level) => {
        const layout = fresh(session, level);
        const spec = LEVEL_SPECS[level];
        for (const edge of layout.edges) {
          if (edge.tone === "bad") expect(edge.kind).toBe("contradicts");
          if (edge.kind === "contradicts") {
            expect(edge.rest).toBe(true);
            expect(edge.d).not.toBeNull();
          }
          // Spec §7.5: channel lane 0 is the trunk, channel lane 1 and rail lane 0 are reserved for contradicts.
          if (edge.shape === "channel" && edge.d !== null) {
            expect(edge.lane).not.toBeNull();
            expect(edge.lane ?? -1).toBeLessThan(spec.channelLanes);
            expect(edge.lane === 1, `${edge.id} lane ${edge.lane}`).toBe(edge.kind === "contradicts");
            expect(edge.lane ?? 0).toBeGreaterThanOrEqual(1);
          }
          if (edge.shape === "rail" && edge.d !== null) {
            expect(edge.lane).not.toBeNull();
            expect(edge.lane ?? -1).toBeLessThan(spec.railLanes);
            expect(edge.lane === 0, `${edge.id} lane ${edge.lane}`).toBe(edge.kind === "contradicts");
          }
          if (!edge.rest || edge.d === null || edge.shape === "direct") continue;
          for (const point of samplePath(edge.d)) {
            for (const frame of layout.frames) {
              const { x, y, w, h } = frame.card;
              const inside = point.x > x + 1 && point.x < x + w - 1 && point.y > y + 1 && point.y < y + h - 1;
              expect(inside, `${edge.id} crosses ${frame.key}`).toBe(false);
            }
          }
        }
        const input: RouteInput = { session, frames: layout.frames, frameByKey: layout.frameByKey, columns: layout.columns, spec };
        for (const finding of session.findings) {
          if (finding.ruleId !== "claim_contradicted") continue;
          const from = homeFrameKey(finding.claimStepId ?? finding.anchorStepId, input);
          const targets = new Set(
            (finding.evidenceStepIds ?? [])
              .map((id) => homeFrameKey(id, input))
              .filter((key): key is string => key !== undefined && key !== from),
          );
          const drawn = layout.edges.filter((edge) => edge.kind === "contradicts" && edge.findingId === finding.id);
          expect(drawn).toHaveLength(targets.size);
          expect(new Set(drawn.map((edge) => edge.to))).toEqual(targets);
          for (const edge of drawn) expect(edge.from).toBe(from);
        }
      }),
      RUNS,
    );
  });

  it("P8 every warning-or-worse step is reachable through its home frame", () => {
    fc.assert(
      fc.property(arbCanvasSession(), levels, (session, level) => {
        const layout = fresh(session, level);
        const input: RouteInput = {
          session,
          frames: layout.frames,
          frameByKey: layout.frameByKey,
          columns: layout.columns,
          spec: LEVEL_SPECS[level],
        };
        const findingsById = new Map(session.findings.map((finding) => [finding.id, finding]));
        for (const step of session.steps) {
          const severity = worstSeverity(step, findingsById);
          if (severity !== "warning" && severity !== "critical") continue;
          const key = homeFrameKey(step.id, input);
          expect(key, step.id).toBeDefined();
          expect(layout.frameByKey.has(key ?? "")).toBe(true);
        }
      }),
      RUNS,
    );
  });
});
