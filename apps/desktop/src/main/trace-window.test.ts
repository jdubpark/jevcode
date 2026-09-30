import type { BrowserWindowConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  TRACE_WINDOW_BACKGROUND,
  TRACE_WINDOW_MIN_WIDTH,
  createTraceWindowRegistry,
  sharedWebPreferences,
  traceWindowOptions,
} from "./trace-window.js";
import type { TraceWindowHandle, TraceWindowRegistry } from "./trace-window.js";

const PRELOAD = "/app/dist/preload/index.cjs";
const TRACE_HTML = "/app/dist/renderer/src/renderer/trace.html";

type Listener = (...args: unknown[]) => void;

class FakeEmitter {
  private readonly listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  once(event: string, listener: Listener): this {
    const wrapped: Listener = (...args) => {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((entry) => entry !== wrapped),
      );
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }
}

class FakeWebContents extends FakeEmitter {
  openHandler: ((details: unknown) => { action: string }) | null = null;

  constructor(readonly id: number) {
    super();
  }

  setWindowOpenHandler(handler: (details: unknown) => { action: string }): void {
    this.openHandler = handler;
  }
}

class FakeWindow extends FakeEmitter {
  readonly calls: string[] = [];
  readonly webContents: FakeWebContents;
  minimized = false;
  destroyed = false;
  loaded: { file: string; options: unknown; senderRecorded: boolean } | null = null;

  constructor(
    id: number,
    private readonly registry: () => TraceWindowRegistry,
  ) {
    super();
    this.webContents = new FakeWebContents(id);
  }

  async loadFile(file: string, options?: unknown): Promise<void> {
    this.calls.push("loadFile");
    this.loaded = {
      file,
      options,
      senderRecorded: this.registry().isTraceSender(this.webContents.id),
    };
  }

  show(): void {
    this.calls.push("show");
  }

  focus(): void {
    this.calls.push("focus");
  }

  restore(): void {
    this.calls.push("restore");
    this.minimized = false;
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  close(): void {
    this.calls.push("close");
    this.destroyed = true;
    this.emit("closed");
  }
}

function setup(): {
  registry: TraceWindowRegistry;
  created: FakeWindow[];
  options: BrowserWindowConstructorOptions[];
} {
  const created: FakeWindow[] = [];
  const options: BrowserWindowConstructorOptions[] = [];
  let nextId = 100;
  const holder: { registry?: TraceWindowRegistry } = {};
  const current = (): TraceWindowRegistry => {
    if (holder.registry === undefined) throw new Error("registry not ready");
    return holder.registry;
  };
  const registry = createTraceWindowRegistry({
    create: (windowOptions) => {
      options.push(windowOptions);
      const window = new FakeWindow(nextId, current);
      nextId += 1;
      created.push(window);
      return window as unknown as TraceWindowHandle;
    },
    preloadPath: PRELOAD,
    traceHtmlPath: TRACE_HTML,
  });
  holder.registry = registry;
  return { registry, created, options };
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`missing item ${index}`);
  return item;
}

describe("trace window registry", () => {
  it("builds a light, sandboxed trace window with the main window's webPreferences", () => {
    expect(TRACE_WINDOW_MIN_WIDTH).toBe(1000);
    expect(TRACE_WINDOW_BACKGROUND).toBe("#FFFFFF");
    expect(sharedWebPreferences(PRELOAD)).toEqual({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: PRELOAD,
    });
    expect(traceWindowOptions(PRELOAD)).toEqual({
      width: 1440,
      height: 900,
      minWidth: 1000,
      backgroundColor: "#FFFFFF",
      show: false,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        preload: PRELOAD,
      },
    });
  });

  it("records the sender before loading trace.html with the session query", () => {
    const { registry, created, options } = setup();
    registry.openTraceWindow("sess_1");
    expect(created).toHaveLength(1);
    expect(at(options, 0)).toEqual(traceWindowOptions(PRELOAD));
    expect(at(created, 0).loaded).toEqual({
      file: TRACE_HTML,
      options: { query: { session: "sess_1" } },
      senderRecorded: true,
    });
    expect(registry.isTraceSender(100)).toBe(true);
    expect(registry.isTraceSender(1)).toBe(false);
  });

  it("shows the window only when it is ready to show", () => {
    const { registry, created } = setup();
    registry.openTraceWindow("sess_1");
    const window = at(created, 0);
    expect(window.calls).toEqual(["loadFile"]);
    window.emit("ready-to-show");
    expect(window.calls).toEqual(["loadFile", "show"]);
  });

  it("a second open restores and focuses the same window", () => {
    const { registry, created } = setup();
    const first = registry.openTraceWindow("sess_1");
    const window = at(created, 0);
    window.minimized = true;
    const second = registry.openTraceWindow("sess_1");
    expect(second).toBe(first);
    expect(created).toHaveLength(1);
    expect(window.calls).toEqual(["loadFile", "restore", "show", "focus"]);
    expect(registry.count()).toBe(1);
  });

  it("keeps one window per session", () => {
    const { registry, created } = setup();
    registry.openTraceWindow("sess_1");
    registry.openTraceWindow("sess_2");
    expect(created).toHaveLength(2);
    expect(registry.count()).toBe(2);
    expect(registry.isTraceSender(100)).toBe(true);
    expect(registry.isTraceSender(101)).toBe(true);
  });

  it("blocks navigation and denies window.open", () => {
    const { registry, created } = setup();
    registry.openTraceWindow("sess_1");
    const window = at(created, 0);
    const preventDefault = vi.fn();
    window.webContents.emit("will-navigate", { preventDefault }, "https://example.com/");
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(window.webContents.openHandler?.({ url: "https://example.com/" })).toEqual({
      action: "deny",
    });
  });

  it("a closed window stops being a trace sender and can be reopened", () => {
    const { registry, created } = setup();
    registry.openTraceWindow("sess_1");
    at(created, 0).close();
    expect(registry.count()).toBe(0);
    expect(registry.isTraceSender(100)).toBe(false);
    registry.openTraceWindow("sess_1");
    expect(created).toHaveLength(2);
    expect(registry.isTraceSender(101)).toBe(true);
  });

  it("closeAll closes every open trace window", () => {
    const { registry, created } = setup();
    registry.openTraceWindow("sess_1");
    registry.openTraceWindow("sess_2");
    registry.closeAll();
    expect(created.map((window) => window.calls.includes("close"))).toEqual([true, true]);
    expect(registry.count()).toBe(0);
    expect(registry.isTraceSender(100)).toBe(false);
  });
});
