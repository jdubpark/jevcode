import { nowIso } from "@jevcode/contracts";
import type { AgentState } from "@jevcode/contracts";
import { SessionStatePayloadSchema } from "@jevcode/contracts";
import type { JevcodeDb } from "@jevcode/storage";
import type { z } from "zod";

import { IpcError } from "../shared/errors.js";

export type SessionStatePayload = z.infer<typeof SessionStatePayloadSchema>;

/**
 * changeUnitCount: the session's change units when the caller already holds them (the pipeline's unit store).
 * Otherwise the counts come from SQL COUNT(*): session:switch must not read and parse every unit and decision of the
 * session it opens (final review B M-3: 32 ms per listChangeUnits at 2,937 units).
 */
export function buildSessionState(
  db: JevcodeDb,
  sessionId: string,
  agentThreadId?: string | null,
  changeUnitCount?: number,
): SessionStatePayload {
  const session = db.getSession(sessionId);
  if (!session) {
    throw new IpcError("UNKNOWN_SESSION", `no session with id ${sessionId}`);
  }
  return {
    sessionId,
    state: session.state,
    changeUnitCount: changeUnitCount ?? db.getChangeUnitCount(sessionId),
    decisionCount: db.getDecisionCount(sessionId),
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
  if (session.state === "failed" || session.state === "completed") {
    // A session that already ended keeps its terminal state.
    db.setSessionEnded(sessionId);
    return buildSessionState(db, sessionId);
  }
  // D10: stop pauses a live session. It stays resumable: no endedAt, and the
  // execution claim is kept for the boot sweep's 24 h window.
  db.setSessionState(sessionId, "paused");
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
