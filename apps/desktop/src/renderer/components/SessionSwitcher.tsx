import { useEffect, useState } from "react";

import type { RepoOpenedPayload, SessionStatePayload } from "../payload-types.js";

import type { SessionSummary } from "../../shared/local-channels.js";
import { getBridge } from "../bridge.js";

interface SessionSwitcherProps {
  repo: RepoOpenedPayload | null;
  sessionState: SessionStatePayload | null;
}

export function SessionSwitcher(props: SessionSwitcherProps) {
  const bridge = getBridge();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);

  useEffect(() => {
    if (!props.repo) {
      setSessions([]);
      return;
    }
    void bridge.repo
      .listSessions(props.repo.repoId)
      .then(setSessions)
      .catch((error: unknown) => {
        console.error("failed to list sessions", error);
      });
  }, [bridge, props.repo, props.sessionState?.ts]);

  if (!props.repo) return null;

  return (
    <section className="panel">
      <h2>Sessions</h2>
      {sessions.length === 0 ? (
        <p className="dim">No sessions for this repository.</p>
      ) : (
        <ul className="session-list">
          {sessions.map((session) => (
            <li key={session.sessionId}>
              <button
                type="button"
                className={
                  session.sessionId === props.sessionState?.sessionId ? "active" : ""
                }
                onClick={() => void bridge.session.switchTo(session.sessionId)}
              >
                <span className="session-prompt">{session.prompt || "(no prompt yet)"}</span>
                <span className="session-meta dim">
                  {session.state} · {new Date(session.startedAt).toLocaleTimeString()}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
