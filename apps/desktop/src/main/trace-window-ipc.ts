import { IpcError } from "../shared/errors.js";
import {
  MainToRendererLocalChannels,
  RendererToMainLocalChannels,
} from "../shared/local-channels.js";
import type { IpcHandle } from "./trace-ipc.js";
import type { TraceWindowRegistry } from "./trace-window.js";

export interface TraceWindowIpcDeps {
  windows: TraceWindowRegistry;
  /** listSessions({ sessionId, limit: 1 }) through the TraceReader (A2 + UI index §1.3). */
  sessionExists(sessionId: string): boolean;
  focusMainWindow(): void;
  sendToRenderer: typeof import("./ipc.js").sendToRenderer;
}

function unknownSession(sessionId: string): IpcError {
  return new IpcError("UNKNOWN_SESSION", `no session with id ${sessionId}`);
}

/**
 * trace:open → openTraceWindow (UNKNOWN_SESSION when absent);
 * trace:requestChanges → focusMainWindow + composer:prefill. The handlers
 * reach only the reader-backed sessionExists, the window registry and
 * sendToRenderer: never the runtime, the instruction router or the writer,
 * so a review note is never sent as an instruction (spec §8.5).
 */
export function registerTraceWindowHandlers(handle: IpcHandle, deps: TraceWindowIpcDeps): void {
  handle(RendererToMainLocalChannels.traceOpen, ({ sessionId }) => {
    if (!deps.sessionExists(sessionId)) throw unknownSession(sessionId);
    // The BrowserWindow is not serializable; the invoke resolves with nothing.
    deps.windows.openTraceWindow(sessionId);
  });

  handle(RendererToMainLocalChannels.traceRequestChanges, ({ sessionId, text }, { senderId }) => {
    // A trace window may only ask for changes to the session it shows
    // (fail closed, spec §8.6); the registry knows each window's session.
    if (deps.windows.sessionForSender(senderId) !== sessionId) {
      throw new IpcError(
        "UNTRUSTED_SENDER",
        `${RendererToMainLocalChannels.traceRequestChanges} is limited to the sender window's own session`,
      );
    }
    if (!deps.sessionExists(sessionId)) throw unknownSession(sessionId);
    deps.focusMainWindow();
    deps.sendToRenderer(MainToRendererLocalChannels.composerPrefill, { sessionId, text });
  });
}
