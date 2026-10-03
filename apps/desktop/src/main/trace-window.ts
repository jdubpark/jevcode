import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  WebPreferences,
} from "electron";

export const TRACE_WINDOW_MIN_WIDTH = 1000;
export const TRACE_WINDOW_BACKGROUND = "#FFFFFF";
/** The main window's native background: LIGHT_TOKENS.canvas, so no dark flash before the page paints (spec E6). */
export const MAIN_WINDOW_BACKGROUND = "#F4F5F7";
/**
 * The main window's minimum width. Below about 870 px the embedded viewer bar (switcher, Review/Live, Brief) no longer
 * fits beside the sidebar, which styles.css narrows from 220 to 200 px below a 1120 px window: at 880 px the bar is
 * 680 px wide (lane 03 D-6; re-measured in Electron in the fix wave, and the dev-host smoke checks the bar at 680 px).
 * styles.css `.app` holds the page to the same width.
 */
export const MAIN_WINDOW_MIN_WIDTH = 880;

/**
 * Renderer isolation shared by the main window and every trace window
 * (docs/security.md row 1). index.ts createWindow calls this too, so the two
 * windows cannot drift apart.
 */
export function sharedWebPreferences(preloadPath: string): WebPreferences {
  return {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    preload: preloadPath,
  };
}

/** width 1440, height 900, minWidth 1000, backgroundColor #FFFFFF, show false, the main window's webPreferences with this preload. */
export function traceWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1440,
    height: 900,
    minWidth: TRACE_WINDOW_MIN_WIDTH,
    // The main window's #14161a would flash through the light viewer (spec §8.1).
    backgroundColor: TRACE_WINDOW_BACKGROUND,
    show: false,
    webPreferences: sharedWebPreferences(preloadPath),
  };
}

export type TraceWindowHandle = Pick<
  BrowserWindow,
  "loadFile" | "once" | "on" | "show" | "focus" | "restore" | "isMinimized" | "isDestroyed" | "close"
> & {
  webContents: Pick<BrowserWindow["webContents"], "id" | "on" | "setWindowOpenHandler">;
};

export interface TraceWindowRegistryDeps {
  create(options: BrowserWindowConstructorOptions): TraceWindowHandle;
  preloadPath: string;
  /** dist/renderer/src/renderer/trace.html */
  traceHtmlPath: string;
}

export interface TraceWindowRegistry {
  /** Focuses the existing window for sessionId; else creates one, records webContents.id before loadFile(traceHtmlPath, {query: {session}}), blocks will-navigate and denies window.open. */
  openTraceWindow(sessionId: string): TraceWindowHandle;
  isTraceSender(webContentsId: number): boolean;
  /** The session a trace window shows, by its webContents.id; undefined for any other sender. */
  sessionForSender(webContentsId: number): string | undefined;
  /** webContents ids of the open trace windows that show sessionId (trace:rowsAvailable recipients). */
  sendersForSession(sessionId: string): number[];
  closeAll(): void;
  count(): number;
}

export function createTraceWindowRegistry(deps: TraceWindowRegistryDeps): TraceWindowRegistry {
  const bySession = new Map<string, TraceWindowHandle>();
  const senders = new Map<number, string>();

  function bringToFront(window: TraceWindowHandle): void {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  return {
    openTraceWindow(sessionId) {
      const existing = bySession.get(sessionId);
      if (existing !== undefined && !existing.isDestroyed()) {
        bringToFront(existing);
        return existing;
      }
      const window = deps.create(traceWindowOptions(deps.preloadPath));
      // The IPC allowlist (spec §8.6) must know this sender before any page
      // script can run, so the id is recorded before loadFile.
      const webContentsId = window.webContents.id;
      senders.set(webContentsId, sessionId);
      bySession.set(sessionId, window);
      window.webContents.on("will-navigate", (event) => {
        event.preventDefault();
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.once("ready-to-show", () => {
        window.show();
      });
      window.on("closed", () => {
        senders.delete(webContentsId);
        if (bySession.get(sessionId) === window) bySession.delete(sessionId);
      });
      window
        .loadFile(deps.traceHtmlPath, { query: { session: sessionId } })
        .catch((error: unknown) => {
          console.error(
            `[trace] failed to load the trace window for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
          );
          // Drop the blank window (closed removes the registry entries) so the
          // next Trace click creates a fresh one instead of focusing it.
          if (!window.isDestroyed()) window.close();
        });
      return window;
    },
    isTraceSender(webContentsId) {
      return senders.has(webContentsId);
    },
    sessionForSender(webContentsId) {
      return senders.get(webContentsId);
    },
    sendersForSession(sessionId) {
      const ids: number[] = [];
      for (const [webContentsId, shown] of senders) {
        if (shown === sessionId) ids.push(webContentsId);
      }
      return ids;
    },
    closeAll() {
      for (const window of [...bySession.values()]) {
        if (!window.isDestroyed()) window.close();
      }
    },
    count() {
      return bySession.size;
    },
  };
}
