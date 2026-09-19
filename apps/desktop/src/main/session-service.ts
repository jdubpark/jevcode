import { nowIso } from "@jevcode/contracts";
import type { AgentState } from "@jevcode/contracts";
import { SessionStatePayloadSchema } from "@jevcode/contracts";
import type { JevcodeDb } from "@jevcode/storage";
import type { z } from "zod";

import { IpcError } from "../shared/errors.js";

export type SessionStatePayload = z.infer<typeof SessionStatePayloadSchema>;

export function buildSessionState(
  db: JevcodeDb,
  sessionId: string,
  agentThreadId?: string | null,
): SessionStatePayload {
  const session = db.getSession(sessionId);
  if (!session) {
    throw new IpcError("UNKNOWN_SESSION", `no session with id ${sessionId}`);
  }
  return {
    sessionId,
    state: session.state,
    changeUnitCount: db.listChangeUnits(sessionId).length,
    decisionCount: db.listDecisions(sessionId).length,
    ...(agentThreadId !== undefined && agentThreadId !== null
      ? { agentThreadId }
      : {}),
    ts: nowIso(),
  };
}

export function startSession(
  db: JevcodeDb,
  repoId: string,
  prompt: string,
  activeSessionId: string,
): SessionStatePayload {
  const session = db.getSession(activeSessionId);
  if (!session || session.repoId !== repoId) {
    throw new IpcError(
      "NO_ACTIVE_SESSION",
      `active session ${activeSessionId} does not belong to repo ${repoId}`,
    );
  }
  db.setSessionPrompt(session.id, prompt);
  db.setSessionState(session.id, "starting");
  return buildSessionState(db, session.id);
}

export function stopSession(
  db: JevcodeDb,
  sessionId: string,
): SessionStatePayload {
  const session = db.getSession(sessionId);
  if (!session) {
    throw new IpcError("UNKNOWN_SESSION", `no session with id ${sessionId}`);
  }
  db.setSessionEnded(sessionId);
  // Preserve a terminal state: a session that already failed or completed
  // keeps that state instead of being rewritten to "completed".
  const terminalState =
    session.state === "failed" || session.state === "completed"
      ? session.state
      : "completed";
  db.setSessionState(sessionId, terminalState);
  return buildSessionState(db, sessionId);
}

export function switchSession(
  db: JevcodeDb,
  sessionId: string,
): SessionStatePayload {
  return buildSessionState(db, sessionId);
}

export function setSessionAgentState(
  db: JevcodeDb,
  sessionId: string,
  state: AgentState,
): void {
  db.setSessionState(sessionId, state);
}

/**
 * Ownership check for agent/terminal/session channels: the renderer may
 * address any sessionId, but main must only act on sessions that belong to
 * the currently open repo.
 */
export function assertSessionInOpenRepo(
  db: JevcodeDb,
  sessionId: string,
  openRepoId: string | null | undefined,
): { sessionId: string; repoId: string } {
  const session = db.getSession(sessionId);
  if (!session) {
    throw new IpcError("UNKNOWN_SESSION", `no session with id ${sessionId}`);
  }
  if (
    openRepoId === null ||
    openRepoId === undefined ||
    session.repoId !== openRepoId
  ) {
    throw new IpcError(
      "NO_ACTIVE_SESSION",
      `session ${sessionId} does not belong to the open repo`,
    );
  }
  return { sessionId, repoId: session.repoId };
}
