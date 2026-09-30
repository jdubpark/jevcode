import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type React from "react";

import type { CanvasLayout } from "../../../layout/canvas-layout.js";
import {
  MINIMAP_H,
  MINIMAP_STRIP_H,
  MINIMAP_W,
  buildMinimap,
  minimapToWorld,
  type MinimapModel,
} from "../../../layout/canvas-minimap.js";
import { screenToWorld, type Point, type Rect, type Size, type UniformCamera } from "../../../layout/viewport.js";
import type { CameraStore } from "./canvas-camera.js";
import styles from "./chrome.module.css";

export interface MinimapProps {
  layout: CanvasLayout;
  cameraStore: CameraStore;
  viewport: Size;
  selectedKey: string | null;
  criticalKeys: ReadonlySet<string>;
  onCenter(world: Point): void;
  onPan(dxWorld: number, dyWorld: number): void;
}

const MARK_CLASS: { readonly [K in MinimapModel["frames"][number]["mark"]]: string | undefined } = {
  frame: styles.miniFrame,
  selected: styles.miniSelected,
  critical: styles.miniCritical,
  noise: styles.miniNoise,
};

function viewportWorld(camera: UniformCamera, viewport: Size): Rect {
  const topLeft = screenToWorld(camera, { x: 0, y: 0 });
  const bottomRight = screenToWorld(camera, { x: viewport.w, y: viewport.h });
  return { x: topLeft.x, y: topLeft.y, w: bottomRight.x - topLeft.x, h: bottomRight.y - topLeft.y };
}

/** The viewport outline in minimap px under a (static) model's scale and origin. */
function outlineRect(model: MinimapModel, world: Rect): Rect {
  return {
    x: (world.x - model.origin.x) * model.scale,
    y: (world.y - model.origin.y) * model.scale,
    w: Math.max(2, world.w * model.scale),
    h: Math.max(2, world.h * model.scale),
  };
}

function writeOutline(element: SVGRectElement | null, rect: Rect): void {
  if (element === null) return;
  element.setAttribute("x", String(rect.x));
  element.setAttribute("y", String(rect.y));
  element.setAttribute("width", String(rect.w));
  element.setAttribute("height", String(rect.h));
}

/**
 * A 140 × 84 SVG derived from the layout (spec §7.5 "Minimap"); pointer-only, so it is aria-hidden. The frames, edges
 * and separators are a static model per (layout, selection, critical frames, window); a camera frame only moves the
 * viewport outline through a ref, with no React render (spec §7.5: per-frame writes hit only the minimap rectangle).
 * A windowed minimap (session wider than 140 / s) re-windows only when the view's center leaves the window's center
 * by a quarter span.
 */
export function Minimap(props: MinimapProps): React.JSX.Element {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const outlineRef = useRef<SVGRectElement | null>(null);
  const drag = useRef<Point | null>(null);
  const { layout, viewport, selectedKey, criticalKeys, cameraStore } = props;
  const centerOf = (camera: UniformCamera): number => {
    const world = viewportWorld(camera, viewport);
    return world.x + world.w / 2;
  };
  const [windowCenter, setWindowCenter] = useState(() => centerOf(cameraStore.get()));
  const model = useMemo(
    // Only the window placement reads the viewport rect here; the outline is written from the live camera below.
    () => buildMinimap(layout, { viewportWorld: { x: windowCenter, y: 0, w: 0, h: 0 }, selectedKey, criticalKeys }),
    [layout, windowCenter, selectedKey, criticalKeys],
  );
  const modelRef = useRef(model);
  useLayoutEffect(() => {
    modelRef.current = model;
    const apply = (): void => {
      const camera = cameraStore.get();
      const current = modelRef.current;
      const world = viewportWorld(camera, viewport);
      if (current.window !== null) {
        const span = current.window.x1 - current.window.x0;
        const center = world.x + world.w / 2;
        if (Math.abs(center - windowCenter) >= span / 4) setWindowCenter(center);
      }
      writeOutline(outlineRef.current, outlineRect(current, world));
    };
    apply();
    return cameraStore.subscribe(apply);
  }, [cameraStore, model, viewport, windowCenter]);
  const initial = outlineRect(model, viewportWorld(cameraStore.get(), viewport));
  const local = (event: React.PointerEvent): Point => {
    const box = svgRef.current?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  };
  return (
    <div className={styles.minimap} aria-hidden="true">
      <svg
        ref={svgRef}
        className={styles.miniSvg}
        width={MINIMAP_W}
        height={MINIMAP_H}
        data-minimap=""
        onPointerDown={(event) => {
          if (event.button === 0) props.onCenter(minimapToWorld(model, local(event)));
        }}
      >
        <g transform={`scale(${model.scale}) translate(${-model.origin.x} ${-model.origin.y})`}>
          {model.edges.map((edge, index) => (
            <path key={index} className={styles.miniEdge} d={edge.d} />
          ))}
        </g>
        {model.separators.map((sep, index) => (
          <line key={index} className={styles.miniSep} x1={sep.x} x2={sep.x} y1={0} y2={MINIMAP_H} />
        ))}
        {model.frames.map((frame) => (
          <rect
            key={frame.key}
            data-mark={frame.mark}
            className={MARK_CLASS[frame.mark]}
            x={frame.rect.x}
            y={frame.rect.y}
            width={Math.max(1, frame.rect.w)}
            height={Math.max(1, frame.rect.h)}
            rx={1}
          />
        ))}
        <rect
          ref={outlineRef}
          data-viewport=""
          className={styles.miniViewport}
          x={initial.x}
          y={initial.y}
          width={initial.w}
          height={initial.h}
          onPointerDown={(event) => {
            event.stopPropagation();
            if (event.button !== 0) return;
            drag.current = { x: event.clientX, y: event.clientY };
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            const from = drag.current;
            if (from === null) return;
            // A release the element never saw (capture lost, button let go outside): stop instead of hover-panning.
            if (event.buttons === 0) {
              drag.current = null;
              return;
            }
            drag.current = { x: event.clientX, y: event.clientY };
            props.onPan((event.clientX - from.x) / model.scale, (event.clientY - from.y) / model.scale);
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onLostPointerCapture={() => {
            drag.current = null;
          }}
        />
      </svg>
      {model.strip === null ? null : (
        <svg className={styles.strip} width={MINIMAP_W} height={MINIMAP_STRIP_H}>
          <rect
            className={styles.stripBracket}
            x={model.strip.bracket[0]}
            y={0}
            width={Math.max(1, model.strip.bracket[1] - model.strip.bracket[0])}
            height={MINIMAP_STRIP_H}
          />
          {model.strip.critical.map((x, index) => (
            <rect key={index} className={styles.stripCritical} x={x - 0.5} y={0} width={1} height={MINIMAP_STRIP_H} />
          ))}
        </svg>
      )}
    </div>
  );
}
