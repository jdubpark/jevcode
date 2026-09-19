import {
  actionParamSchemas,
  type AnswerDecisionParams,
  type DelegateDecisionParams,
} from "@jevcode/contracts";
import type { JevcodeDb } from "@jevcode/storage";

import { IpcError } from "../../shared/errors.js";
import { isAllowedAction, type AllowedAction } from "../actions.js";
import type { PipelineRuntime } from "./pipeline-runtime.js";
import type { TerminalSink } from "./types.js";

export interface ActionDispatcherDeps {
  runtime: PipelineRuntime;
  db: JevcodeDb;
  terminals: TerminalSink;
  activeSessionId: () => string | null;
  repoPath: () => string | null;
  log: (message: string) => void;
}

export async function dispatchAction(
  deps: ActionDispatcherDeps,
  action: string,
  rawParams: Record<string, unknown>,
): Promise<void> {
  if (!isAllowedAction(action)) {
    deps.log(`rejected unknown action: ${action}`);
    throw new IpcError("UNKNOWN_ACTION", `action not allowlisted: ${action}`);
  }
  const schema = actionParamSchemas[action];
  const parsed = schema.safeParse(rawParams);
  if (!parsed.success) {
    deps.log(`rejected invalid params for ${action}: ${parsed.error.message}`);
    throw new IpcError(
      "INVALID_ACTION_PARAMS",
      `${action}: ${parsed.error.message}`,
    );
  }
  const sessionId = deps.activeSessionId();
  if (sessionId === null) {
    throw new IpcError("NO_ACTIVE_SESSION", "no open repo session");
  }
  const params = parsed.data as Record<string, unknown>;
  await handlers[action](deps, sessionId, params);
}

type Handler = (
  deps: ActionDispatcherDeps,
  sessionId: string,
  params: Record<string, unknown>,
) => Promise<void>;

const handlers: Record<AllowedAction, Handler> = {
  async answer_decision(deps, sessionId, params) {
    await deps.runtime.answerDecision(sessionId, params as unknown as AnswerDecisionParams);
  },
  async delegate_decision(deps, sessionId, params) {
    await deps.runtime.delegateDecision(
      sessionId,
      params as unknown as DelegateDecisionParams,
    );
  },
  async restore_previous_api_semantics(deps, sessionId, params) {
    const symbol = String(params["symbol"] ?? "");
    await deps.runtime.restorePreviousApiSemantics(sessionId, symbol);
  },
  async inspect_call_sites(deps, sessionId, params) {
    const symbol = String(params["symbol"] ?? "");
    await deps.runtime.inspectCallSites(sessionId, symbol);
  },
  async show_exact_diff(deps, sessionId, params) {
    const files = Array.isArray(params["files"])
      ? params["files"].filter((entry): entry is string => typeof entry === "string")
      : [];
    await deps.runtime.showExactDiff(sessionId, files);
  },
  async accept_changes(deps, sessionId, params) {
    const changeUnitId =
      typeof params["changeUnitId"] === "string" && params["changeUnitId"].length > 0
        ? params["changeUnitId"]
        : undefined;
    const updateTest =
      typeof params["updateTest"] === "string" ? params["updateTest"] : undefined;
    await deps.runtime.acceptChanges(sessionId, changeUnitId, updateTest);
  },
  async request_changes(deps, sessionId, params) {
    const instruction =
      typeof params["instruction"] === "string" ? params["instruction"] : undefined;
    await deps.runtime.requestChanges(sessionId, instruction);
  },
  async continue_task(deps, sessionId) {
    await deps.runtime.resume(sessionId);
  },
  async open_terminal(deps, sessionId) {
    const repoPath = deps.repoPath();
    if (repoPath !== null) {
      deps.terminals.ensure(sessionId, repoPath);
    }
    await deps.runtime.openTerminal(sessionId);
  },
  async interrupt_agent(deps, sessionId) {
    await deps.runtime.interrupt(sessionId);
  },
  async pin_surface(deps, sessionId, params) {
    const surfaceId = String(params["surfaceId"] ?? "");
    deps.runtime.pinSurface(sessionId, surfaceId, true);
  },
  async dismiss_surface(deps, sessionId, params) {
    const surfaceId = String(params["surfaceId"] ?? "");
    deps.runtime.dismissSurface(sessionId, surfaceId);
  },
};
