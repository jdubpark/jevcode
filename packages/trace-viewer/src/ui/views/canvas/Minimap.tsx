import { useMemo, useRef, useSyncExternalStore } from "react";
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
import { screenToWorld, type Point, type Size } from "../../../layout/viewport.js";
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

/** A 140 × 84 SVG derived from the layout (spec §7.5 "Minimap"); pointer-only, so it is aria-hidden. */
export function Minimap(props: MinimapProps): React.JSX.Element {
  const camera = useSyncExternalStore(props.cameraStore.subscribe, props.cameraStore.get);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<Point | null>(null);
  const { layout, viewport, selectedKey, criticalKeys } = props;
  const model = useMemo(() => {
    const topLeft = screenToWorld(camera, { x: 0, y: 0 });
    const bottomRight = screenToWorld(camera, { x: viewport.w, y: viewport.h });
    return buildMinimap(layout, {
      viewportWorld: { x: topLeft.x, y: topLeft.y, w: bottomRight.x - topLeft.x, h: bottomRight.y - topLeft.y },
      selectedKey,
      criticalKeys,
    });
  }, [camera, layout, viewport.w, viewport.h, selectedKey, criticalKeys]);
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
        onPointerDown={(event) => props.onCenter(minimapToWorld(model, local(event)))}
      >
        <g transform={`scale(${model.scale}) translate(${-model.origin.x} ${-model.origin.y})`}>
          {model.edges.map((edge, index) => (
            <path key={index} className={styles.miniEdge} d={edge.d} />
          ))}
        </g>
        {model.separators.map((sep) => (
          <line key={sep.x} className={styles.miniSep} x1={sep.x} x2={sep.x} y1={0} y2={MINIMAP_H} />
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
          data-viewport=""
          className={styles.miniViewport}
          x={model.viewport.x}
          y={model.viewport.y}
          width={Math.max(2, model.viewport.w)}
          height={Math.max(2, model.viewport.h)}
          onPointerDown={(event) => {
            event.stopPropagation();
            drag.current = { x: event.clientX, y: event.clientY };
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            const from = drag.current;
            if (from === null) return;
            drag.current = { x: event.clientX, y: event.clientY };
            props.onPan((event.clientX - from.x) / model.scale, (event.clientY - from.y) / model.scale);
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
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
          {model.strip.critical.map((x) => (
            <rect key={x} className={styles.stripCritical} x={x - 0.5} y={0} width={1} height={MINIMAP_STRIP_H} />
          ))}
        </svg>
      )}
    </div>
  );
}
