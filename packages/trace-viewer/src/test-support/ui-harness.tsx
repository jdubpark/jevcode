// Test-only helpers for the lane C2 jsdom suites. Excluded from the build by tsconfig.build.json.
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import {
  TRACE_BUNDLE_FORMAT,
  TRACE_BUNDLE_VERSION,
  type TraceBundle,
  type TraceRow,
} from "@jevcode/contracts";

import { buildTimeScale, timeScaleInputOf } from "../layout/time-scale.js";
import { buildTraceIndex, emptyTraceIndex } from "../layout/trace-index.js";
import { compareFindings, foldRows, type TraceSession } from "../model/index.js";
import { isTerminalState, type DataStatus } from "../ui/shell/data-controller.js";
import { LiveRegion } from "../ui/shell/LiveRegion.js";
import {
  DiagnosticsContext,
  SessionContext,
  type DiagnosticsSink,
  type SessionView,
} from "../ui/shell/session-context.js";
import { createViewStore, ViewStoreContext, type ViewStore } from "../ui/state/store.js";
import { initialViewState, type ViewState } from "../ui/state/view-state.js";
import {
  createViewPortRegistry,
  ViewDefinitionsContext,
  ViewPortRegistryContext,
  type ViewDefinition,
  type ViewPortRegistry,
} from "../ui/views/view-port.js";
import { loadFixtureTrace, type FixtureName, type FixtureTrace } from "./fixture-rows.js";

const traces = new Map<FixtureName, FixtureTrace>();
const folds = new Map<FixtureName, TraceSession>();

export function fixtureTrace(name: FixtureName): FixtureTrace {
  let trace = traces.get(name);
  if (trace === undefined) {
    trace = loadFixtureTrace(name);
    traces.set(name, trace);
  }
  return trace;
}

export function foldFixture(name: FixtureName): TraceSession {
  let session = folds.get(name);
  if (session === undefined) {
    const { meta, rows } = fixtureTrace(name);
    session = foldRows(meta, rows, { live: false });
    folds.set(name, session);
  }
  return session;
}

export function fixtureBundle(name: FixtureName): TraceBundle {
  const { meta, rows } = fixtureTrace(name);
  return {
    format: TRACE_BUNDLE_FORMAT,
    version: TRACE_BUNDLE_VERSION,
    exportedAt: "2026-09-28T00:00:00.000Z",
    redactionCount: 0,
    session: meta,
    rows,
  };
}

export function payloadOf(row: TraceRow): Record<string, unknown> {
  return row.payload !== null && typeof row.payload === "object" ? (row.payload as Record<string, unknown>) : {};
}

export interface LayoutStub {
  restore(): void;
  scrollCalls: Array<{ top?: number; left?: number }>;
}

/**
 * Per-test layout for jsdom (conventions 4): elements marked data-scroll-root or data-measure-root
 * measure width × height, every other element width × rowHeight. Call inside a test or beforeEach;
 * call restore() in afterEach. Installs nothing globally beyond that window.
 */
export function stubLayout(options: { width?: number; height?: number; rowHeight?: number } = {}): LayoutStub {
  const width = options.width ?? 1000;
  const height = options.height ?? 600;
  const rowHeight = options.rowHeight ?? 32;
  const sizeOf = (element: Element): { w: number; h: number } =>
    element.hasAttribute("data-scroll-root") || element.hasAttribute("data-measure-root")
      ? { w: width, h: height }
      : { w: width, h: rowHeight };

  const proto = Element.prototype;
  const originalRect = proto.getBoundingClientRect;
  const originalScrollTo = proto.scrollTo;
  const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  const originalObserver = globalThis.ResizeObserver;
  const scrollCalls: Array<{ top?: number; left?: number }> = [];

  proto.getBoundingClientRect = function getBoundingClientRect(this: Element): DOMRect {
    const { w, h } = sizeOf(this);
    return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h, toJSON: () => ({}) } as DOMRect;
  };
  proto.scrollTo = function scrollTo(this: Element, arg?: ScrollToOptions | number, y?: number): void {
    const target = typeof arg === "object" ? arg : { left: arg, top: y };
    scrollCalls.push({ top: target.top, left: target.left });
    if (target.top !== undefined) this.scrollTop = target.top;
  } as Element["scrollTo"];
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return sizeOf(this).w;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return sizeOf(this).h;
    },
  });
  class StubResizeObserver {
    private readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element): void {
      const { w, h } = sizeOf(target);
      const box = [{ inlineSize: w, blockSize: h }];
      const entry = {
        target,
        contentRect: target.getBoundingClientRect(),
        borderBoxSize: box,
        contentBoxSize: box,
        devicePixelContentBoxSize: box,
      } as unknown as ResizeObserverEntry;
      queueMicrotask(() => this.callback([entry], this as unknown as ResizeObserver));
    }
    unobserve(): void {
      return undefined;
    }
    disconnect(): void {
      return undefined;
    }
  }
  globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;

  return {
    scrollCalls,
    restore() {
      proto.getBoundingClientRect = originalRect;
      proto.scrollTo = originalScrollTo;
      if (offsetWidth !== undefined) Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetWidth);
      if (offsetHeight !== undefined) Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeight);
      globalThis.ResizeObserver = originalObserver;
    },
  };
}

