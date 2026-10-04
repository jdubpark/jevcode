import path from "node:path";

/**
 * JEVCODE_SMOKE_WORKSPACE=1 (spec §12 "Electron smoke"). The phase drives the
 * real main window through the real IPC path:
 * 1. open a git repo, start a scripted mock session, wait for WORKSPACE_READY
 * 2. measure Console append latency, from main's append clock to the
 *    renderer's CONSOLE_PAINT lines (p95 ≤ 150 ms over ≥ minSamples rows)
 * 3. capture the window at 1440 and 1000 px while nothing is selected, so the
 *    right panel shows the Brief (the approved main-window mockup)
 * 4. select a step and walk every view by key, checking the selection survives;
 *    in Surfaces, dismiss the visible surface, require the completion surface's
 *    action buttons, click show_exact_diff and wait for a diff: surface
 * 5. open Settings from the sidebar, capture it at 1440 px, close it, then press
 *    one view key and require the same selection (Back restores the workspace)
 * Electron is reached only through WorkspaceSmokeDeps.
 */

export const WORKSPACE_READY_TIMEOUT_MS = 30_000;
export const SHOT_WIDTHS = [1440, 1000] as const;
export const SHOT_HEIGHT = 900;
export const SMOKE_PROMPT = "Smoke: show the Console while the mock agent works";
/** Spec §11: Console append latency, row stored → line painted, with the push hint. */
export const CONSOLE_APPEND_P95_BUDGET_MS = 150;
/** docs/perf.md: a p95 budget needs at least 300 samples. */
export const DEFAULT_MIN_SAMPLES = 300;
/** The mock run is over once no row has been stored for this long. */
export const APPEND_QUIET_MS = 3_000;
export const APPEND_PHASE_TIMEOUT_MS = 180_000;
export const VIEW_STEP_TIMEOUT_MS = 5_000;
/** Bound on each wait inside the Surfaces step (renderer-side polling). */
export const SURFACE_STEP_TIMEOUT_MS = 8_000;
/** Spec §3.7 and §8.6 keys, ending back on Console. */
export const VIEW_KEYS = [
  { code: "Digit1", key: "1", view: "canvas" },
  { code: "Digit2", key: "2", view: "hybrid" },
  { code: "Digit3", key: "3", view: "map" },
  { code: "Digit4", key: "4", view: "surfaces" },
  { code: "Digit0", key: "0", view: "console" },
] as const;

export interface AppendRecord {
  seq: number;
  atMs: number;
  /** The stored row's type, when main reports it (observeTraceAppends does). */
  type?: string;
}

export interface AppendLog {
  record(sessionId: string, seq: number, type?: string): void;
  entries(sessionId: string): readonly AppendRecord[];
}

/** Main's wall clock at each committed trace-row append (fed by observeTraceAppends). */
export function createAppendLog(now: () => number): AppendLog {
  const bySession = new Map<string, AppendRecord[]>();
  return {
    record(sessionId, seq, type) {
      const list = bySession.get(sessionId) ?? [];
      list.push(type === undefined ? { seq, atMs: now() } : { seq, atMs: now(), type });
      bySession.set(sessionId, list);
    },
    entries: (sessionId) => bySession.get(sessionId) ?? [],
  };
}

export interface ConsolePaint {
  sessionId: string;
  throughSeq: number;
  atMs: number;
}

export interface WorkspaceLocation {
  view: string;
  selected: string | null;
}

