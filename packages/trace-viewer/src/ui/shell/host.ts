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
}
