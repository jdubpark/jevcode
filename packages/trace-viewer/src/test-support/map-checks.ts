// Test-only: geometric checks shared by the Map layout property and fixture tests. Excluded from the build.
import { expect } from "vitest";

import type { MapLayout } from "../layout/map-layout.js";

interface Box { label: string; x: number; y: number; w: number; h: number }

/**
 * The polyline of an edge path made of absolute M, H, V, L and C commands. Each cubic is sampled at t = 0, 1/8, …, 1,
 * so a curve is checked as eight chords; the layout keeps every curve inside a gutter or a gap row, far from a card edge.
 */
export function pathPoints(d: string): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  let x = 0;
  let y = 0;
  for (const match of d.matchAll(/([MHVLC])([^MHVLC]*)/g)) {
    const command = match[1];
    const values = (match[2] ?? "").trim().split(/[\s,]+/).filter((v) => v !== "").map(Number);
    if (command === "C") {
      const [c1x = x, c1y = y, c2x = x, c2y = y, ex = x, ey = y] = values;
      for (let i = 0; i <= 8; i += 1) {
        const t = i / 8;
        const u = 1 - t;
        points.push({
          x: u * u * u * x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ex,
          y: u * u * u * y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ey,
        });
      }
      x = ex;
      y = ey;
      continue;
    }
    if (command === "H") x = values[0] ?? x;
    else if (command === "V") y = values[0] ?? y;
    else {
      x = values[0] ?? x;
      y = values[1] ?? y;
    }
    points.push({ x, y });
  }
  return points;
}

/** True when segment a→b enters the open rectangle `box` shrunk by 0.5 px (Liang–Barsky). */
function segmentEnters(a: { x: number; y: number }, b: { x: number; y: number }, box: Box): boolean {
  const x0 = box.x + 0.5;
  const x1 = box.x + box.w - 0.5;
  const y0 = box.y + 0.5;
  const y1 = box.y + box.h - 0.5;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [[-dx, a.x - x0], [dx, x1 - a.x], [-dy, a.y - y0], [dy, y1 - a.y]] as const) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return false;
  }
  return true;
}

export function expectNoOverlaps(layout: MapLayout): void {
  const boxes: Box[] = layout.cards.map((card) => ({ label: `card ${card.id}`, x: card.x, y: card.y, w: card.w, h: card.h }));
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      if (a === undefined || b === undefined) continue;
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      expect(apart, `${a.label} overlaps ${b.label}`).toBe(true);
    }
  }
}

/** No edge, curve or line, passes under a card other than its two endpoints (spec §8.3). */
export function expectNoCardCrossings(layout: MapLayout): void {
  for (const edge of layout.edges) {
    const points = pathPoints(edge.d);
    for (const card of layout.cards) {
      if (card.id === edge.from || card.id === edge.to) continue;
      for (let i = 1; i < points.length; i += 1) {
        const a = points[i - 1];
        const b = points[i];
        if (a === undefined || b === undefined) continue;
        expect(segmentEnters(a, b, { label: card.id, ...card }), `${edge.from}>${edge.to} crosses ${card.id}: ${edge.d}`).toBe(false);
      }
    }
  }
}

/** Every edge starts and ends at the vertical center of a side of its two cards (one port per side, no spreading). */
export function expectEdgesOnPorts(layout: MapLayout): void {
  for (const edge of layout.edges) {
    const ends = [edge.from, edge.to].map((id) => layout.cards.find((card) => card.id === id));
    const points = pathPoints(edge.d);
    for (const point of [points[0], points.at(-1)]) {
      const onPort = ends.some(
        (card) => card !== undefined && point !== undefined && (point.x === card.x || point.x === card.x + card.w) && point.y === card.y + card.h / 2,
      );
      expect(onPort, `${edge.from}>${edge.to} has an end off a port: ${edge.d}`).toBe(true);
    }
  }
}