export interface HarnessOptions {
  state?: Partial<ViewState>;
  status?: DataStatus;
  loadedFraction?: number;
  terminal?: boolean;
  nowT?: number;
  payloads?(seqs: readonly number[]): Promise<TraceRow[]>;
  views?: readonly ViewDefinition[];
  diagnostics?: DiagnosticsSink;
}

export interface Harness {
  store: ViewStore;
  registry: ViewPortRegistry;
  view: SessionView;
  announcements: string[];
  retries: { count: number };
  wrap(node: ReactNode): ReactElement;
}

const NO_DIAGNOSTICS: DiagnosticsSink = {
  enabled: false,
  reportDrift: () => undefined,
  reportError: () => undefined,
  flush: () => undefined,
};

export function createHarness(session: TraceSession | null, options: HarnessOptions = {}): Harness {
  const index = session === null ? emptyTraceIndex("sess-test") : buildTraceIndex(session);
  const scale = buildTimeScale(
    session === null ? { originMs: 0, work: [], awaitingFrom: [] } : timeScaleInputOf(session),
  );
  const store = createViewStore({ ...initialViewState({ live: false }), ...options.state }, index);
  const registry = createViewPortRegistry();
  const announcements: string[] = [];
  const retries = { count: 0 };
  const view: SessionView = {
    summary: session?.meta ?? null,
    session,
    index,
    scale,
    status: options.status ?? { kind: "ready" },
    loadedFraction: options.loadedFraction ?? 1,
    terminal: options.terminal ?? (session !== null && isTerminalState(session.meta.state)),
    nowT: () => options.nowT ?? 0,
    payloads: options.payloads ?? (async () => []),
    retry: () => {
      retries.count += 1;
    },
  };
  const wrap = (node: ReactNode): ReactElement => (
    <ViewStoreContext.Provider value={store}>
      <SessionContext.Provider value={view}>
        <DiagnosticsContext.Provider value={options.diagnostics ?? NO_DIAGNOSTICS}>
          <ViewPortRegistryContext.Provider value={registry}>
            <ViewDefinitionsContext.Provider value={options.views ?? []}>
              <LiveRegion onAnnounce={(message) => announcements.push(message)}>{node}</LiveRegion>
            </ViewDefinitionsContext.Provider>
          </ViewPortRegistryContext.Provider>
        </DiagnosticsContext.Provider>
      </SessionContext.Provider>
    </ViewStoreContext.Provider>
  );
  return { store, registry, view, announcements, retries, wrap };
}

export function renderHarness(
  node: ReactNode,
  session: TraceSession | null,
  options: HarnessOptions = {},
): Harness & { result: RenderResult } {
  const harness = createHarness(session, options);
  const result = render(harness.wrap(node));
  return { ...harness, result };
}

/** Dispatches the first complete session/applied the way the Shell does (spec §7.8 "Defaults on open"). */
export function applyOpenDefaults(harness: Harness, session: TraceSession): void {
  const top = [...session.findings].sort(compareFindings)[0];
  harness.store.dispatch({
    type: "session/applied",
    loadedThroughSeq: session.loadedThroughSeq,
    terminal: isTerminalState(session.meta.state),
    loadComplete: true,
    initialSelection: top?.anchorStepId ?? session.steps.at(-1)?.id ?? null,
    chapterSpineRows: 0,
  });
}
