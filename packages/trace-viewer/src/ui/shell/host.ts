import type { SelectionId } from "../../layout/trace-index.js";
import type { ViewerLocation } from "../state/location.js";

export interface RequestChangesRequest {
  sessionId: string;
  selected: SelectionId;
  text: string;
}

export interface ViewerReadyInfo {
  rows: number;
  loadedThroughSeq: number;
}

export interface AnswerDecisionRequest {
  decisionId: string;
  optionId: string;
}

export interface ViewerDiagnostics {
  errors: string[];
  maxAnchorDriftPx: number;
  selectedTitle: string | null;
}

/** The viewer's only outbound surface. The viewer never writes; requestChanges focuses the main window's composer (M5). */
export interface ViewerHost {
  requestChanges?(request: RequestChangesRequest): void | Promise<void>;
  onLocation?(location: ViewerLocation): void;
  /** Once, after the first committed fold. */
  onReady?(info: ViewerReadyInfo): void;
  /** Dev-host selftest only; enables anchor-drift measurement. */
  onDiagnostics?(diagnostics: ViewerDiagnostics): void;
  /** Main window only (spec §9): answers a pending decision through the host's allowlisted dispatch. */
  answerDecision?(request: AnswerDecisionRequest): void | Promise<void>;
  /** Main window only: opens the read-only trace window for this session. */
  openTraceWindow?(): void;
  /** Main window only (spec §6.6): Retry after "Codebase map unavailable". */
  rescanOverview?(): void;
}
