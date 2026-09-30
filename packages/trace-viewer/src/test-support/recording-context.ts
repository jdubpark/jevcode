// Test-only: records every paint call with the style in effect. Excluded from the build.
import type { PaintContext } from "../ui/views/hybrid/overview/paint.js";

export interface PaintOp {
  op: string;
  args: readonly number[];
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
}

export class RecordingContext implements PaintContext {
  fillStyle: string | CanvasGradient | CanvasPattern = "#000000";
  strokeStyle: string | CanvasGradient | CanvasPattern = "#000000";
  lineWidth = 1;
  readonly ops: PaintOp[] = [];

  private record(op: string, args: readonly number[]): void {
    this.ops.push({ op, args, fillStyle: String(this.fillStyle), strokeStyle: String(this.strokeStyle), lineWidth: this.lineWidth });
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.record("setTransform", [a, b, c, d, e, f]);
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    this.record("clearRect", [x, y, w, h]);
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.record("fillRect", [x, y, w, h]);
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    this.record("strokeRect", [x, y, w, h]);
  }

  beginPath(): void {
    this.record("beginPath", []);
  }

  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void {
    this.record("arc", [x, y, radius, startAngle, endAngle]);
  }

  fill(): void {
    this.record("fill", []);
  }

  stroke(): void {
    this.record("stroke", []);
  }

  fillRects(color: string): PaintOp[] {
    return this.ops.filter((op) => op.op === "fillRect" && op.fillStyle === color);
  }

  /** The arc that precedes each fill() painted with `color`. */
  filledArcs(color: string): PaintOp[] {
    const out: PaintOp[] = [];
    this.ops.forEach((op, position) => {
      if (op.op !== "fill" || op.fillStyle !== color) return;
      const arc = this.ops[position - 1];
      if (arc?.op === "arc") out.push(arc);
    });
    return out;
  }
}