export interface WorkspaceSmokeDeps {
  /** mainWindow.webContents.executeJavaScript(script, true). */
  exec(script: string): Promise<unknown>;
  /** Every main-window console line; returns the unsubscribe. */
  onConsole(listener: (message: string) => void): () => void;
  /** Resizes the window's content to width × height, lets it settle, returns a PNG. */
  capture(width: number, height: number): Promise<Uint8Array>;
  writeFile(filePath: string, data: Uint8Array): void;
  appends: AppendLog;
  /** Main's event-loop delay over the append phase (perf_hooks.monitorEventLoopDelay); absent in tests that do not need it. */
  loopDelay?: { reset(): void; snapshot(): { p99Ms: number; maxMs: number } };
  /** Date.now(): the clock both the append log and CONSOLE_PAINT use. */
  wallNow(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  log(line: string): void;
}

export interface WorkspaceSmokeOptions {
  repoPath: string;
  shotsDir: string | null;
  minSamples: number;
}

export function parseWorkspaceReady(message: string): number | null {
  const match = /^WORKSPACE_READY (\d+)$/.exec(message);
  return match === null ? null : Number(match[1]);
}

export function parseConsolePaint(message: string): ConsolePaint | null {
  const match = /^CONSOLE_PAINT (\S+) (\d+) (\d+)$/.exec(message);
  if (match === null) return null;
  return { sessionId: match[1] ?? "", throughSeq: Number(match[2]), atMs: Number(match[3]) };
}

export function parseWorkspaceLocation(message: string): WorkspaceLocation | null {
  const prefix = "WORKSPACE_LOCATION ";
  if (!message.startsWith(prefix)) return null;
  try {
    const value: unknown = JSON.parse(message.slice(prefix.length));
    if (typeof value !== "object" || value === null) return null;
    const { view, selected } = value as { view?: unknown; selected?: unknown };
    if (typeof view !== "string") return null;
    return { view, selected: typeof selected === "string" ? selected : null };
  } catch {
    return null;
  }
}

/** For each stored row, the time until the first paint whose throughSeq covers it; rows no paint covers are unpainted. */
export function appendLatencies(
  appends: readonly AppendRecord[],
  paints: readonly ConsolePaint[],
): { latencies: number[]; unpainted: number[] } {
  const ordered = [...paints].sort((a, b) => a.atMs - b.atMs);
  const latencies: number[] = [];
  const unpainted: number[] = [];
  for (const append of appends) {
    const paint = ordered.find((candidate) => candidate.throughSeq >= append.seq);
    if (paint === undefined) unpainted.push(append.seq);
    else latencies.push(Math.max(0, paint.atMs - append.atMs));
  }
  return { latencies, unpainted };
}

export interface SlowestAppend {
  seq: number;
  type: string;
  storedAtMs: number;
  paintedAtMs: number;
  latencyMs: number;
}

/** The append with the largest stored → painted time, for attributing a one-off max spike; null when none painted. */
export function slowestAppend(appends: readonly AppendRecord[], paints: readonly ConsolePaint[]): SlowestAppend | null {
  const ordered = [...paints].sort((a, b) => a.atMs - b.atMs);
  let slowest: SlowestAppend | null = null;
  for (const append of appends) {
    const paint = ordered.find((candidate) => candidate.throughSeq >= append.seq);
    if (paint === undefined) continue;
    const latencyMs = Math.max(0, paint.atMs - append.atMs);
    if (slowest === null || latencyMs > slowest.latencyMs) {
      slowest = { seq: append.seq, type: append.type ?? "unknown", storedAtMs: append.atMs, paintedAtMs: paint.atMs, latencyMs };
    }
  }
  return slowest;
}

/** Nearest-rank percentile; NaN for no values. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1] ?? Number.NaN;
}

export function openRepoScript(repoPath: string): string {
  return `window.jevcode.repo.open(${JSON.stringify(repoPath)})`;
}

export function startSessionScript(prompt: string): string {
  return `(async () => {
    const [repo] = await window.jevcode.repo.listRecent(1);
    if (repo === undefined) throw new Error("no recent repo after repo:open");
    await window.jevcode.session.start(repo.repoId, ${JSON.stringify(prompt)});
    return repo.repoId;
  })()`;
}

/** The newest session is the one repo:open created and session:start ran. */
export const NEWEST_SESSION_SCRIPT =
  "window.jevcode.trace.listSessions({ limit: 1 }).then((sessions) => sessions[0]?.sessionId ?? null)";

/** A key press as the viewer's KeyboardLayer sees it, never inside a text field (viewer spec §7.9). */
export function pressKeyScript(code: string, key: string): string {
  return `(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    const init = { key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)}, bubbles: true, cancelable: true };
    document.body.dispatchEvent(new KeyboardEvent("keydown", init));
    document.body.dispatchEvent(new KeyboardEvent("keyup", init));
    return true;
  })()`;
}

/**
 * Renderer-side Surfaces probes. Each polls the DOM for up to SURFACE_STEP_TIMEOUT_MS
 * and resolves to the visible surface ids, with the data-action names in `actions`.
 * `data-surface-id` and `data-action` are the Surfaces view's and the catalog's own hooks.
 */
const SURFACE_SNAPSHOT = `(() => ({
    ids: [...document.querySelectorAll("[data-surface-id]")].map((el) => el.getAttribute("data-surface-id")),
    actions: [...document.querySelectorAll("[data-surface-id] [data-action]")].map((el) => el.getAttribute("data-action")),
  }))()`;

function pollSurfaces(done: string): string {
  return `(async () => {
    const snapshot = () => ${SURFACE_SNAPSHOT};
    const until = Date.now() + ${SURFACE_STEP_TIMEOUT_MS};
    while (Date.now() < until) {
      const state = snapshot();
      if (${done}) return state;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { ...snapshot(), timedOut: true };
  })()`;
}

/** Waits for a visible surface; if it has no action buttons, clicks its Dismiss so the pending one takes the slot. */
export const SURFACES_DISMISS_SCRIPT = `(async () => {
  const until = Date.now() + ${SURFACE_STEP_TIMEOUT_MS};
  while (Date.now() < until && document.querySelector("[data-surface-id]") === null) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const first = document.querySelector("[data-surface-id]");
  if (first === null) return { ids: [], actions: [], timedOut: true };
  if (first.querySelector("[data-action]") === null) {
    const dismiss = [...first.querySelectorAll("button")].find((button) => button.textContent.trim() === "Dismiss");
    if (dismiss === undefined) return { ids: [first.getAttribute("data-surface-id")], actions: [], noDismiss: true };
    dismiss.click();
  }
  return ${pollSurfaces('state.actions.includes("show_exact_diff")')};
})()`;

/** Clicks show_exact_diff, then waits for main to push back a diff: surface. */
export const SURFACES_CLICK_DIFF_SCRIPT = `(async () => {
  const button = document.querySelector('[data-surface-id] [data-action="show_exact_diff"]');
  if (button === null) return { ids: [], actions: [], noButton: true };
  button.click();
  return ${pollSurfaces('state.ids.some((id) => typeof id === "string" && id.startsWith("diff:"))')};
})()`;

export interface SurfaceProbe {
  ids: string[];
  actions: string[];
  timedOut?: boolean;
  noDismiss?: boolean;
  noButton?: boolean;
}

function readSurfaceProbe(value: unknown, step: string): SurfaceProbe {
  const probe = value as Partial<SurfaceProbe> | null;
  if (typeof probe !== "object" || probe === null || !Array.isArray(probe.ids) || !Array.isArray(probe.actions)) {
    throw new Error(`Surfaces step ${step}: unreadable DOM probe result`);
  }
  return probe as SurfaceProbe;
}

/** The Surfaces step: the catalog's action buttons must render and a click must come back from main as a diff: surface. */
export async function exerciseSurfaces(deps: Pick<WorkspaceSmokeDeps, "exec" | "log">): Promise<void> {
  const dismissed = readSurfaceProbe(await deps.exec(SURFACES_DISMISS_SCRIPT), "dismiss");
  if (dismissed.noDismiss === true) throw new Error(`Surfaces step: ${dismissed.ids.join(",")} has no Dismiss button`);
  if (dismissed.timedOut === true && dismissed.ids.length === 0) throw new Error("Surfaces step: no surface rendered");
  if (!dismissed.actions.includes("show_exact_diff")) {
    throw new Error(
      `Surfaces step: completion surface action buttons did not render (surfaces=[${dismissed.ids.join(",")}] actions=[${dismissed.actions.join(",")}], expected show_exact_diff)`,
    );
  }
  const clicked = readSurfaceProbe(await deps.exec(SURFACES_CLICK_DIFF_SCRIPT), "click");
  if (clicked.noButton === true) throw new Error("Surfaces step: show_exact_diff button vanished before the click");
  if (!clicked.ids.some((id) => id.startsWith("diff:"))) {
    throw new Error(
      `Surfaces step: no diff: surface appeared within ${SURFACE_STEP_TIMEOUT_MS / 1000}s after clicking show_exact_diff (surfaces=[${clicked.ids.join(",")}])`,
    );
  }
  deps.log(`SMOKE_SURFACES actions=${dismissed.actions.join(",")} diff=${clicked.ids.filter((id) => id.startsWith("diff:")).join(",")}`);
}

export function waitForLine<T>(
  deps: Pick<WorkspaceSmokeDeps, "onConsole" | "setTimeout" | "clearTimeout">,
  parse: (message: string) => T | null,
  timeoutMs: number,
  what: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: unknown = null;
    const off = deps.onConsole((message) => {
      const value = parse(message);
      if (value === null) return;
      if (timer !== null) deps.clearTimeout(timer);
      off();
      resolve(value);
    });
    timer = deps.setTimeout(() => {
      off();
      reject(new Error(`${what} not seen within ${timeoutMs / 1000}s`));
    }, timeoutMs);
  });
}

