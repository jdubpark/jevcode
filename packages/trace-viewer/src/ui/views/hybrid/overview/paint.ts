import {
  LANE_H,
  LANES_TOP,
  OVERVIEW_H,
  RULER_TOP,
  STRIP_H,
  type MarkOp,
  type OverviewLayout,
  type PinPlacement,
} from "../../../../layout/overview-layout.js";
import type { Tick } from "../../../../layout/ticks.js";
import type { Tone } from "../../../../layout/tone.js";
import { LANES, type Lane } from "../../../../model/index.js";
import type { Tokens } from "../../../tokens/tokens.js";

/** The subset of CanvasRenderingContext2D the painter uses; a recording context implements it in tests. */
export interface PaintContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  fill(): void;
  stroke(): void;
}

export const LANES_BOTTOM = LANES_TOP + LANES.length * LANE_H;
export const STRIP_TOP = LANES_TOP - STRIP_H;
/** Height of one chapter-label tier: the 36 px label area holds two tiers (spec §7.2 Hybrid anatomy). */
const TIER_H = 18;
const FULL_TURN = Math.PI * 2;

export function laneTop(lane: Lane): number {
  return LANES_TOP + LANES.indexOf(lane) * LANE_H;
}

export function laneCenter(lane: Lane): number {
  return laneTop(lane) + LANE_H / 2;
}

export interface StripOverlay {
  brush: { x0: number; x1: number } | null;
  playheadX: number | null;
  viewport: { x0: number; x1: number } | null;
}

export interface PaintInput {
  layout: OverviewLayout;
  ticks: readonly Tick[];
  /** Lane area width in CSS px (the gutter is DOM). */
  widthPx: number;
  dpr: number;
  tokens: Tokens;
  /** Band keys drawn with fill-2 (hovered or selected). */
  emphasizedBands: ReadonlySet<string>;
  strip: StripOverlay;
  /** Spike risk 5 ruling: pins painted here; DOM buttons stay as focus targets. */
  paintPins: boolean;
}

function toneColor(tone: Tone, tokens: Tokens): string {
  if (tone === "bad") return tokens.bad;
  if (tone === "good") return tokens.good;
  return tokens.mark;
}

function dot(ctx: PaintContext, x: number, y: number, radius: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, FULL_TURN);
  ctx.fill();
}

function paintMark(ctx: PaintContext, mark: MarkOp, tokens: Tokens): void {
  const y = laneCenter(mark.lane);
  switch (mark.op) {
    case "dot":
      dot(ctx, mark.x, y, 3, toneColor(mark.tone, tokens));
      return;
    case "ring":
      ctx.strokeStyle = tokens.mark;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(mark.x, y, 3, 0, FULL_TURN);
      ctx.stroke();
      return;
    case "bar":
      ctx.fillStyle = toneColor(mark.tone, tokens);
      ctx.fillRect(mark.x0, y - 2, Math.max(1, mark.x1 - mark.x0), 4);
      if (mark.endTone !== undefined) dot(ctx, mark.x1, y, 2.5, toneColor(mark.endTone, tokens));
      return;
    case "heat":
      ctx.fillStyle = tokens.mark;
      ctx.fillRect(mark.x - 2, y + 4 - mark.h, 4, mark.h);
      return;
    case "hist":
      if (mark.upPx > 0) {
        ctx.fillStyle = tokens.ink2;
        ctx.fillRect(mark.x - 1.5, y - mark.upPx, 3, mark.upPx);
      }
      if (mark.downPx > 0) {
        ctx.strokeStyle = tokens.ink3;
        ctx.lineWidth = 1;
        ctx.strokeRect(mark.x - 1, y + 0.5, 2, Math.max(0.5, mark.downPx - 0.5));
      }
      return;
    case "wait":
      ctx.strokeStyle = tokens.mark;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(mark.x0, y - 3, Math.max(1, mark.x1 - mark.x0), 6);
      return;
    case "noise":
      ctx.strokeStyle = tokens.ink4;
      ctx.lineWidth = 1;
      ctx.strokeRect(mark.x0, y - 1, Math.max(1, mark.x1 - mark.x0), 2);
      return;
    case "problem":
      return;
  }
}

