import { createViewportController, fitRange, type XOnlyCamera } from "@jevcode/trace-viewer";
import { useEffect, useRef, type JSX } from "react";

import { nextFrame, results, sleep, spikeRun } from "./measure";
import styles from "./spike.module.css";
import type { SpikeScene } from "./synthetic";

const OVERVIEW_H = 288;
const LANES_TOP = 58;
const LANE_H = 28;
const PIN_PX = 22;

export function OverviewHarness({ scene }: { scene: SpikeScene }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pinsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const pinLayer = pinsRef.current;
    const ctx = canvas?.getContext("2d") ?? null;
    if (host === null || canvas === null || pinLayer === null || ctx === null) return undefined;
    const report = { frames: 0, maxDriftPx: 0, redraws: 0, dprChanges: 0 };
    results().risk5 = report;
    const pinEls = [...pinLayer.querySelectorAll<HTMLElement>("[data-pin]")];
    const painted = new Float64Array(scene.pins.length);
    let dpr = window.devicePixelRatio;
    let widthPx = host.clientWidth;
    const snap = (x: number): number => Math.round(x * dpr) / dpr;

    const paint = (camera: XOnlyCamera): void => {
      report.frames += 1;
      ctx.setTransform(canvas.width / widthPx, 0, 0, canvas.height / OVERVIEW_H, 0, 0);
      ctx.clearRect(0, 0, widthPx, OVERVIEW_H);
      const uEnd = camera.u0 + widthPx / camera.k;
      for (const mark of scene.marks) {
        if (mark.u1 < camera.u0 || mark.u0 > uEnd) continue;
        const x = snap((mark.u0 - camera.u0) * camera.k);
        ctx.fillStyle = mark.bad ? "#E5484D" : "#7C828E";
        ctx.fillRect(x, LANES_TOP + mark.lane * LANE_H + 10, Math.max(1 / dpr, (mark.u1 - mark.u0) * camera.k), 8);
      }
      scene.pins.forEach((pin, i) => {
        const x = snap((pin.u - camera.u0) * camera.k);
        painted[i] = x;
        ctx.fillStyle = "#2F6BFF";
        ctx.fillRect(x - 0.5 / dpr, LANES_TOP + pin.lane * LANE_H, 1 / dpr, LANE_H);
        const node = pinEls[i];
        if (node !== undefined) node.style.transform = `translate(${x - PIN_PX / 2}px, ${LANES_TOP + pin.lane * LANE_H + 3}px)`;
      });
    };
    const measure = (): void => {
      const left = host.getBoundingClientRect().left;
      scene.pins.forEach((_, i) => {
        const r = pinEls[i]?.getBoundingClientRect();
        if (r === undefined || r.right < left || r.left > left + widthPx) return;
        report.maxDriftPx = Math.max(report.maxDriftPx, Math.abs(r.left + r.width / 2 - left - (painted[i] ?? 0)));
      });
    };

    const fit = fitRange(0, scene.endU, widthPx, { padFraction: 0.02, limits: { minK: 1e-9, maxK: 0.4 } });
    const limits = { minK: fit.k * 0.9, maxK: 0.4 };
    const controller = createViewportController<XOnlyCamera>({
      element: host,
      initial: fit,
      limits: () => limits,
      viewport: () => ({ w: widthPx, h: OVERVIEW_H }),
      content: () => ({ x: 0, y: 0, w: scene.endU, h: OVERVIEW_H }),
      onFrame: (camera) => {
        paint(camera);
        requestAnimationFrame(measure);
      },
      isHandTool: () => false,
      reducedMotion: () => false,
    });

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const device = entry.devicePixelContentBoxSize?.[0];
        const css = entry.contentBoxSize?.[0];
        if (window.devicePixelRatio !== dpr) report.dprChanges += 1;
        dpr = window.devicePixelRatio;
        widthPx = css?.inlineSize ?? host.clientWidth;
        canvas.width = device?.inlineSize ?? Math.round(widthPx * dpr);
        canvas.height = device?.blockSize ?? Math.round(OVERVIEW_H * dpr);
        report.redraws += 1;
        paint(controller.get());
      }
    });
    try {
      observer.observe(canvas, { box: "device-pixel-content-box" });
    } catch {
      observer.observe(canvas);
    }

    spikeRun().overviewDrift = async () => {
      report.maxDriftPx = 0;
      const start = await nextFrame();
      for (;;) {
        const now = await nextFrame();
        const p = (now - start) / 2_000;
        if (p >= 1) break;
        if (p < 0.5) controller.panBy(-6, 0);
        else controller.zoomBy(p < 0.75 ? 1.03 : 1 / 1.03, { x: widthPx / 2, y: 100 });
      }
      await sleep(300);
      return { ...report };
    };

    return () => {
      observer.disconnect();
      controller.destroy();
    };
  }, [scene]);

  return (
    <div ref={hostRef} className={styles.overview}>
      <canvas ref={canvasRef} className={styles.overviewCanvas} aria-hidden="true" />
      <div ref={pinsRef}>
        {scene.pins.map((pin) => (
          <button key={pin.key} type="button" data-pin="" className={pin.bad ? `${styles.pin} ${styles.pinBad}` : styles.pin} aria-label={pin.label}>
            {pin.bad ? "!" : "·"}
          </button>
        ))}
      </div>
    </div>
  );
}