function waitUntil(
  deps: Pick<WorkspaceSmokeDeps, "setTimeout">,
  condition: () => boolean,
  timeoutMs: number,
  what: string,
  intervalMs = 250,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let waited = 0;
    const check = (): void => {
      if (condition()) {
        resolve();
        return;
      }
      if (waited >= timeoutMs) {
        reject(new Error(`${what} not reached within ${timeoutMs / 1000}s`));
        return;
      }
      waited += intervalMs;
      deps.setTimeout(check, intervalMs);
    };
    check();
  });
}

async function measureAppends(
  deps: WorkspaceSmokeDeps,
  options: WorkspaceSmokeOptions,
  sessionId: string,
  readyAt: number,
  paints: readonly ConsolePaint[],
): Promise<void> {
  const settled = (): boolean => {
    const last = deps.appends.entries(sessionId).at(-1);
    if (last === undefined || deps.wallNow() - last.atMs < APPEND_QUIET_MS) return false;
    return paints.some((paint) => paint.sessionId === sessionId && paint.throughSeq >= last.seq);
  };
  deps.loopDelay?.reset();
  let loop: { p99Ms: number; maxMs: number } | undefined;
  try {
    await waitUntil(deps, settled, APPEND_PHASE_TIMEOUT_MS, "the session's last row painted in the Console");
  } finally {
    // snapshot() also disables the histogram, so a timed-out phase does not leave it sampling.
    loop = deps.loopDelay?.snapshot();
  }
  const appends = deps.appends.entries(sessionId).filter((entry) => entry.atMs >= readyAt);
  const { latencies, unpainted } = appendLatencies(
    appends,
    paints.filter((paint) => paint.sessionId === sessionId),
  );
  if (unpainted.length > 0) throw new Error(`rows never painted: ${unpainted.slice(0, 10).join(", ")}`);
  if (latencies.length < options.minSamples) {
    throw new Error(`only ${latencies.length} append samples (need ${options.minSamples})`);
  }
  const p50 = percentile(latencies, 0.5);
  const p95 = percentile(latencies, 0.95);
  const max = Math.max(...latencies);
  deps.log(
    `SMOKE_CONSOLE appends=${latencies.length} p50_ms=${Math.round(p50)} p95_ms=${Math.round(p95)} max_ms=${Math.round(max)}`,
  );
  const paintsOfSession = paints.filter((paint) => paint.sessionId === sessionId);
  const slowest = slowestAppend(appends, paintsOfSession);
  if (slowest !== null) {
    deps.log(
      `SMOKE_CONSOLE_SLOWEST seq=${slowest.seq} type=${slowest.type} stored_at_ms=${slowest.storedAtMs} painted_at_ms=${slowest.paintedAtMs} latency_ms=${Math.round(slowest.latencyMs)}`,
    );
  }
  if (loop !== undefined) {
    // The histogram samples every 10 ms, so a value includes up to that resolution on top of the stall itself.
    deps.log(`SMOKE_LOOP_DELAY p99_ms=${Math.round(loop.p99Ms)} max_ms=${Math.round(loop.maxMs)} resolution_ms=10`);
  }
  if (p95 > CONSOLE_APPEND_P95_BUDGET_MS) {
    throw new Error(`Console append p95 ${Math.round(p95)} ms is over the ${CONSOLE_APPEND_P95_BUDGET_MS} ms budget`);
  }
}

