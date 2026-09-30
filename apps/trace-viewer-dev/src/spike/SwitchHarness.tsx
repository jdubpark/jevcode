import { createViewportController, fitRange, type XOnlyCamera } from "@jevcode/trace-viewer";
import { Activity, useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";

import { frames, nextFrame, sleep, spikeRun } from "./measure";
import styles from "./spike.module.css";
import type { SpikeScene } from "./synthetic";

type ViewId = "a" | "b";
const store = { selection: "step:12", playhead: 12, brush: [5, 40] as [number, number] };
const hiddenCallbacks: Record<ViewId, number> = { a: 0, b: 0 };
const saved: Partial<Record<ViewId, { u0: number; k: number }>> = {};
let zeroFits = 0;
let visible: ViewId = "a";

function DummyView({ id, scene, rows }: { id: ViewId; scene: SpikeScene; rows: number }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return undefined;
    const rect = el.getBoundingClientRect();
    let camera = saved[id];
    if (camera === undefined) {
      if (rect.width === 0 || rect.height === 0) {
        zeroFits += 1;
        return undefined;
      }
      const fit = fitRange(0, scene.endU, rect.width, { padFraction: 0.02, limits: { minK: 1e-9, maxK: 0.4 } });
      camera = { u0: fit.u0, k: fit.k };
    }
    const place = (c: { u0: number; k: number }): void => {
      if (markerRef.current !== null) markerRef.current.style.transform = `translateX(${(scene.endU / 2 - c.u0) * c.k}px)`;
    };
    const controller = createViewportController<XOnlyCamera>({
      element: el,
      initial: { mode: "xOnly", ...camera },
      limits: () => ({ minK: 1e-9, maxK: 0.4 }),
      viewport: () => ({ w: el.clientWidth, h: el.clientHeight }),
      content: () => ({ x: 0, y: 0, w: scene.endU, h: 1 }),
      onFrame: (c) => {
        saved[id] = { u0: c.u0, k: c.k };
        place(c);
      },
      isHandTool: () => false,
      reducedMotion: () => false,
    });
    saved[id] = camera;
    place(camera);
    let handle = 0;
    const loop = (): void => {
      if (visible !== id) hiddenCallbacks[id] += 1;
      handle = requestAnimationFrame(loop);
    };
    handle = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(handle);
      const last = controller.get();
      saved[id] = { u0: last.u0, k: last.k };
      controller.destroy();
    };
  }, [id, scene]);
  return (
    <div ref={ref} className={styles.dummy} data-view={id}>
      <div ref={markerRef} className={styles.marker} />
      <span className={styles.meta}>{`View ${id.toUpperCase()} · ${rows} rows`}</span>
    </div>
  );
}

export function SwitchHarness({ scene }: { scene: SpikeScene }): JSX.Element {
  const [view, setView] = useState<ViewId>("a");
  const [rows, setRows] = useState(0);
  visible = view;
  const setViewRef = useRef(setView);
  setViewRef.current = setView;

  useEffect(() => {
    const drip = window.setInterval(() => setRows((n) => n + 1), 1_000);
    spikeRun().switchCheck = async () => {
      const before = JSON.stringify(store);
      hiddenCallbacks.a = 0;
      hiddenCallbacks.b = 0;
      let maxCenterDriftPx = 0;
      for (let i = 0; i < 10; i += 1) {
        const id = visible;
        const other: ViewId = id === "a" ? "b" : "a";
        const el = document.querySelector<HTMLElement>(`[data-view="${id}"]`);
        if (el === null) throw new Error(`view ${id} missing`);
        for (let j = 0; j < 5; j += 1) {
          el.dispatchEvent(new WheelEvent("wheel", { deltaY: -4, ctrlKey: true, clientX: 300, clientY: 80, bubbles: true, cancelable: true }));
        }
        await nextFrame();
        const width = el.clientWidth;
        const cam = saved[id];
        if (cam === undefined) throw new Error("no saved camera");
        const centerU = cam.u0 + width / 2 / cam.k;
        setViewRef.current(other);
        await frames(3);
        setViewRef.current(id);
        await frames(3);
        const back = saved[id];
        if (back === undefined) throw new Error("camera lost");
        maxCenterDriftPx = Math.max(maxCenterDriftPx, Math.abs(back.u0 + width / 2 / back.k - centerU) * back.k);
        await sleep(i % 3 === 0 ? 1_100 : 50);
      }
      return {
        toggles: 10,
        storeEqual: before === JSON.stringify(store),
        maxCenterDriftPx,
        hiddenRafCallbacks: hiddenCallbacks.a + hiddenCallbacks.b,
        zeroFits,
      };
    };
    return () => window.clearInterval(drip);
  }, []);

  return (
    <div className={styles.switch}>
      <div className={styles.bar}>
        <button type="button" aria-pressed={view === "a"} onClick={() => setView("a")}>View A</button>
        <button type="button" aria-pressed={view === "b"} onClick={() => setView("b")}>View B</button>
      </div>
      <div>
        <Activity mode={view === "a" ? "visible" : "hidden"}><DummyView id="a" scene={scene} rows={rows} /></Activity>
        <Activity mode={view === "b" ? "visible" : "hidden"}><DummyView id="b" scene={scene} rows={rows} /></Activity>
      </div>
    </div>
  );
}
