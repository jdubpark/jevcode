import type { ViewerHost } from "@jevcode/trace-viewer";

import type { JevcodeApi } from "../../shared/api.js";

/** ui-catalog Decision.tsx answers with this key when no suggested answer names one. */
export const DECISION_ANSWER_KEY = "decision";

export interface MainHostDeps {
  bridge: Pick<JevcodeApi, "action" | "trace" | "overview">;
  sessionId: string;
  repoRoot(): string | null;
  /** Appends a review note to this session's composer draft and focuses it (composerReducer "prefill"). */
  prefill(text: string): void;
  log(line: string): void;
  /** Smoke only: log every view and selection change as WORKSPACE_LOCATION. */
  logLocations?: boolean;
}

/**
 * The main window's ViewerHost (spec §9). Each action goes through a channel
 * main already allowlists and validates: answers through action:invoke
 * (dispatchAction checks the option), the trace window through trace:open
 * (main checks the session), and rescans through overview:rescan (lane 04
 * registers and checks it). A review note stays local and is never sent.
 */
export function createMainHost(deps: MainHostDeps): ViewerHost {
  let ready = false;
  const report = (what: string) => (error: unknown) => {
    deps.log(`[workspace] ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
  };
  return {
    requestChanges: (request) => {
      if (request.sessionId !== deps.sessionId) return;
      deps.prefill(request.text);
    },
    answerDecision: ({ decisionId, optionId }) =>
      deps.bridge.action.invoke("answer_decision", {
        decisionId,
        decision: { [DECISION_ANSWER_KEY]: optionId },
      }),
    openTraceWindow: () => {
      void deps.bridge.trace.open(deps.sessionId).catch(report("trace:open"));
    },
    rescanOverview: () => {
      const repoRoot = deps.repoRoot();
      if (repoRoot === null) return;
      void deps.bridge.overview.rescan(repoRoot).catch(report("overview:rescan"));
    },
    onReady: (info) => {
      if (ready) return;
      ready = true;
      deps.log(`WORKSPACE_READY ${info.rows}`);
    },
    onLocation: deps.logLocations
      ? (location) => {
          deps.log(`WORKSPACE_LOCATION ${JSON.stringify({ view: location.view, selected: location.selected ?? null })}`);
        }
      : undefined,
  };
}