async function walkViews(deps: WorkspaceSmokeDeps): Promise<string | null> {
  const firstSelection = waitForLine(
    deps,
    (message) => {
      const location = parseWorkspaceLocation(message);
      return location !== null && location.selected !== null ? location : null;
    },
    VIEW_STEP_TIMEOUT_MS,
    "a selection after j",
  );
  firstSelection.catch(() => undefined);
  await deps.exec(pressKeyScript("KeyJ", "j"));
  const selected = (await firstSelection).selected;
  for (const step of VIEW_KEYS) {
    const seen = waitForLine(
      deps,
      (message) => {
        const location = parseWorkspaceLocation(message);
        return location !== null && location.view === step.view ? location : null;
      },
      VIEW_STEP_TIMEOUT_MS,
      `view ${step.view} after key ${step.key}`,
    );
    seen.catch(() => undefined);
    await deps.exec(pressKeyScript(step.code, step.key));
    const location = await seen;
    if (location.selected !== selected) {
      throw new Error(`selection changed on ${step.view}: ${selected} → ${location.selected}`);
    }
    if (step.view === "surfaces") await exerciseSurfaces(deps);
  }
  deps.log(`SMOKE_VIEWS selected=${selected} views=${VIEW_KEYS.map((step) => step.view).join(",")}`);
  return selected;
}

const SETTINGS_WAIT_MS = 5_000;

