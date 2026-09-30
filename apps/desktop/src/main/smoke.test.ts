import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SMOKE_MAIN_TIMEOUT_MS,
  SMOKE_SETTLE_MS,
  SMOKE_TRACE_TIMEOUT_MS,
  forwardTracePerf,
  isConsoleFailure,
  parseTraceLine,
  runSmoke,
} from "./smoke.js";
import type { SmokeDeps } from "./smoke.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'";
const EVAL_VIOLATION =
  "Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive: \"script-src 'self'\".";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fake serves listeners of several signatures
type Listener = (...args: any[]) => void;

class FakeWebContents {
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

  console(level: number, message: string): void {
    this.emit("console-message", {}, level, message, 1, "file:///app/trace.js");
  }
}

class FakeScheduler {
  private time = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  readonly now = (): number => this.time;

  readonly setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.time + ms, fn });
    return id;
  };

  readonly clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  advance(ms: number): void {
    const until = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.time = due[1].at;
      due[1].fn();
    }
    this.time = until;
  }
}

function harness(env: Record<string, string | undefined>, newest: string | null = "sess_new") {
  const scheduler = new FakeScheduler();
  const main = new FakeWebContents();
  const trace = new FakeWebContents();
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  const result = { succeeded: 0, failed: 0 };
  const deps: SmokeDeps = {
    mainWindow: { webContents: main },
    env,
    newestSessionId: () => newest,
    openTraceWindow: (sessionId) => {
      opened.push(sessionId);
      return { webContents: trace };
    },
    now: scheduler.now,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    log: (line) => out.push(line),
    error: (line) => err.push(line),
    succeed: () => {
      result.succeeded += 1;
    },
    fail: () => {
      result.failed += 1;
    },
  };
  runSmoke(deps);
  return { scheduler, main, trace, out, err, opened, result };
}

const TRACE_ENV = { JEVCODE_SMOKE_TRACE: "1", JEVCODE_DB: "/tmp/replay.db" };

describe("runSmoke, main phase", () => {
  it("passes when the main window loads and the trace phase is off", () => {
    const run = harness({});
    run.main.emit("did-finish-load");
    expect(run.out).toEqual(["SMOKE_OK"]);
    expect(run.result).toEqual({ succeeded: 1, failed: 0 });
    expect(run.opened).toEqual([]);
  });

  it("fails on a CSP violation in the main window", () => {
    const run = harness({});
    run.main.console(3, EVAL_VIOLATION);
    run.main.emit("did-finish-load");
    expect(run.err).toHaveLength(1);
    expect(run.err[0]).toMatch(/^SMOKE_FAIL: console error in main window: Refused to evaluate/);
    expect(run.result).toEqual({ succeeded: 0, failed: 1 });
  });

  it("times out when the main window never loads", () => {
    const run = harness({});
    run.scheduler.advance(SMOKE_MAIN_TIMEOUT_MS);
    expect(run.err).toEqual(["SMOKE_FAIL: renderer did not finish loading within 15s"]);
    expect(run.result.failed).toBe(1);
  });

  it("JEVCODE_SMOKE_TRACE=1 without JEVCODE_DB fails instead of skipping", () => {
    const run = harness({ JEVCODE_SMOKE_TRACE: "1" });
    run.main.emit("did-finish-load");
    expect(run.err[0]).toMatch(/^SMOKE_FAIL: JEVCODE_SMOKE_TRACE=1 needs JEVCODE_DB/);
    expect(run.opened).toEqual([]);
  });

  it("fails when the database holds no session", () => {
    const run = harness(TRACE_ENV, null);
    run.main.emit("did-finish-load");
    expect(run.err).toEqual(["SMOKE_FAIL: no session in /tmp/replay.db"]);
  });
});

