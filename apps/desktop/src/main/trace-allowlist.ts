import { RendererToMainLocalChannels } from "../shared/local-channels.js";

/** How the ipc.ts handle wrapper classifies event.sender.id. */
export type SenderKind = "main" | "trace" | "other";

/** Everything a trace window may invoke: the three reads and the review-note handoff (spec §8.6). */
export const TRACE_WINDOW_CHANNELS: readonly string[] = [
  RendererToMainLocalChannels.traceListSessions,
  RendererToMainLocalChannels.traceRows,
  RendererToMainLocalChannels.tracePayloads,
  RendererToMainLocalChannels.traceRequestChanges,
];

/**
 * Spec §8.6: main → every channel except trace:requestChanges; trace →
 * TRACE_WINDOW_CHANNELS only; other → none. A trace window shares the preload,
 * so this check is what keeps it away from agent, decision, session, repo and
 * telemetry channels.
 */
export function isChannelAllowed(channel: string, sender: SenderKind): boolean {
  switch (sender) {
    case "main":
      return channel !== RendererToMainLocalChannels.traceRequestChanges;
    case "trace":
      return TRACE_WINDOW_CHANNELS.includes(channel);
    case "other":
      return false;
  }
}

/** main → renderer pushes a trace window may receive (spec §7). Everything else goes to the main window only. */
export const TRACE_WINDOW_PUSH_CHANNELS: readonly string[] = ["trace:rowsAvailable"];

export function isPushAllowed(channel: string, receiver: SenderKind): boolean {
  switch (receiver) {
    case "main":
      return true;
    case "trace":
      return TRACE_WINDOW_PUSH_CHANNELS.includes(channel);
    case "other":
      return false;
  }
}
