import { agentStateLabel, displayUntrusted } from "@jevcode/trace-viewer/model";
import { useEffect, useState } from "react";

import type { RepoOpenedPayload, SessionStatePayload } from "../payload-types.js";

import type { SessionSummary } from "../../shared/local-channels.js";
import { getBridge } from "../bridge.js";
import { Glyph, type GlyphName } from "./glyph.js";
import { relativeAge } from "./relative-time.js";

interface SessionSwitcherProps {
  repo: RepoOpenedPayload | null;
  sessionState: SessionStatePayload | null;
}

const STATE_GLYPH: Record<SessionSummary["state"], GlyphName> = {
  starting: "live",
  running: "live",
  waiting_decision: "fork",
  paused: "pause",
  completed: "check",
  failed: "alert",
};

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

  const now = Date.now();
  return (
    <section className="panel">
      <h2>Sessions</h2>
      {sessions.length === 0 ? (
        <p className="side-empty">No sessions for this repository.</p>
      ) : (
        <ul className="side-list">
          {sessions.map((session) => {
            const active = session.sessionId === props.sessionState?.sessionId;
            const prompt = displayUntrusted(session.prompt || "(no prompt yet)");
            return (
              <li key={session.sessionId}>
                <button
                  type="button"
                  className={`side-row${active ? " on" : ""}`}
                  title={`${prompt} · ${agentStateLabel(session.state)}`}
                  aria-current={active ? "true" : undefined}
                  onClick={() => void bridge.session.switchTo(session.sessionId)}
                >
                  <Glyph name={STATE_GLYPH[session.state]} />
                  <span className="side-label">{prompt}</span>
                  <span className="side-meta">{relativeAge(session.startedAt, now)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
