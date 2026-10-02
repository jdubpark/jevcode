import path from "node:path";

/**
 * JEVCODE_SMOKE_WORKSPACE=1: drives the real main window through the real IPC
 * path. It opens a git repo, starts a mock session, waits for the embedded
 * viewer's WORKSPACE_READY and captures the window at 1440 and 1000 px. D-6
 * adds append latency and the view walk. Electron is reached only through
 * WorkspaceSmokeDeps, so vitest drives every path with fakes.
 */

export const WORKSPACE_READY_TIMEOUT_MS = 30_000;
export const SHOT_WIDTHS = [1440, 1000] as const;
export const SHOT_HEIGHT = 900;
export const SMOKE_PROMPT = "Smoke: show the Console while the mock agent works";

export interface WorkspaceSmokeDeps {
  /** mainWindow.webContents.executeJavaScript(script, true). */
  exec(script: string): Promise<unknown>;
  /** Every main-window console line; returns the unsubscribe. */
  onConsole(listener: (message: string) => void): () => void;
  /** Resizes the window's content to width × height, lets it settle, returns a PNG. */
  capture(width: number, height: number): Promise<Uint8Array>;
  writeFile(filePath: string, data: Uint8Array): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  log(line: string): void;
}

export interface WorkspaceSmokeOptions {
  repoPath: string;
  shotsDir: string | null;
}

export function parseWorkspaceReady(message: string): number | null {
  const match = /^WORKSPACE_READY (\d+)$/.exec(message);
  return match === null ? null : Number(match[1]);
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
  const ready = waitForLine(deps, parseWorkspaceReady, WORKSPACE_READY_TIMEOUT_MS, "WORKSPACE_READY");
  ready.catch(() => undefined);
  await deps.exec(openRepoScript(options.repoPath));
  await deps.exec(startSessionScript(SMOKE_PROMPT));
  const rows = await ready;
  deps.log(`SMOKE_WORKSPACE ready rows=${rows}`);
  await captureShots(deps, options.shotsDir);
}
