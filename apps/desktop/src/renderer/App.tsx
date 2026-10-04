import { useCallback, useEffect, useRef, useState } from "react";

import type { RepoOpenedPayload, SessionStatePayload } from "./payload-types.js";

import {
  DEFAULT_AGENT_PREFERENCES,
  agentSummaryLabel,
} from "../shared/prefs.js";
import type { PreferencesView } from "../shared/prefs.js";
import { getBridge } from "./bridge.js";
import { traceOpenErrorMessage } from "./trace-open-error.js";
import { DebugPanel } from "./components/DebugPanel.js";
import { Glyph } from "./components/glyph.js";
import { Header } from "./components/Header.js";
import { RecentRepos } from "./components/RecentRepos.js";
import { SessionSwitcher } from "./components/SessionSwitcher.js";
import { StatusBar } from "./components/StatusBar.js";
import { TerminalPanel } from "./components/TerminalPanel.js";
import { WorkspaceHost } from "./components/WorkspaceHost.js";
import { SettingsPage } from "./settings/SettingsPage.js";

export function App() {
  const bridge = getBridge();
  const [repo, setRepo] = useState<RepoOpenedPayload | null>(null);
  const [sessionState, setSessionState] = useState<SessionStatePayload | null>(
    null,
  );
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [activePrompt, setActivePrompt] = useState("");
  const [activeStartedAt, setActiveStartedAt] = useState<string | null>(null);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<PreferencesView>(
    DEFAULT_AGENT_PREFERENCES,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRow = useRef<HTMLButtonElement>(null);
  // Back and Esc return focus to the Settings row; a close caused by sidebar navigation leaves focus where it is.
  const focusRowOnClose = useRef(true);
  const closeSettings = useCallback(() => {
    focusRowOnClose.current = true;
    setSettingsOpen(false);
  }, []);
  // Focus goes back to the Settings row once the page has closed (spec: accessibility).
  const settingsWasOpen = useRef(false);
  useEffect(() => {
    if (settingsWasOpen.current && !settingsOpen && focusRowOnClose.current) settingsRow.current?.focus();
    settingsWasOpen.current = settingsOpen;
  }, [settingsOpen]);

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
      setActiveStartedAt(null);
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
        setActiveStartedAt(active?.startedAt ?? null);
      })
      .catch(() => {
        if (!cancelled) {
          setActivePrompt("");
          setActiveStartedAt(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, repo, sessionState?.sessionId]);

  useEffect(() => {
    setTraceError(null);
  }, [sessionState?.sessionId]);

  // Opening another repo or session from the sidebar shows that workspace instead of leaving Settings on top of it.
  // Keyed by id: a live session's continual session:state updates leave Settings open.
  const openRepoId = repo?.repoId ?? null;
  const activeSessionId = sessionState?.sessionId ?? null;
  useEffect(() => {
    focusRowOnClose.current = false;
    setSettingsOpen(false);
  }, [openRepoId, activeSessionId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === "J") {
        event.preventDefault();
        setDebugOpen((open) => !open);
      }
      // Cmd+, (macOS) or Ctrl+, (elsewhere) opens Settings.
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      }
    };
    // Capture phase: while Settings is open, its window capture listener stops keys aimed at <body> so the hidden
    // viewer never sees them; stopPropagation spares other listeners on the same target and phase, so these still run.
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);

  const handleOpenTrace = useCallback(() => {
    const sessionId = sessionState?.sessionId;
    if (!sessionId) return;
    // trace:open only opens or focuses a window; it never calls session.switchTo.
    setTraceError(null);
    void bridge.trace.open(sessionId).catch((error: unknown) => {
      const message = traceOpenErrorMessage(error);
      console.warn(`[jevcode] ${message}`);
      setTraceError(message);
    });
  }, [bridge, sessionState?.sessionId]);

  const handleCloseRepo = useCallback(() => {
    if (repo) {
      void bridge.repo.close(repo.repoId);
      setRepo(null);
      setSessionState(null);
      setActivePrompt("");
      setActiveStartedAt(null);
      setTraceError(null);
    }
  }, [bridge, repo]);

  return (
    <div className="app">
      <Header
        repo={repo}
        sessionState={sessionState}
        sessionPrompt={activePrompt}
        sessionStartedAt={activeStartedAt}
        terminalOpen={terminalOpen}
        debugOpen={debugOpen}
        onOpenRepo={() => void bridge.repo.browse()}
        onToggleTerminal={() => setTerminalOpen((open) => !open)}
        onToggleDebug={() => setDebugOpen((open) => !open)}
        onCloseRepo={handleCloseRepo}
        onOpenTrace={handleOpenTrace}
      />
      <div className="body">
        <aside className="sidebar">
          <RecentRepos selectedRepoId={repo?.repoId ?? null} onSelect={(path) => void bridge.repo.open(path)} />
          <SessionSwitcher repo={repo} sessionState={sessionState} />
          <section className="agent-settings">
            <button
              ref={settingsRow}
              type="button"
              className={`side-row${settingsOpen ? " on" : ""}`}
              data-settings-open=""
              aria-pressed={settingsOpen}
              onClick={() => setSettingsOpen(true)}
            >
              <Glyph name="settings" />
              <span className="side-label">Settings</span>
            </button>
          </section>
        </aside>
        <main className="workspace-column">
          {/* Settings covers the workspace without unmounting it, so Back finds the session view as it was. */}
          <div className="workspace-slot" data-workspace-slot="" hidden={settingsOpen}>
            {traceError !== null ? (
              <p className="form-error" role="alert">{traceError}</p>
            ) : null}
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
          </div>
          {settingsOpen ? (
            <SettingsPage prefs={prefs} onSetPrefs={(patch) => void bridge.prefs.set(patch)} onClose={closeSettings} />
          ) : null}
        </main>
      </div>
      <StatusBar repo={repo} sessionState={sessionState} />
      {debugOpen && (
        <DebugPanel sessionId={sessionState?.sessionId} onClose={() => setDebugOpen(false)} />
      )}
    </div>
  );
}
