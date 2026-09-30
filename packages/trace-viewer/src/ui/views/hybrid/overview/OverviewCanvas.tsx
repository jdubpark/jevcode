import { useLayoutEffect, useRef, useState } from "react";

import type { PaintContext } from "./paint.js";

export interface CanvasSurface {
  ctx: PaintContext;
  dpr: number;
  widthPx: number;
  heightPx: number;
}

export interface OverviewCanvasProps {
  /** CSS px; the parent owns measurement (ResizeObserver) and passes the lane-area size. */
  widthPx: number;
  heightPx: number;
  className?: string;
  onSurface(surface: CanvasSurface | null): void;
  /** Test seam: jsdom has no 2D context. */
  createContext?(canvas: HTMLCanvasElement): PaintContext | null;
}

function dprOf(view: Window | null): number {
  return view?.devicePixelRatio || 1;
}

/**
 * One DPR-scaled, aria-hidden canvas. A DPR change (window dragged between displays) re-creates the
 * surface. DOM globals are reached through the element's own window, never a bare global.
 *
 * `onSurface` and `createContext` must be stable (memoized by the caller): a new identity re-runs the
 * surface effect, which tears the surface down (`onSurface(null)`) and publishes a fresh one.
 * The surface is first published after the real DPR is read from the element's window, never at a
 * placeholder DPR of 1.
 */
export function OverviewCanvas({ widthPx, heightPx, className, onSurface, createContext }: OverviewCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [dpr, setDpr] = useState<number | null>(null);

  // Track devicePixelRatio: a resolution media query fires once per change, so re-arm it per value.
  useLayoutEffect(() => {
    const view = ref.current?.ownerDocument.defaultView ?? null;
    const current = dprOf(view);
    if (current !== dpr) setDpr(current);
    if (view === null || typeof view.matchMedia !== "function") return undefined;
    const query = view.matchMedia(`(resolution: ${current}dppx)`);
    const onChange = (): void => setDpr(dprOf(view));
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [dpr]);

  useLayoutEffect(() => {
    const canvas = ref.current;
    if (canvas === null || dpr === null || widthPx <= 0 || heightPx <= 0) {
      onSurface(null);
      return undefined;
    }
    const ctx = createContext !== undefined ? createContext(canvas) : (canvas.getContext("2d") as PaintContext | null);
    onSurface(ctx === null ? null : { ctx, dpr, widthPx, heightPx });
    return () => onSurface(null);
  }, [widthPx, heightPx, dpr, createContext, onSurface]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className={className}
      width={Math.max(0, Math.round(widthPx * (dpr ?? 1)))}
      height={Math.max(0, Math.round(heightPx * (dpr ?? 1)))}
      style={{ width: widthPx, height: heightPx }}
    />
  );
}
