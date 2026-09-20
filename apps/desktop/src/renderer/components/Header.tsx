import type { RepoOpenedPayload, SessionStatePayload } from "../payload-types.js";

interface HeaderProps {
  repo: RepoOpenedPayload | null;
  sessionState: SessionStatePayload | null;
  terminalOpen: boolean;
  debugOpen: boolean;
  onOpenRepo: () => void;
  onToggleTerminal: () => void;
  onToggleDebug: () => void;
  onCloseRepo: () => void;
}

function taskStatusLabel(sessionState: SessionStatePayload | null): string {
  if (!sessionState) return "idle";
  switch (sessionState.state) {
    case "starting":
      return "starting";
    case "running":
      return "in progress";
    case "waiting_decision":
      return "awaiting decision";
    case "paused":
      return "paused";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return sessionState.state;
  }
}

function agentStatusLabel(sessionState: SessionStatePayload | null): string {
  if (!sessionState) return "no agent";
  return sessionState.state;
}

export function Header(props: HeaderProps) {
  const { repo, sessionState } = props;
  return (
    <header className="header">
      <div className="header-brand">Jevcode</div>
      <div className="header-repo">
        {repo ? (
          <>
            <span className="repo-name">{repo.path}</span>
            <span className="repo-branch">{repo.branch || "no branch"}</span>
          </>
        ) : (
          <span className="repo-name dim">No repository open</span>
        )}
      </div>
      <div className="header-statuses">
        <span className={`chip agent-${agentStatusLabel(sessionState)}`}>
          {taskStatusLabel(sessionState)}
        </span>
      </div>
      <div className="header-actions">
        <button type="button" onClick={props.onOpenRepo}>
          Open
        </button>
        {repo && (
          <button type="button" onClick={props.onCloseRepo}>
            Close repo
          </button>
        )}
        <button
          type="button"
          className={props.terminalOpen ? "active" : ""}
          onClick={props.onToggleTerminal}
        >
          Terminal
        </button>
        <button
          type="button"
          className={props.debugOpen ? "active" : ""}
          onClick={props.onToggleDebug}
        >
          Inspect
        </button>
      </div>
    </header>
  );
}
