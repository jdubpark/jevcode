import { useEffect, useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

import type { BandPlacement, PinPlacement } from "../../../../layout/overview-layout.js";
import type { TimeScale } from "../../../../layout/time-scale.js";
import { brushSeqRange, type Brush as BrushState, type TraceIndex } from "../../../../layout/trace-index.js";
import { screenXToU, uToScreenX, type XOnlyCamera } from "../../../../layout/viewport.js";
import { formatOffset, type Level, type TraceSession } from "../../../../model/index.js";
import { selectionTitle } from "../../../inspector/finding-copy.js";
import type { Gesture, Tool } from "../../../state/view-state.js";
import styles from "./Overview.module.css";

export function stepX(session: TraceSession, scale: TimeScale, camera: XOnlyCamera, stepIndex: number): number {
  const step = session.steps[stepIndex];
  return step === undefined ? 0 : uToScreenX(camera, scale.toU(step.tMs));
}

function stepEndX(session: TraceSession, scale: TimeScale, camera: XOnlyCamera, stepIndex: number): number {
  const step = session.steps[stepIndex];
  return step === undefined ? 0 : uToScreenX(camera, scale.toU(step.tMs + (step.durationMs ?? 0)));
}

/** Step nearest to screen x ("after": the first step at or after x). Step.tMs never decreases with seq. */
export function stepIndexAtX(
  session: TraceSession,
  scale: TimeScale,
  camera: XOnlyCamera,
  x: number,
  mode: "nearest" | "after" = "nearest",
): number {
  const steps = session.steps;
  if (steps.length === 0) return -1;
  const t = scale.toT(screenXToU(camera, x));
  let lo = 0;
  let hi = steps.length - 1;
  let first = steps.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((steps[mid]?.tMs ?? 0) >= t) {
      first = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (first >= steps.length) return steps.length - 1;
  if (mode === "after" || first === 0) return first;
  const before = first - 1;
  return t - (steps[before]?.tMs ?? 0) <= (steps[first]?.tMs ?? 0) - t ? before : first;
}

export interface BrushProps {
  session: TraceSession;
  index: TraceIndex;
  scale: TimeScale;
  camera: XOnlyCamera;
  level: Level;
  brush: BrushState;
  playheadSeq: number;
  pins: readonly PinPlacement[];
  bands: readonly BandPlacement[];
  tool: Tool;
  onPlayhead(seq: number): void;
  onStep(dir: 1 | -1): void;
  onBrush(brush: BrushState): void;
  onGesture(gesture: Gesture): void;
}

function lanesLeft(element: Element): number {
  return element.closest("[data-overview-lanes]")?.getBoundingClientRect().left ?? 0;
}

export function Brush(props: BrushProps) {
  const { session, index, scale, camera, level, brush, playheadSeq, pins, bands, tool } = props;
  const steps = session.steps;
  const range = brushSeqRange(brush, index);
  const fromIndex = Math.min(steps.length - 1, Math.max(0, index.stepIndexAtOrAfter(range.fromSeq)));
  const toIndex = Math.max(0, index.stepIndexAtOrBefore(range.toSeq));
  const x0 = stepX(session, scale, camera, fromIndex);
  const x1 = Math.max(x0 + 2, stepEndX(session, scale, camera, toIndex));
  const playIndex = Math.max(0, index.stepIndexAtOrBefore(playheadSeq));
  const playStep = steps[playIndex];
  const px = stepX(session, scale, camera, playIndex);

  const seqAt = (x: number): number => steps[Math.max(0, stepIndexAtX(session, scale, camera, x))]?.firstSeq ?? 1;

  const rangeFor = (a: number, b: number, snap: boolean): BrushState => {
    let lo = Math.min(a, b);
    let hi = Math.max(a, b);
    if (snap && level === "session") {
      const start = bands.find((band) => band.x0 <= lo && lo <= band.x1);
      const end = bands.find((band) => band.x0 <= hi && hi <= band.x1);
      if (start !== undefined) lo = start.x0;
      if (end !== undefined) hi = end.x1;
    }
    const from = seqAt(lo);
    const to = seqAt(hi);
    return { kind: "range", fromSeq: Math.min(from, to), toSeq: Math.max(from, to) };
  };

  // One drag at a time; unmounting mid-drag ends it so the store never keeps a stale gesture.
  const endDragRef = useRef<((commit: boolean) => void) | null>(null);
  const onGestureRef = useRef(props.onGesture);
  onGestureRef.current = props.onGesture;
  useEffect(
    () => () => {
      endDragRef.current?.(false);
    },
    [],
  );

  const beginDrag = (
    event: ReactPointerEvent<HTMLElement>,
    gesture: Gesture,
    onMove: (startX: number, x: number, alt: boolean) => void,
    onClick: ((x: number) => void) | null,
  ): void => {
    if (event.button !== 0 || tool === "hand") return;
    endDragRef.current?.(false);
    const element = event.currentTarget;
    const origin = lanesLeft(element);
    const startX = event.clientX - origin;
    const pointerId = event.pointerId;
    let dragging = false;
    let lastX = startX;
    let lastAlt = false;
    if (typeof element.setPointerCapture === "function") element.setPointerCapture(pointerId);
    const move = (e: PointerEvent): void => {
      lastX = e.clientX - origin;
      lastAlt = e.altKey;
      if (!dragging && Math.abs(lastX - startX) >= 4) {
        dragging = true;
        onGestureRef.current(gesture);
      }
      if (dragging) onMove(startX, lastX, lastAlt);
    };
    // Idempotent: pointerup, pointercancel, lostpointercapture and unmount all end the drag once.
    const finish = (commit: boolean): void => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", cancel);
      element.removeEventListener("lostpointercapture", cancel);
      if (endDragRef.current === finish) endDragRef.current = null;
      if (typeof element.hasPointerCapture === "function" && element.hasPointerCapture(pointerId)) {
        element.releasePointerCapture(pointerId);
      }
      if (dragging) {
        if (commit) onMove(startX, lastX, lastAlt);
        onGestureRef.current(null);
      } else if (commit && onClick !== null) {
        onClick(startX);
      }
    };
    const up = (e: PointerEvent): void => {
      lastX = e.clientX - origin;
      lastAlt = e.altKey;
      finish(true);
    };
    const cancel = (): void => finish(false);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", cancel);
    element.addEventListener("lostpointercapture", cancel);
    endDragRef.current = finish;
  };

  const onPlayheadKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const edge = event.key === "Home" ? steps[0] : steps.at(-1);
      if (edge !== undefined) props.onPlayhead(edge.firstSeq);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const dir: 1 | -1 = event.key === "ArrowRight" ? 1 : -1;
    const pick = (xs: number[]): number | undefined =>
      dir === 1 ? xs.find((x) => x > px + 0.5) : [...xs].reverse().find((x) => x < px - 0.5);
    if (event.altKey) {
      const target = pick(pins.map((pin) => pin.x).sort((a, b) => a - b));
      const pin = pins.find((item) => item.x === target);
      const step = pin?.stepIndexes[0] === undefined ? undefined : steps[pin.stepIndexes[0]];
      if (step !== undefined) props.onPlayhead(step.firstSeq);
      return;
    }
    if (event.shiftKey) {
      const target = pick(bands.map((band) => band.x0).sort((a, b) => a - b));
      if (target === undefined) return;
      const step = steps[stepIndexAtX(session, scale, camera, target + 0.5, "after")];
      if (step !== undefined) props.onPlayhead(step.firstSeq);
      return;
    }
    props.onStep(dir);
  };

  const onEdgeKeyDown = (edge: "from" | "to") => (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const dir = event.key === "ArrowRight" ? 1 : -1;
    const from = steps[Math.max(0, Math.min(steps.length - 1, fromIndex + (edge === "from" ? dir : 0)))]?.firstSeq ?? 1;
    const to = steps[Math.max(0, Math.min(steps.length - 1, toIndex + (edge === "to" ? dir : 0)))]?.firstSeq ?? from;
    props.onBrush({ kind: "range", fromSeq: Math.min(from, to), toSeq: Math.max(from, to) });
  };

  const valueText = (stepIndex: number): string => formatOffset(steps[stepIndex]?.tMs ?? 0);

  return (
    <>
      <div
        className={styles.track}
        data-testid="overview-track"
        data-pannable=""
        onPointerDown={(event) =>
          beginDrag(
            event,
            "brush",
            (startX, x, alt) => props.onBrush(rangeFor(startX, x, !alt)),
            (x) => props.onPlayhead(seqAt(x)),
          )
        }
      />
      {brush.kind === "session" ? null : (
        <>
          <div
            className={styles.brushBody}
            data-overlay-node=""
            style={{ left: x0, width: x1 - x0 }}
            onPointerDown={(event) =>
              beginDrag(event, "brush", (startX, x) => props.onBrush(rangeFor(x0 + x - startX, x1 + x - startX, false)), null)
            }
          />
          <div
            role="slider"
            tabIndex={-1}
            aria-label="Range start"
            aria-valuemin={1}
            aria-valuemax={steps.length}
            aria-valuenow={fromIndex + 1}
            aria-valuetext={`${valueText(fromIndex)}, step ${fromIndex + 1} of ${steps.length}`}
            data-overlay-node=""
            className={styles.edge}
            style={{ left: x0 - 4 }}
            onKeyDown={onEdgeKeyDown("from")}
            onPointerDown={(event) =>
              beginDrag(event, "brush", (startX, x) => props.onBrush(rangeFor(x0 + x - startX, x1, false)), null)
            }
          />
          <div
            role="slider"
            tabIndex={-1}
            aria-label="Range end"
            aria-valuemin={1}
            aria-valuemax={steps.length}
            aria-valuenow={toIndex + 1}
            aria-valuetext={`${valueText(toIndex)}, step ${toIndex + 1} of ${steps.length}`}
            data-overlay-node=""
            className={styles.edge}
            style={{ left: x1 - 4 }}
            onKeyDown={onEdgeKeyDown("to")}
            onPointerDown={(event) =>
              beginDrag(event, "brush", (startX, x) => props.onBrush(rangeFor(x0, x1 + x - startX, false)), null)
            }
          />
        </>
      )}
      <div className={styles.playheadLine} data-overlay-node="" style={{ left: Math.round(px) }} />
      {playStep === undefined ? null : (
        <div
          role="slider"
          tabIndex={-1}
          aria-label="Playhead"
          aria-orientation="horizontal"
          aria-valuemin={1}
          aria-valuemax={steps.length}
          aria-valuenow={playIndex + 1}
          aria-valuetext={`${formatOffset(playStep.tMs)}, ${selectionTitle(session, index, playStep.id)}, step ${playIndex + 1} of ${steps.length}`}
          data-overlay-node=""
          className={styles.playheadHandle}
          style={{ left: Math.round(px) - 6 }}
          onKeyDown={onPlayheadKeyDown}
          onPointerDown={(event) => beginDrag(event, "playhead", (_startX, x) => props.onPlayhead(seqAt(x)), null)}
        />
      )}
    </>
  );
}
