import { createContext, useContext } from "react";

import type { TraceRow, TraceSessionSummary } from "@jevcode/contracts";

import type { TimeScale } from "../../layout/time-scale.js";
import type { TraceIndex } from "../../layout/trace-index.js";
import type { TraceSession } from "../../model/index.js";
import type { DataStatus } from "./data-controller.js";

export interface SessionView {
  summary: TraceSessionSummary | null;
  session: TraceSession | null;
  index: TraceIndex;
  scale: TimeScale;
  status: DataStatus;
  loadedFraction: number;
  terminal: boolean;
  /** Display-clock now: source.now() − originMs. */
  nowT(): number;
  payloads(seqs: readonly number[]): Promise<TraceRow[]>;
  retry(): void;
}

export const SessionContext = createContext<SessionView | null>(null);

export function useSessionView(): SessionView {
  const view = useContext(SessionContext);
  if (view === null) throw new Error("useSessionView must be used inside the trace viewer Shell");
  return view;
}

/** Selftest diagnostics (spec §11 visual smoke). Disabled unless the host passes onDiagnostics. */
export interface DiagnosticsSink {
  readonly enabled: boolean;
  reportDrift(px: number): void;
  reportError(message: string): void;
  flush(): void;
}

export const DiagnosticsContext = createContext<DiagnosticsSink>({
  enabled: false,
  reportDrift: () => undefined,
  reportError: () => undefined,
  flush: () => undefined,
});

export function useDiagnostics(): DiagnosticsSink {
  return useContext(DiagnosticsContext);
}
