import { useCallback, useEffect, useState } from "react";

import type { RepoOpenedPayload, SessionStatePayload } from "./payload-types.js";

import {
  DEFAULT_AGENT_PREFERENCES,
  agentSummaryLabel,
} from "../shared/prefs.js";
import type { AgentPreferences } from "../shared/prefs.js";
import { getBridge } from "./bridge.js";
import { AgentSettings } from "./components/AgentSettings.js";
import { DebugPanel } from "./components/DebugPanel.js";
import { Header } from "./components/Header.js";
import { RecentRepos } from "./components/RecentRepos.js";
import { SessionSwitcher } from "./components/SessionSwitcher.js";
import { StatusBar } from "./components/StatusBar.js";
import { TerminalPanel } from "./components/TerminalPanel.js";
import { WorkspaceHost } from "./components/WorkspaceHost.js";

export function App() {
  const bridge = getBridge();
  const [repo, setRepo] = useState<RepoOpenedPayload | null>(null);
  const [sessionState, setSessionState] = useState<SessionStatePayload | null>(
    null,
  );
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [activePrompt, setActivePrompt] = useState("");
  const [prefs, setPrefs] = useState<AgentPreferences>(
    DEFAULT_AGENT_PREFERENCES,
  );

  useEffect(() => {
    const offRepo = bridge.on("repo:opened", setRepo);
    const offSession = bridge.on("session:state", setSessionState);
    return () => {
      offRepo();
      offSession();
    };
  }, [bridge]);

  useEffect(() => {
    void bridge.prefs.get().then(setPrefs).catch(() => undefined);
    const offPrefs = bridge.onPrefsUpdated(setPrefs);
    return offPrefs;
  }, [bridge]);

  useEffect(() => {
    if (!repo || !sessionState) {
      setActivePrompt("");
      return;
    }
    let cancelled = false;
    void bridge.repo
      .listSessions(repo.repoId)
      .then((sessions) => {
        if (cancelled) return;
        const active = sessions.find(
          (session) => session.sessionId === sessionState.sessionId,
        );
        setActivePrompt(active?.prompt ?? "");
      })
      .catch(() => {
        if (!cancelled) setActivePrompt("");
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, repo, sessionState?.sessionId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === "J") {
        event.preventDefault();
        setDebugOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const handleCloseRepo = useCallback(() => {
    if (repo) {
      void bridge.repo.close(repo.repoId);
      setRepo(null);
      setSessionState(null);
      setActivePrompt("");
    }
  }, [bridge, repo]);

  return (
    <div className="app">
      <Header
        repo={repo}
        sessionState={sessionState}
        terminalOpen={terminalOpen}
        debugOpen={debugOpen}
        onOpenRepo={() => void bridge.repo.browse()}
        onToggleTerminal={() => setTerminalOpen((open) => !open)}
        onToggleDebug={() => setDebugOpen((open) => !open)}
        onCloseRepo={handleCloseRepo}
      />
      <div className="body">
        <aside className="sidebar">
          <RecentRepos onSelect={(path) => void bridge.repo.open(path)} />
          <SessionSwitcher repo={repo} sessionState={sessionState} />
          <AgentSettings prefs={prefs} onSet={(patch) => void bridge.prefs.set(patch)} />
        </aside>
        <main className="workspace-column">
          <WorkspaceHost
            repo={repo}
            sessionState={sessionState}
            activePrompt={activePrompt}
            agentLine={agentSummaryLabel(prefs)}
            onStart={async (prompt) => {
              if (!repo) return;
              await bridge.session.start(repo.repoId, prompt);
              setActivePrompt(prompt);
            }}
          />
          {terminalOpen && (
            <TerminalPanel
              sessionId={sessionState?.sessionId ?? null}
              repoPath={repo?.gitRoot ?? null}
            />
          )}
        </main>
      </div>
      <StatusBar repo={repo} sessionState={sessionState} />
      {debugOpen && (
        <DebugPanel sessionId={sessionState?.sessionId} onClose={() => setDebugOpen(false)} />
      )}
    </div>
  );
}