function pollSettings(wantOpen: boolean): string {
  return `(async () => {
    const until = Date.now() + ${SETTINGS_WAIT_MS};
    const isOpen = () => document.querySelector("[data-settings-page]") !== null;
    while (Date.now() < until) {
      if (isOpen() === ${wantOpen}) return { open: isOpen() };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { open: isOpen(), timedOut: true };
  })()`;
}

export const SETTINGS_OPEN_SCRIPT = `(async () => {
  const row = document.querySelector("[data-settings-open]");
  if (row === null) return { open: false, noRow: true };
  row.click();
  return ${pollSettings(true)};
})()`;

export const SETTINGS_CLOSE_SCRIPT = `(async () => {
  const back = document.querySelector("[data-settings-back]");
  if (back !== null) back.click();
  return ${pollSettings(false)};
})()`;

/** Opens Settings from the sidebar, captures it at 1440 px, and closes it. */
export async function exerciseSettings(
  deps: Pick<WorkspaceSmokeDeps, "exec" | "capture" | "writeFile" | "log">,
  shotsDir: string | null,
): Promise<void> {
  const opened = (await deps.exec(SETTINGS_OPEN_SCRIPT)) as { open?: boolean } | null;
  if (opened?.open !== true) throw new Error("Settings step: the page did not open");
  if (shotsDir !== null) {
    const file = path.join(shotsDir, "main-settings-1440.png");
    deps.writeFile(file, await deps.capture(1440, SHOT_HEIGHT));
    deps.log(`SMOKE_SHOT ${file}`);
  }
  const closed = (await deps.exec(SETTINGS_CLOSE_SCRIPT)) as { open?: boolean } | null;
  if (closed?.open !== false) throw new Error("Settings step: the page did not close");
}

/** After Settings closes, one view key must report that view with the selection the views walk ended on. */
export async function verifyWorkspaceBack(deps: WorkspaceSmokeDeps, selected: string | null): Promise<void> {
  const step = VIEW_KEYS[0];
  if (step === undefined) throw new Error("Settings step: no view key to press");
  const seen = waitForLine(
    deps,
    (message) => {
      const location = parseWorkspaceLocation(message);
      return location !== null && location.view === step.view ? location : null;
    },
    VIEW_STEP_TIMEOUT_MS,
    `view ${step.view} after Settings closed`,
  );
  seen.catch(() => undefined);
  await deps.exec(pressKeyScript(step.code, step.key));
  let location: WorkspaceLocation;
  try {
    location = await seen;
  } catch (error) {
    throw new Error(`Settings step: the workspace did not come back as it was (${(error as Error).message})`);
  }
  if (location.selected !== selected) {
    throw new Error(
      `Settings step: the workspace did not come back as it was (selection ${selected} → ${location.selected} on ${location.view})`,
    );
  }
  deps.log(`SMOKE_SETTINGS open=true closed=true view_after=${location.view} selected=${location.selected}`);
}

export async function captureShots(
  deps: Pick<WorkspaceSmokeDeps, "capture" | "writeFile" | "log">,
  shotsDir: string | null,
): Promise<void> {
  if (shotsDir === null) return;
  for (const width of SHOT_WIDTHS) {
    const png = await deps.capture(width, SHOT_HEIGHT);
    const file = path.join(shotsDir, `main-console-${width}.png`);
    deps.writeFile(file, png);
    deps.log(`SMOKE_SHOT ${file}`);
  }
}

export async function runWorkspaceSmoke(deps: WorkspaceSmokeDeps, options: WorkspaceSmokeOptions): Promise<void> {
  const paints: ConsolePaint[] = [];
  const offPaints = deps.onConsole((message) => {
    const paint = parseConsolePaint(message);
    if (paint !== null) paints.push(paint);
  });
  try {
    const ready = waitForLine(deps, parseWorkspaceReady, WORKSPACE_READY_TIMEOUT_MS, "WORKSPACE_READY");
    ready.catch(() => undefined);
    await deps.exec(openRepoScript(options.repoPath));
    await deps.exec(startSessionScript(SMOKE_PROMPT));
    const rows = await ready;
    const readyAt = deps.wallNow();
    const sessionId = await deps.exec(NEWEST_SESSION_SCRIPT);
    if (typeof sessionId !== "string") throw new Error("could not read the smoke session id");
    deps.log(`SMOKE_WORKSPACE session=${sessionId} ready_rows=${rows}`);
    await measureAppends(deps, options, sessionId, readyAt, paints);
    await captureShots(deps, options.shotsDir);
    const selected = await walkViews(deps);
    await exerciseSettings(deps, options.shotsDir);
    await verifyWorkspaceBack(deps, selected);
  } finally {
    offPaints();
  }
}
