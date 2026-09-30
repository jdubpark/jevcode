/**
 * JEVCODE_SMOKE=1 boot check (docs/demo.md). Main phase: the main window
 * loads. Trace phase (JEVCODE_SMOKE_TRACE=1 with JEVCODE_DB): the newest
 * session opens in a trace window, which must log TRACE_READY and then
 * TRACE_LOADED. A console error or CSP violation in either window fails the
 * run (spec §8.7). Electron is reached only through SmokeDeps, so vitest
 * drives every path with fakes.
 */

export interface SmokeWebContents {
  on(
    event: "console-message",
    listener: (event: unknown, level: number, message: string) => void,
  ): unknown;
  on(
    event: "did-fail-load",
    listener: (event: unknown, errorCode: number, errorDescription: string) => void,
  ): unknown;
  on(
    event: "render-process-gone",
    listener: (event: unknown, details: { reason: string }) => void,
  ): unknown;
}

export interface SmokeMainWebContents extends SmokeWebContents {
  once(event: "did-finish-load", listener: () => void): unknown;
}

export interface SmokeDeps {
  mainWindow: { webContents: SmokeMainWebContents };
  env: Readonly<Record<string, string | undefined>>;
  /** traceService.listSessions({ limit: 1 })[0]?.sessionId: newest first. */
  newestSessionId(): string | null;
  openTraceWindow(sessionId: string): { webContents: SmokeWebContents };
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  log(line: string): void;
  error(line: string): void;
  /** app.quit() */
  succeed(): void;
  /** app.exit(1) */
  fail(): void;
}

export const SMOKE_MAIN_TIMEOUT_MS = 15_000;
export const SMOKE_TRACE_TIMEOUT_MS = 30_000;
/** Errors that arrive just after the last page (a late chunk, a CSP report) still fail the run. */
export const SMOKE_SETTLE_MS = 500;

const CONSOLE_ERROR_LEVEL = 3;
const CSP_PATTERN = /Content[- ]Security[- ]Policy|CSP_VIOLATION/i;

/** Electron 33 console levels: 0 verbose, 1 info, 2 warning, 3 error. */
export function isConsoleFailure(level: number, message: string): boolean {
  return level >= CONSOLE_ERROR_LEVEL || CSP_PATTERN.test(message);
}

/** C0/C1 controls plus U+2028/U+2029: a page-supplied line must not forge a SMOKE_ line. */
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

export type TraceLine =
  | { kind: "ready"; rows: number }
  | { kind: "loaded" }
  | { kind: "perf"; name: string; ms: number };

export function parseTraceLine(message: string): TraceLine | null {
  const ready = /^TRACE_READY (\d+)$/.exec(message);
  if (ready !== null) return { kind: "ready", rows: Number(ready[1]) };
  if (/^TRACE_LOADED \d+$/.test(message)) return { kind: "loaded" };
  const perf = /^TRACE_PERF (\S+) (\d+(?:\.\d+)?)$/.exec(message);
  if (perf !== null) return { kind: "perf", name: perf[1] ?? "", ms: Number(perf[2]) };
  return null;
}

/** JEVCODE_TRACE_PERF=1: print a trace window's TRACE_PERF lines to the main-process log (docs/perf.md). */
export function forwardTracePerf(
  window: { webContents: SmokeWebContents },
  log: (line: string) => void,
): void {
  window.webContents.on("console-message", (_event, _level, message) => {
    if (parseTraceLine(message)?.kind === "perf") log(message);
  });
}

export function runSmoke(deps: SmokeDeps): void {
  let finished = false;
  let timer: unknown = null;

  function schedule(ms: number, fn: () => void): void {
    if (timer !== null) deps.clearTimeout(timer);
    timer = deps.setTimeout(fn, ms);
  }

  function finish(): void {
    finished = true;
    if (timer !== null) {
      deps.clearTimeout(timer);
      timer = null;
    }
  }

  function fail(reason: string): void {
    if (finished) return;
    finish();
    // Page text and Electron-supplied reasons must not forge extra output lines.
    deps.error(`SMOKE_FAIL: ${reason.replace(CONTROL_CHARS, "")}`);
    deps.fail();
  }

  function succeed(): void {
    if (finished) return;
    finish();
    deps.log("SMOKE_OK");
    deps.succeed();
  }

  function watch(window: { webContents: SmokeWebContents }, name: "main" | "trace"): void {
    window.webContents.on("console-message", (_event, level, message) => {
      if (isConsoleFailure(level, message)) fail(`console error in ${name} window: ${message}`);
    });
    window.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
      fail(`${name} window failed to load (${errorCode} ${errorDescription})`);
    });
    window.webContents.on("render-process-gone", (_event, details) => {
      fail(`${name} renderer gone (${details.reason})`);
    });
  }

  function startTracePhase(dbPath: string): void {
    const sessionId = deps.newestSessionId();
    if (sessionId === null) {
      fail(`no session in ${dbPath}`);
      return;
    }
    const openedAt = deps.now();
    let firstPaintMs: number | null = null;
    let rows = 0;
    let loadedSeen = false;
    schedule(SMOKE_TRACE_TIMEOUT_MS, () => {
      const missing = firstPaintMs === null ? "TRACE_READY" : "TRACE_LOADED";
      fail(`trace window did not report ${missing} within 30s`);
    });
    const window = deps.openTraceWindow(sessionId);
    watch(window, "trace");
    window.webContents.on("console-message", (_event, _level, message) => {
      if (finished) return;
      const line = parseTraceLine(message);
      if (line === null || line.kind === "perf") return;
      if (line.kind === "ready") {
        if (firstPaintMs === null) {
          if (line.rows === 0) {
            fail("trace window reported TRACE_READY 0 (no rows)");
            return;
          }
          firstPaintMs = deps.now() - openedAt;
          rows = line.rows;
        }
        return;
      }
      if (loadedSeen) return;
      if (firstPaintMs === null) {
        fail("TRACE_LOADED arrived before TRACE_READY");
        return;
      }
      loadedSeen = true;
      const fullLoadMs = deps.now() - openedAt;
      deps.log(
        `SMOKE_TRACE session=${sessionId} rows=${rows} first_paint_ms=${Math.round(firstPaintMs)} full_load_ms=${Math.round(fullLoadMs)}`,
      );
      schedule(SMOKE_SETTLE_MS, succeed);
    });
  }

  const traceRequested = deps.env["JEVCODE_SMOKE_TRACE"] === "1";
  const dbPath = deps.env["JEVCODE_DB"] ?? "";

  watch(deps.mainWindow, "main");
  schedule(SMOKE_MAIN_TIMEOUT_MS, () => {
    fail("renderer did not finish loading within 15s");
  });
  deps.mainWindow.webContents.once("did-finish-load", () => {
    if (finished) return;
    if (!traceRequested) {
      succeed();
      return;
    }
    if (dbPath.length === 0) {
      fail("JEVCODE_SMOKE_TRACE=1 needs JEVCODE_DB (a replay or soak database)");
      return;
    }
    startTracePhase(dbPath);
  });
}