describe("runSmoke, trace phase", () => {
  it("opens the newest session and passes on TRACE_READY then TRACE_LOADED", () => {
    const run = harness(TRACE_ENV);
    run.main.emit("did-finish-load");
    expect(run.opened).toEqual(["sess_new"]);
    run.scheduler.advance(120);
    run.trace.console(1, "TRACE_READY 48");
    run.scheduler.advance(300);
    run.trace.console(1, "TRACE_LOADED 402");
    expect(run.result.succeeded).toBe(0);
    run.scheduler.advance(SMOKE_SETTLE_MS);
    expect(run.out).toEqual([
      "SMOKE_TRACE session=sess_new rows=48 first_paint_ms=120 full_load_ms=420",
      "SMOKE_OK",
    ]);
    expect(run.result).toEqual({ succeeded: 1, failed: 0 });
  });

  it("fails on a console error in the trace window", () => {
    const run = harness(TRACE_ENV);
    run.main.emit("did-finish-load");
    run.trace.console(3, "Uncaught TypeError: Cannot read properties of undefined");
    expect(run.err[0]).toMatch(/^SMOKE_FAIL: console error in trace window: Uncaught TypeError/);
    expect(run.result.failed).toBe(1);
  });

  it("a late CSP violation during the settle window still fails", () => {
    const run = harness(TRACE_ENV);
    run.main.emit("did-finish-load");
    run.trace.console(1, "TRACE_READY 48");
    run.trace.console(1, "TRACE_LOADED 402");
    run.trace.console(3, "CSP_VIOLATION img-src data:");
    run.scheduler.advance(SMOKE_SETTLE_MS);
    expect(run.err[0]).toMatch(/^SMOKE_FAIL: console error in trace window: CSP_VIOLATION/);
    expect(run.result).toEqual({ succeeded: 0, failed: 1 });
  });

  it("fails when the trace window never reports TRACE_LOADED", () => {
    const run = harness(TRACE_ENV);
    run.main.emit("did-finish-load");
    run.trace.console(1, "TRACE_READY 48");
    run.scheduler.advance(SMOKE_TRACE_TIMEOUT_MS);
    expect(run.err).toEqual(["SMOKE_FAIL: trace window did not report TRACE_LOADED within 30s"]);
  });

  it("names TRACE_READY when the window never reports it", () => {
    const run = harness(TRACE_ENV);
    run.main.emit("did-finish-load");
    run.scheduler.advance(SMOKE_TRACE_TIMEOUT_MS);
    expect(run.err).toEqual(["SMOKE_FAIL: trace window did not report TRACE_READY within 30s"]);
  });

  it("strips control characters from page text in a failure reason", () => {
    const run = harness(TRACE_ENV);
    run.main.emit("did-finish-load");
    run.trace.console(3, "Uncaught Error: boom\nSMOKE_OK\r\u2028SMOKE_OK\u2029\u0007");
    expect(run.err).toHaveLength(1);
    expect(run.err[0]).toBe("SMOKE_FAIL: console error in trace window: Uncaught Error: boomSMOKE_OKSMOKE_OK");
    expect(run.out).toEqual([]);
  });

  it("prints SMOKE_TRACE once and keeps the first settle timer on a duplicate TRACE_LOADED", () => {
    const run = harness(TRACE_ENV);
    run.main.emit("did-finish-load");
    run.trace.console(1, "TRACE_READY 48");
    run.trace.console(1, "TRACE_LOADED 402");
    run.scheduler.advance(SMOKE_SETTLE_MS - 100);
    run.trace.console(1, "TRACE_LOADED 402");
    run.scheduler.advance(100);
    expect(run.out.filter((line) => line.startsWith("SMOKE_TRACE"))).toHaveLength(1);
    expect(run.result.succeeded).toBe(1);
  });

  it("fails when the trace window reports zero rows", () => {
    const run = harness(TRACE_ENV);
    run.main.emit("did-finish-load");
    run.trace.console(1, "TRACE_READY 0");
    expect(run.err).toEqual(["SMOKE_FAIL: trace window reported TRACE_READY 0 (no rows)"]);
    expect(run.result).toEqual({ succeeded: 0, failed: 1 });
  });

  it("fails when TRACE_LOADED arrives before TRACE_READY", () => {
    const run = harness(TRACE_ENV);
    run.main.emit("did-finish-load");
    run.trace.console(1, "TRACE_LOADED 402");
    expect(run.err).toEqual(["SMOKE_FAIL: TRACE_LOADED arrived before TRACE_READY"]);
  });

  it("fails when the trace renderer is gone or the page fails to load", () => {
    const gone = harness(TRACE_ENV);
    gone.main.emit("did-finish-load");
    gone.trace.emit("render-process-gone", {}, { reason: "crashed" });
    expect(gone.err).toEqual(["SMOKE_FAIL: trace renderer gone (crashed)"]);
    const missing = harness(TRACE_ENV);
    missing.main.emit("did-finish-load");
    missing.trace.emit("did-fail-load", {}, -6, "ERR_FILE_NOT_FOUND");
    expect(missing.err).toEqual(["SMOKE_FAIL: trace window failed to load (-6 ERR_FILE_NOT_FOUND)"]);
  });
});

describe("smoke helpers", () => {
  it("counts errors and CSP reports, not warnings", () => {
    expect(isConsoleFailure(3, "anything")).toBe(true);
    expect(isConsoleFailure(2, "Download the React DevTools for a better development experience")).toBe(false);
    expect(isConsoleFailure(1, "CSP_VIOLATION script-src blob:")).toBe(true);
    expect(isConsoleFailure(2, "[Report Only] Refused to load … Content Security Policy directive")).toBe(true);
  });

  it("parses the trace window's console lines", () => {
    expect(parseTraceLine("TRACE_READY 48")).toEqual({ kind: "ready", rows: 48 });
    expect(parseTraceLine("TRACE_LOADED 402")).toEqual({ kind: "loaded" });
    expect(parseTraceLine("TRACE_PERF tv:live-tick 3.46")).toEqual({ kind: "perf", name: "tv:live-tick", ms: 3.46 });
    expect(parseTraceLine("TRACE_READY")).toBeNull();
    expect(parseTraceLine("[pipeline] TRACE_READY 1")).toBeNull();
  });

  it("forwardTracePerf prints only TRACE_PERF lines", () => {
    const contents = new FakeWebContents();
    const lines: string[] = [];
    forwardTracePerf({ webContents: contents }, (line) => lines.push(line));
    contents.console(1, "TRACE_READY 48");
    contents.console(1, "TRACE_PERF tv:live-tick 3.46");
    expect(lines).toEqual(["TRACE_PERF tv:live-tick 3.46"]);
  });
});

describe("trace.html", () => {
  it("carries index.html's CSP and loads only its own entry", () => {
    const cspOf = (html: string): string | undefined =>
      /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1];
    const index = readFileSync(path.join(dirname, "../renderer/index.html"), "utf8");
    const trace = readFileSync(path.join(dirname, "../renderer/trace.html"), "utf8");
    expect(cspOf(index)).toBe(CSP);
    expect(cspOf(trace)).toBe(CSP);
    expect(trace).toContain('<script type="module" src="./trace/main.tsx"></script>');
    const entry = readFileSync(path.join(dirname, "../renderer/trace/main.tsx"), "utf8");
    expect(entry).not.toMatch(/styles\.css/);
    expect(entry).not.toMatch(/dangerouslySetInnerHTML/);
  });
});