function paintStrip(ctx: PaintContext, input: PaintInput): void {
  const { layout, tokens, widthPx, strip } = input;
  ctx.fillStyle = tokens.fill;
  ctx.fillRect(0, STRIP_TOP, widthPx, STRIP_H);
  if (strip.brush !== null) {
    ctx.fillStyle = tokens.accentSoft;
    ctx.fillRect(strip.brush.x0, STRIP_TOP, Math.max(1, strip.brush.x1 - strip.brush.x0), STRIP_H);
  }
  let max = 0;
  for (const value of layout.strip) max = Math.max(max, value);
  if (max > 0) {
    ctx.fillStyle = tokens.mark;
    const bins = Math.min(layout.strip.length, Math.ceil(widthPx));
    for (let x = 0; x < bins; x += 1) {
      const value = layout.strip[x] ?? 0;
      if (value <= 0) continue;
      const h = Math.max(1, Math.round((value / max) * STRIP_H));
      ctx.fillRect(x, STRIP_TOP + STRIP_H - h, 1, h);
    }
  }
  if (strip.viewport !== null) {
    ctx.strokeStyle = tokens.ink4;
    ctx.lineWidth = 1;
    ctx.strokeRect(strip.viewport.x0 + 0.5, STRIP_TOP + 0.5, Math.max(1, strip.viewport.x1 - strip.viewport.x0 - 1), STRIP_H - 1);
  }
  if (strip.playheadX !== null) {
    ctx.fillStyle = tokens.accent;
    ctx.fillRect(Math.round(strip.playheadX), STRIP_TOP, 1, STRIP_H);
  }
}

function paintPinMarks(ctx: PaintContext, pins: readonly PinPlacement[], tokens: Tokens): void {
  for (const pin of pins) {
    ctx.fillStyle = pin.critical ? tokens.bad : tokens.panel;
    ctx.strokeStyle = pin.critical ? tokens.bad : tokens.hair;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(pin.x, laneCenter(pin.lane), 11, 0, FULL_TURN);
    ctx.fill();
    ctx.stroke();
  }
}

/** Pure painter over a PaintContext (spec §7.3 Hybrid overview). Text and icons stay in the DOM. */
export function paintOverview(ctx: PaintContext, input: PaintInput): void {
  const { layout, tokens, widthPx, dpr } = input;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, widthPx, OVERVIEW_H);

  for (const band of layout.bands) {
    ctx.fillStyle = input.emphasizedBands.has(band.key) ? tokens.fill2 : tokens.fill;
    const top = band.tier === 1 ? TIER_H : 0;
    ctx.fillRect(band.x0, top, Math.max(1, band.x1 - band.x0), LANES_BOTTOM - top);
  }

  ctx.fillStyle = tokens.hair;
  for (const lane of LANES) ctx.fillRect(0, Math.round(laneCenter(lane)), widthPx, 1);

  ctx.fillStyle = tokens.ink4;
  for (const line of layout.turnLines) ctx.fillRect(Math.round(line.x), RULER_TOP, 1, LANES_BOTTOM - RULER_TOP);
  for (const tick of input.ticks) {
    const h = tick.labeled ? 6 : 3;
    ctx.fillRect(Math.round(tick.x), STRIP_TOP - h, 1, h);
  }

  paintStrip(ctx, input);

  // Two passes instead of a collected list: nothing is allocated per frame.
  for (const mark of layout.marks) if (mark.op !== "problem") paintMark(ctx, mark, tokens);
  ctx.fillStyle = tokens.bad;
  for (const mark of layout.marks) {
    if (mark.op === "problem") ctx.fillRect(mark.x - 1, laneCenter(mark.lane) - 5, 2, 10);
  }

  if (input.paintPins) paintPinMarks(ctx, layout.pins, tokens);
}
