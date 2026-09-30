import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";

import { buildTimeScale, timeScaleInputOf } from "../layout/time-scale.js";
import { buildTraceIndex, emptyTraceIndex } from "../layout/trace-index.js";
import type { TraceSession } from "../model/index.js";
import { SessionContext, type SessionView } from "../ui/shell/session-context.js";
import { ViewStoreContext, createViewStore, type ViewStore } from "../ui/state/store.js";
import { initialViewState, type ViewState } from "../ui/state/view-state.js";
import { ViewPortRegistryContext, createViewPortRegistry, type ViewPortRegistry } from "../ui/views/view-port.js";

// Providers and per-test stubs for Canvas view tests. Every stub is installed by the test that calls it
// and removed by that file's afterEach (vi.restoreAllMocks, vi.unstubAllGlobals); nothing here is global.

export function sessionViewOf(session: TraceSession | null, sessionId = session?.meta.sessionId ?? "sess-canvas"): SessionView {
  const index = session === null ? emptyTraceIndex(sessionId) : buildTraceIndex(session);
  const scale = buildTimeScale(session === null ? { originMs: 0, work: [], awaitingFrom: [] } : timeScaleInputOf(session));
  const lastT = session?.steps.at(-1)?.tMs ?? 0;
  return {
    summary: session?.meta ?? null,
    session,
    index,
    scale,
    status: session === null ? { kind: "loading" } : { kind: "ready" },
    loadedFraction: session === null ? 0 : 1,
    terminal: session !== null && !session.live,
    nowT: () => lastT,
    payloads: async () => [],
    retry: () => undefined,
  };
}

export interface ViewerHarness {
  store: ViewStore;
  registry: ViewPortRegistry;
  result: RenderResult;
  setSession(session: TraceSession | null): void;
}

export function renderWithViewer(
  ui: ReactElement,
  options: { session: TraceSession | null; state?: Partial<ViewState> },
): ViewerHarness {
  let view = sessionViewOf(options.session);
  const store = createViewStore(
    { ...initialViewState({ live: options.session?.live ?? false }), ...options.state },
    view.index,
  );
  const registry = createViewPortRegistry();
  const tree = (value: SessionView): ReactElement => (
    <ViewStoreContext.Provider value={store}>
      <ViewPortRegistryContext.Provider value={registry}>
        <SessionContext.Provider value={value}>{ui}</SessionContext.Provider>
      </ViewPortRegistryContext.Provider>
    </ViewStoreContext.Provider>
  );
  const result = render(tree(view));
  return {
    store,
    registry,
    result,
    setSession(session) {
      view = sessionViewOf(session);
      store.setIndex(view.index);
      result.rerender(tree(view));
    },
  };
}

export function stubElementBox(width: number, height: number): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () =>
      ({ x: 0, y: 0, left: 0, top: 0, width, height, right: width, bottom: height, toJSON: () => ({}) }) as DOMRect,
  );
}

export interface ResizeObserverStub {
  resize(width: number, height: number): void;
  count(): number;
}

interface ObserverEntry {
  callback: ResizeObserverCallback;
  targets: Set<Element>;
  observer: ResizeObserver;
}

export function stubResizeObserver(): ResizeObserverStub {
  const live = new Set<ObserverEntry>();
  class FakeResizeObserver implements ResizeObserver {
    private readonly entry: ObserverEntry;

    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, targets: new Set(), observer: this };
    }

    observe(target: Element): void {
      this.entry.targets.add(target);
      live.add(this.entry);
    }

    unobserve(target: Element): void {
      this.entry.targets.delete(target);
    }

    disconnect(): void {
      this.entry.targets.clear();
      live.delete(this.entry);
    }
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  return {
    resize(width, height) {
      for (const entry of [...live]) {
        const records = [...entry.targets].map(
          (target) =>
            ({
              target,
              contentRect: { x: 0, y: 0, left: 0, top: 0, width, height, right: width, bottom: height, toJSON: () => ({}) },
              borderBoxSize: [],
              contentBoxSize: [],
              devicePixelContentBoxSize: [],
            }) as unknown as ResizeObserverEntry,
        );
        entry.callback(records, entry.observer);
      }
    },
    count: () => live.size,
  };
}

export interface FrameStub {
  /** Runs queued animation frames (and the frames they queue) until none remain. */
  flush(): void;
  /** requestAnimationFrame calls since the stub was installed. */
  calls(): number;
}

export function stubAnimationFrames(): FrameStub {
  const queue = new Map<number, FrameRequestCallback>();
  let next = 1;
  let calls = 0;
  let now = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback): number => {
    calls += 1;
    const id = next;
    next += 1;
    queue.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number): void => {
    queue.delete(id);
  });
  return {
    flush() {
      for (let round = 0; round < 60 && queue.size > 0; round += 1) {
        now += 16;
        const batch = [...queue.values()];
        queue.clear();
        for (const callback of batch) callback(now);
      }
    },
    calls: () => calls,
  };
}

export function stubReducedMotion(reduce: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

export function canvasViewport(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-tv-viewport="canvas"]');
  if (element === null) throw new Error("no canvas viewport in the document");
  return element;
}

export function cameraVars(element: HTMLElement): { tx: string; ty: string; k: string } {
  return {
    tx: element.style.getPropertyValue("--tv-tx"),
    ty: element.style.getPropertyValue("--tv-ty"),
    k: element.style.getPropertyValue("--tv-k"),
  };
}
