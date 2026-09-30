import {
  createViewportController, fitBounds, isInsideInset, screenToWorld, setCenter, SETTLE_MS, worldToScreen, zoomAt,
  type FramePhase, type UniformCamera, type ViewportController,
} from "@jevcode/trace-viewer";
import { useEffect, useRef, type JSX } from "react";

import { frames as waitFrames, nextFrame, rectOf, results, roundedDrops, sleep, spikeRun } from "./measure";
import styles from "./spike.module.css";
import { COLUMN_MS, offsetLabel, PITCH, type SpikeScene } from "./synthetic";

const LIMITS = { minK: 0.1, maxK: 4 };
const INSET = 48;

function TestDotsLite({ failed }: { failed: number }): JSX.Element {
  return (
    <svg width={90} height={6} aria-hidden="true">
      {Array.from({ length: 15 }, (_, i) => (
        <circle key={i} cx={3 + i * 6} cy={3} r={i < failed ? 3 : 2} fill={i < failed ? "#E5484D" : "#2E9E6A"} />
      ))}
    </svg>
  );
}

export function CanvasHarness({ scene, settleRoundK }: { scene: SpikeScene; settleRoundK: number | null }): JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const referenceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = viewportRef.current;
    const world = worldRef.current;
    const ruler = rulerRef.current;
    const reference = referenceRef.current;
    if (el === null || world === null || ruler === null || reference === null) return undefined;
    const out = results();
    const risk1 = { events: 0, maxAnchorDriftPx: 0, maxVisualScale: 1, maxScroll: 0 };
    out.risk1 = risk1;
    const size = () => ({ w: el.clientWidth, h: el.clientHeight });
    const ticks = [...ruler.querySelectorAll<HTMLElement>("[data-col]")];
    const frameEls = [...world.querySelectorAll<HTMLElement>("[data-frame]")];
    let hand = false;
    let willChange = true;
    let focusIndex = 0;
    let pendingAnchor: { cursor: { x: number; y: number }; world: { x: number; y: number } } | null = null;
    let controller: ViewportController<UniformCamera> | null = null;

    const apply = (camera: UniformCamera, phase: FramePhase): void => {
      world.style.transform = `translate(${camera.tx}px, ${camera.ty}px) scale(${camera.k})`;
      if (phase === "settle") el.style.setProperty("--tv-inv-k", String(1 / camera.k));
      for (const tick of ticks) {
        tick.style.transform = `translateX(${camera.tx + Number(tick.dataset.col) * PITCH * camera.k}px)`;
      }
      if (pendingAnchor !== null && phase === "gesture") {
        const screen = worldToScreen(camera, pendingAnchor.world);
        risk1.maxAnchorDriftPx = Math.max(risk1.maxAnchorDriftPx, Math.hypot(screen.x - pendingAnchor.cursor.x, screen.y - pendingAnchor.cursor.y));
        pendingAnchor = null;
      }
    };

    const initial = fitBounds(scene.bounds, size(), { padding: 48, limits: LIMITS });
    // Registered before the controller so it reads the camera before the event applies.
    const onMeasureWheel = (event: WheelEvent): void => {
      risk1.events += 1;
      risk1.maxVisualScale = Math.max(risk1.maxVisualScale, window.visualViewport?.scale ?? 1);
      const page = document.scrollingElement;
      risk1.maxScroll = Math.max(risk1.maxScroll, Math.abs(el.scrollLeft) + Math.abs(el.scrollTop) + Math.abs(page?.scrollLeft ?? 0) + Math.abs(page?.scrollTop ?? 0));
      if ((event.ctrlKey || event.metaKey) && pendingAnchor === null) {
        const rect = el.getBoundingClientRect();
        const cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        pendingAnchor = { cursor, world: screenToWorld(controller?.get() ?? initial, cursor) };
      }
    };
    el.addEventListener("wheel", onMeasureWheel, { passive: true });
    const onScroll = (): void => {
      if (el.scrollLeft !== 0 || el.scrollTop !== 0) {
        el.scrollLeft = 0;
        el.scrollTop = 0;
        out.scrollResets += 1;
      }
    };
    el.addEventListener("scroll", onScroll);

    const ctl = createViewportController<UniformCamera>({
      element: el,
      initial,
      limits: () => LIMITS,
      viewport: size,
      content: () => scene.bounds,
      onFrame: apply,
      onGestureStart: () => { if (willChange) world.style.willChange = "transform"; },
      onGestureEnd: () => { world.style.willChange = ""; },
      isHandTool: () => hand,
      reducedMotion: () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      settleRoundK,
    });
    controller = ctl;
    apply(initial, "settle");

    async function reveal(index: number): Promise<void> {
      const frame = scene.frames[index];
      const node = frameEls[index];
      if (frame === undefined || node === undefined) return;
      const camera = ctl.get();
      if (!isInsideInset(camera, frame, size(), INSET)) {
        await ctl.set(setCenter(camera, { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 }, size()));
      }
      frameEls[focusIndex]?.setAttribute("tabindex", "-1");
      node.setAttribute("tabindex", "0");
      focusIndex = index;
      node.focus({ preventScroll: true });
    }

    const onKey = (event: KeyboardEvent): void => {
      if (event.code === "Space") {
        event.preventDefault();
        hand = event.type === "keydown";
        return;
      }
      if (event.type !== "keydown") return;
      if (event.code === "KeyJ" || event.code === "KeyK") {
        event.preventDefault();
        const next = Math.max(0, Math.min(scene.frames.length - 1, focusIndex + (event.code === "KeyJ" ? 1 : -1)));
        void reveal(next);
      } else if (event.code === "KeyH") {
        hand = true;
      } else if (event.code === "KeyV") {
        hand = false;
      } else if (event.code === "Digit1" && event.shiftKey) {
        void ctl.set(fitBounds(scene.bounds, size(), { padding: 48, limits: LIMITS }), { animate: true });
      } else if (event.code === "Digit2" && event.shiftKey) {
        const frame = scene.frames[focusIndex];
        if (frame !== undefined) void ctl.set(fitBounds(frame, size(), { padding: 48, limits: { minK: LIMITS.minK, maxK: 1.5 } }), { animate: true });
      }
    };
    el.addEventListener("keydown", onKey);
    el.addEventListener("keyup", onKey);

    const tickDrift = (): number => {
      let max = 0;
      for (const frame of scene.frames) {
        if (frame.story || frame.index > 40) continue;
        const tick = ticks[frame.col];
        const node = frameEls[frame.index];
        if (tick === undefined || node === undefined) continue;
        max = Math.max(max, Math.abs(tick.getBoundingClientRect().left - node.getBoundingClientRect().left));
      }
      return max;
    };

    const zoomSweep = async (ms: number, from: number, to: number, perFrame?: () => void): Promise<number[]> => {
      const v = size();
      const stamps: number[] = [];
      const start = await nextFrame();
      for (;;) {
        const now = await nextFrame();
        stamps.push(now);
        const p = Math.min(1, (now - start) / ms);
        const k = from * (to / from) ** p;
        const current = ctl.get();
        void ctl.set(zoomAt(current, { x: v.w / 2, y: v.h / 2 }, k / current.k, { minK: k, maxK: k }));
        perFrame?.();
        if (p >= 1) break;
      }
      return stamps;
    };

    const run = spikeRun();
    run.sweep = async (withWillChange) => {
      willChange = withWillChange;
      world.style.willChange = withWillChange ? "transform" : "";
      const stamps = await zoomSweep(3_000, 0.35, 2);
      world.style.willChange = "";
      willChange = true;
      return { ...roundedDrops(stamps), willChange: withWillChange };
    };
    run.settleAt = async (k) => {
      const first = scene.frames.find((frame) => !frame.story);
      if (first === undefined) throw new Error("scene has no chapter frame");
      await ctl.set(setCenter({ mode: "uniform", tx: 0, ty: 0, k }, { x: first.x + first.w / 2, y: first.y + 40 }, size()));
      ctl.panBy(0, 0);
      await sleep(SETTLE_MS + 60);
      await waitFrames(2);
      const title = frameEls[first.index]?.querySelector<HTMLElement>("[data-title]");
      if (title === null || title === undefined) throw new Error("frame title missing");
      const settledK = ctl.get().k;
      reference.textContent = first.title;
      reference.style.fontSize = `${13 * settledK}px`;
      reference.style.lineHeight = `${18 * settledK}px`;
      reference.hidden = false;
      await waitFrames(2);
      return { k: settledK, dpr: window.devicePixelRatio, frame: rectOf(title.getBoundingClientRect()), reference: rectOf(reference.getBoundingClientRect()) };
    };
    run.hideReference = async () => {
      reference.hidden = true;
      await waitFrames(1);
    };
    run.strokeCheck = async () => {
      const path = world.querySelector<SVGPathElement>("[data-edge]");
      if (path === null) return [];
      const rows: { k: number; renderedPx: number }[] = [];
      for (const k of [0.5, 0.75, 1, 1.5, 2]) {
        await run.settleAt?.(k);
        reference.hidden = true;
        const k2 = ctl.get().k;
        rows.push({ k: k2, renderedPx: Number.parseFloat(getComputedStyle(path).strokeWidth) * k2 });
      }
      return rows;
    };
    run.rulerSync = async () => {
      let max = 0;
      await zoomSweep(1_500, 0.5, 2, () => { max = Math.max(max, tickDrift()); });
      return { maxTickDriftPx: max };
    };
    run.keyboardWalk = async (presses) => {
      let failures = 0;
      await ctl.set(fitBounds(scene.bounds, size(), { padding: 48, limits: { minK: 1, maxK: 1 } }));
      focusIndex = 0;
      frameEls[0]?.focus({ preventScroll: true });
      for (let i = 0; i < presses; i += 1) {
        el.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyJ", key: "j", bubbles: true }));
        await waitFrames(3);
        const node = frameEls[focusIndex];
        const r = node?.getBoundingClientRect();
        const v = el.getBoundingClientRect();
        const inside = r !== undefined && r.left >= v.left + INSET && r.top >= v.top + INSET && r.right <= v.right - INSET && r.bottom <= v.bottom - INSET;
        if (document.activeElement !== node || !inside) failures += 1;
      }
      return { presses, failures, scrollResets: out.scrollResets };
    };

    return () => {
      el.removeEventListener("wheel", onMeasureWheel);
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("keyup", onKey);
      ctl.destroy();
    };
  }, [scene, settleRoundK]);

  return (
    <div className={styles.canvasRoot}>
      <div ref={rulerRef} className={styles.ruler} aria-hidden="true">
        {Array.from({ length: scene.columns }, (_, col) => (
          <span key={col} data-col={col} className={styles.tick}>{offsetLabel(col * COLUMN_MS)}</span>
        ))}
      </div>
      <div ref={viewportRef} className={styles.viewport} tabIndex={-1} aria-label="Spike canvas">
        <div ref={worldRef} className={styles.world}>
          <svg className={styles.edges} width={scene.bounds.w} height={scene.bounds.h} aria-hidden="true">
            {scene.edges.map((edge) => (
              <path key={edge.id} data-edge="" d={edge.d} className={edge.bad ? styles.edgeBad : styles.edge} />
            ))}
          </svg>
          {scene.frames.map((frame, i) => (
            <div
              key={frame.key}
              data-frame=""
              role="group"
              aria-label={frame.label}
              tabIndex={i === 0 ? 0 : -1}
              className={frame.story ? styles.story : styles.frame}
              style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}
            >
              <span data-title="" className={styles.title}>{frame.title}</span>
              {frame.story ? null : (
                <>
                  <TestDotsLite failed={frame.critical ? 1 : 0} />
                  <ul className={styles.rows}>
                    {frame.rows.map((row) => (
                      <li key={row}>
                        <span className={styles.dot} />
                        <span className={styles.mono}>{row}</span>
                        <span className={styles.meta}>1.2 s</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
      <div ref={referenceRef} className={styles.reference} hidden />
    </div>
  );
}
