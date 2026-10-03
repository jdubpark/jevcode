export * from "./source.js";
export * from "./layout/viewport.js";
export { createViewportController, SETTLE_MS, type ViewportController, type ViewportControllerOptions, type FramePhase } from "./ui/viewport/controller.js";
export { ViewerLocationSchema, decodeLocation, locationFromHash, locationToHash, type ViewerLocation } from "./ui/state/location.js";
export { TraceViewer, type TraceViewerProps, type ViewerChrome } from "./ui/shell/TraceViewer.js";
export type {
  ViewerHost,
  RequestChangesRequest,
  ViewerReadyInfo,
  ViewerDiagnostics,
  AnswerDecisionRequest,
} from "./ui/shell/host.js";
// Host views (spec §8.5): a host view reads the viewer's store and session through these.
export type { ViewDefinition, ViewProps } from "./ui/views/view-port.js";
export type { ViewKind } from "./ui/state/view-state.js";
export type { IconName } from "./ui/icons/icon-names.js";
export { useDispatch, useView } from "./ui/state/store.js";
export { useSessionView, type SessionView } from "./ui/shell/session-context.js";
export type { SelectionId } from "./layout/trace-index.js";
export { INITIAL_SELECTION_PAINTED, PERF, markAfterPaint } from "./ui/shell/perf.js";
export * from "./sources/index.js";
export { FONT_MONO, FONT_SANS, LIGHT_TOKENS, TOKEN_VARS, tokenStyle, type TokenName, type Tokens } from "./ui/tokens/tokens.js";
