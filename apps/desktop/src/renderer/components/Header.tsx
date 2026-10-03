import { agentStateLabel, displayUntrusted, formatDuration } from "@jevcode/trace-viewer/model";
import { useEffect, useState } from "react";

import type { RepoOpenedPayload, SessionStatePayload } from "../payload-types.js";
import { Glyph } from "./glyph.js";

interface HeaderProps {
  repo: RepoOpenedPayload | null;
  sessionState: SessionStatePayload | null;
  /** The active session's prompt (shown in the breadcrumb) and start time (the chip's elapsed time). */
  sessionPrompt: string;
  sessionStartedAt: string | null;
  terminalOpen: boolean;
  debugOpen: boolean;
  onOpenRepo: () => void;
  onToggleTerminal: () => void;
  onToggleDebug: () => void;
  onCloseRepo: () => void;
  /** Opens the active session's trace window (trace:open). Never switches sessions. */
  onOpenTrace: () => void;
}

const LIVE_STATES: ReadonlySet<string> = new Set(["starting", "running", "waiting_decision"]);

export function repoDisplayName(repo: RepoOpenedPayload): string {
  const trimmed = repo.gitRoot.replace(/[\\/]+$/, "");
  // A repository at the file-system root has no basename; show the root itself.
  const name = trimmed.slice(trimmed.search(/[^\\/]*$/)) || trimmed || repo.gitRoot;
  return displayUntrusted(name);
}

function stateChipText(state: SessionStatePayload, startedAt: string | null, now: number): string {
  const label = agentStateLabel(state.state);
  if (startedAt === null) return label;
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return label;
  const end = LIVE_STATES.has(state.state) ? now : Date.parse(state.ts);
  if (!Number.isFinite(end)) return label;
  return `${label} · ${formatDuration(Math.max(0, end - started))}`;
}

export function Header(props: HeaderProps) {
  const { repo, sessionState } = props;
  const live = sessionState !== null && LIVE_STATES.has(sessionState.state);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!live) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live, sessionState?.sessionId]);

  const prompt = props.sessionPrompt.trim();
  return (
    <header className="header">
      <span className="header-brand">jevcode</span>
      <div className="header-crumb">
        {repo ? (
          <>
            <span className="crumb-repo" title={displayUntrusted(repo.path)}>
              {repoDisplayName(repo)}
            </span>
            {prompt.length > 0 ? (
              <>
                <span className="crumb-sep" aria-hidden="true">
                  /
                </span>
                <span className="crumb-task" title={displayUntrusted(prompt, { multiline: true })}>
                  {displayUntrusted(prompt)}
                </span>
              </>
            ) : null}
          </>
        ) : (
          <span className="crumb-repo">No repository open</span>
        )}
      </div>
      {sessionState ? (
        <span className={`chip agent-${sessionState.state}`}>
          <span className="chip-dot" aria-hidden="true" />
          {stateChipText(sessionState, props.sessionStartedAt, now)}
        </span>
      ) : null}
      <div className="header-actions">
        <button type="button" className="quiet-icon" aria-label="Open" title="Open a repository" onClick={props.onOpenRepo}>
          <Glyph name="folder" />
        </button>
        {repo && (
          <button type="button" className="quiet-icon" aria-label="Close repo" title="Close repository" onClick={props.onCloseRepo}>
            <Glyph name="close" />
          </button>
        )}
        <button
          type="button"
          className={`quiet-icon${props.terminalOpen ? " active" : ""}`}
          aria-label="Terminal"
          aria-pressed={props.terminalOpen}
          title="Terminal"
          onClick={props.onToggleTerminal}
        >
          <Glyph name="term" />
        </button>
        <button
          type="button"
          className={`quiet-icon${props.debugOpen ? " active" : ""}`}
          aria-label="Inspect"
          aria-pressed={props.debugOpen}
          title="Inspect telemetry"
          onClick={props.onToggleDebug}
        >
          <Glyph name="inspect" />
        </button>
        <button
          type="button"
          className="quiet-action"
          onClick={props.onOpenTrace}
          disabled={!props.sessionState}
          title={
            props.sessionState
              ? "Open this session's trace in a new window"
              : "Open a session to see its trace"
          }
        >
          <Glyph name="trace" />
          Trace
        </button>
      </div>
    </header>
  );
}
