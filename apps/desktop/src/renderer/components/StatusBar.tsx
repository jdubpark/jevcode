import type { RepoOpenedPayload, SessionStatePayload } from "../payload-types.js";

interface StatusBarProps {
  repo: RepoOpenedPayload | null;
  sessionState: SessionStatePayload | null;
}

export function StatusBar(props: StatusBarProps) {
  const { repo, sessionState } = props;
  return (
    <footer className="status-bar">
      <span className="status-repo">
        {repo ? `${repo.gitRoot} @ ${repo.baseCommit.slice(0, 8) || "no commit"}` : "No repository"}
      </span>
      <span className="status-session">
        {sessionState
          ? `${sessionState.state.replaceAll("_", " ")} · ${sessionState.changeUnitCount} changes · ${sessionState.decisionCount} decisions`
          : "no active session"}
      </span>
    </footer>
  );
}
