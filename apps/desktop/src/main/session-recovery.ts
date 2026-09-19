import type { AgentState } from "@jevcode/contracts";
import type { JevcodeDb } from "@jevcode/storage";

export const STALE_CLAIM_MS = 24 * 60 * 60 * 1000;

export interface SweptSession {
  sessionId: string;
  fromState: AgentState;
  reason: "running_at_boot" | "stale_claim" | "missing_claim";
}

const SWEEP_STATES: readonly AgentState[] = [
  "running",
  "paused",
  "waiting_decision",
];

/**
 * Crash recovery: at boot, no agent process holds any session. A session in
 * "running" state therefore never survived the restart and is failed
 * unconditionally. "paused" and "waiting_decision" sessions are interrupted
 * states; they are kept when their execution claim is fresh (< 24h) so the
 * user can resume them (the codex thread id is preserved on the session row),
 * and failed when the claim is missing or stale.
 */
export function sweepStaleSessions(
  db: JevcodeDb,
  now: Date | string,
): SweptSession[] {
  const nowMs = typeof now === "string" ? Date.parse(now) : now.getTime();
  if (Number.isNaN(nowMs)) {
    throw new TypeError(`sweepStaleSessions: invalid now value ${String(now)}`);
  }
  const swept: SweptSession[] = [];
  for (const session of db.listSessionsByStates([...SWEEP_STATES])) {
    let reason: SweptSession["reason"] | null = null;
    if (session.state === "running") {
      reason = "running_at_boot";
    } else {
      const claim = session.executionClaimTs;
      if (claim === null || claim === "") {
        reason = "missing_claim";
      } else {
        const claimMs = Date.parse(claim);
        if (Number.isNaN(claimMs) || nowMs - claimMs >= STALE_CLAIM_MS) {
          reason = "stale_claim";
        }
      }
    }
    if (reason !== null) {
      db.setSessionState(session.id, "failed");
      db.setExecutionClaim(session.id, null);
      swept.push({ sessionId: session.id, fromState: session.state, reason });
    }
  }
  return swept;
}
