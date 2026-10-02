import { agentEventLabel, agentStateLabel, truncateMiddle } from "@jevcode/trace-viewer/model";
import { setActionDispatcher } from "@jevcode/ui-catalog";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import type { AgentInstructionStatePayload } from "../../shared/api.js";
import { getBridge } from "../bridge.js";
import type { RepoOpenedPayload, SessionStatePayload } from "../payload-types.js";
import { EmbeddedWorkspace } from "../workspace/EmbeddedWorkspace.js";
import { SurfacesContext, useSessionSurfaces } from "../workspace/session-surfaces.js";
import { composerReducer, initialComposer, traceNoteTarget } from "./composer-prefill.js";
import { TaskPrompt } from "./TaskPrompt.js";

interface WorkspaceHostProps {
  repo: RepoOpenedPayload | null;
  sessionState: SessionStatePayload | null;
  activePrompt: string;
  agentLine: string;
  onStart: (prompt: string) => void | Promise<void>;
}

type InstructionMode = "steer" | "queue";

export function WorkspaceHost(props: WorkspaceHostProps) {
  const bridge = getBridge();
  const sessionId = props.sessionState?.sessionId ?? null;
  const surfaces = useSessionSurfaces(bridge, props.sessionState);
  const { entries, events, recordedFiles } = surfaces;
  const [pending, setPending] = useState<AgentInstructionStatePayload["pending"]>([]);
  const [instructionMode, setInstructionMode] = useState<InstructionMode>("steer");
  const [composer, dispatchComposer] = useReducer(composerReducer, sessionId, initialComposer);
  const instruction = composer.draft;
  const traceNote = composer.held;
  const focusPending = composer.focusPending;
  const noteSessionId = traceNote?.note.sessionId ?? null;
  const repoId = props.repo?.repoId ?? null;
  const [noteTarget, setNoteTarget] = useState<{ sessionId: string; prompt: string | undefined } | null>(null);
  const setInstruction = (draft: string) => dispatchComposer({ type: "edit", draft });
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setActionDispatcher((action, params) => {
      void bridge.action.invoke(action, params);
    });
    return () => {
      setActionDispatcher(undefined);
    };
  }, [bridge]);

  useEffect(() => {
    setPending([]);
    setActionError(null);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return undefined;
    return bridge.onInstructionState((instructionState) => {
      if (instructionState.sessionId === sessionId) setPending(instructionState.pending);
    });
  }, [bridge, sessionId]);

  useEffect(() => {
    if (noteSessionId === null || repoId === null) return undefined;
    let cancelled = false;
    void bridge.repo
      .listSessions(repoId)
      .then((sessions) => {
        if (cancelled) return;
        setNoteTarget({ sessionId: noteSessionId, prompt: sessions.find((s) => s.sessionId === noteSessionId)?.prompt });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bridge, repoId, noteSessionId]);

  // The draft belongs to a session: a switch resets it, then applies a note
  // held for the new session (composerReducer, spec §8.5 of the viewer spec).
  useEffect(() => {
    dispatchComposer({ type: "sessionChanged", sessionId });
  }, [sessionId]);

  useEffect(() => {
    return bridge.onComposerPrefill((payload) => {
      dispatchComposer({ type: "prefill", payload });
    });
  }, [bridge]);

  useEffect(() => {
    if (!focusPending) return;
    const element = composerRef.current;
    if (element === null || element.disabled) return;
    element.focus();
    const end = element.value.length;
    element.setSelectionRange(end, end);
    element.scrollTop = element.scrollHeight;
    dispatchComposer({ type: "focusDone" });
  }, [focusPending, sending, sessionId]);

  // The embedded viewer's "Request changes": the same path as a trace window's note, kept local.
  const onRequestChanges = useCallback(
    (text: string) => {
      if (sessionId !== null) dispatchComposer({ type: "prefill", payload: { sessionId, text } });
    },
    [sessionId],
  );

  const changedFiles = useMemo(() => {
    const files = new Set<string>(recordedFiles);
    for (const event of events) {
      if (event.type === "file_changed") files.add(event.path);
    }
    for (const entry of entries) {
      for (const element of Object.values(entry.surface.spec.elements) as Array<{ props?: Record<string, unknown> }>) {
        const file = element.props?.["file"];
        if (typeof file === "string") files.add(file);
        const elementFiles = element.props?.["files"];
        if (Array.isArray(elementFiles)) {
          for (const item of elementFiles) if (typeof item === "string") files.add(item);
        }
      }
    }
    return [...files];
  }, [entries, events, recordedFiles]);

  const latestAssistant = [...events].reverse().find((event) => event.type === "agent_message" && event.role === "assistant");
  const latestEvent = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === "agent_message" ||
        event.type === "file_changed" ||
        event.type === "test_completed" ||
        event.type === "agent_waiting" ||
        event.type === "agent_completed" ||
        event.type === "agent_failed",
    );
  const state = props.sessionState?.state;

  const sendInstruction = async () => {
    const text = instruction.trim();
    if (!sessionId || text.length === 0 || sending) return;
    const sentDraft = instruction;
    setSending(true);
    setActionError(null);
    try {
      const shouldResume = state === "completed" || state === "paused" || state === "failed";
      await bridge.agent.sendInstruction(sessionId, text, shouldResume ? "queue" : instructionMode);
      if (shouldResume) await bridge.agent.resume(sessionId);
      dispatchComposer({ type: "sent", text: sentDraft });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  const switchToTraceNote = () => {
    const note = traceNote?.note;
    if (note === undefined) return;
    setActionError(null);
    void bridge.session.switchTo(note.sessionId).catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : String(error));
    });
  };

  const toggleAgent = async () => {
    if (!sessionId || !state) return;
    setActionError(null);
    try {
      if (state === "running" || state === "starting") await bridge.agent.interrupt(sessionId);
      else if (state === "paused") await bridge.agent.resume(sessionId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  if (props.activePrompt.trim().length === 0 || sessionId === null) {
    return (
      <section className="workspace workspace-onboarding">
        <TaskPrompt repo={props.repo} agentLine={props.agentLine} onSubmit={props.onStart} />
      </section>
    );
  }

  return (
    <section className="workspace workspace-session">
      <div className="session-main">
        <header className="session-heading">
          <div>
            <div className="session-title-line">
              <h1>Agent workspace</h1>
              {state ? (
                <span className={`session-state session-state-${state}`}>
                  <span className="session-state-dot" />
                  {agentStateLabel(state)}
                </span>
              ) : null}
            </div>
            <p>{props.activePrompt}</p>
          </div>
          {state === "running" || state === "starting" || state === "paused" ? (
            <button type="button" className="quiet-button" onClick={() => void toggleAgent()}>
              {state === "paused" ? "Resume" : "Pause"}
            </button>
          ) : null}
        </header>
        <SurfacesContext.Provider value={surfaces}>
          <EmbeddedWorkspace
            key={sessionId}
            sessionId={sessionId}
            repoRoot={props.repo?.gitRoot ?? null}
            onRequestChanges={onRequestChanges}
          />
        </SurfacesContext.Provider>
        <div className="session-composer">
          {traceNote !== null ? (
            <p className="composer-hint composer-trace-note" role="status">
              {traceNote.replaced
                ? "Newer trace note for another session replaced the earlier one"
                : "Trace note for another session"}{" "}
              <span className="composer-trace-note-target">
                (
                {traceNoteTarget(
                  noteTarget?.sessionId === noteSessionId ? noteTarget?.prompt : undefined,
                  noteSessionId ?? "",
                )}
                )
              </span>{" "}
              ·{" "}
              <button type="button" className="link-button" onClick={switchToTraceNote}>
                Switch
              </button>{" "}
              <button
                type="button"
                className="link-button link-button-muted"
                onClick={() => dispatchComposer({ type: "dismiss" })}
              >
                Dismiss
              </button>
            </p>
          ) : null}
          <textarea
            ref={composerRef}
            aria-label="Guide the agent"
            placeholder={
              state === "completed"
                ? "Ask for a follow-up or revision…"
                : "Redirect, add a constraint, or ask what the agent is doing…"
            }
            value={instruction}
            disabled={!sessionId || sending}
            onChange={(event) => setInstruction(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void sendInstruction();
              }
            }}
          />
          <div className="session-composer-footer">
            {state === "completed" || state === "paused" || state === "failed" ? (
              <span className="composer-hint">This will continue the session</span>
            ) : (
              <div className="instruction-modes" aria-label="Instruction timing">
                <button
                  type="button"
                  aria-pressed={instructionMode === "steer"}
                  onClick={() => setInstructionMode("steer")}
                >
                  Steer now
                </button>
                <button
                  type="button"
                  aria-pressed={instructionMode === "queue"}
                  onClick={() => setInstructionMode("queue")}
                >
                  Queue next
                </button>
              </div>
            )}
            <div className="composer-submit">
              <span className="task-shortcut">⌘ ↵</span>
              <button
                type="button"
                className="primary-button"
                disabled={!sessionId || instruction.trim().length === 0 || sending}
                onClick={() => void sendInstruction()}
              >
                {sending
                  ? "Sending…"
                  : state === "completed" || state === "paused" || state === "failed"
                    ? "Continue"
                    : instructionMode === "steer"
                      ? "Steer agent"
                      : "Add to queue"}
              </button>
            </div>
          </div>
          {actionError !== null ? (
            <p className="form-error" role="alert">{actionError}</p>
          ) : null}
        </div>
      </div>
      <aside className="context-rail" aria-label="Live session context">
        <section>
          <h2>Current context</h2>
          <div className="context-now">
            <span className="context-now-label">Now</span>
            <p>
              {state === "completed"
                ? "Work is complete and ready for review or a follow-up."
                : latestEvent
                  ? agentEventLabel(latestEvent)
                  : "Preparing the session"}
            </p>
          </div>
          {latestAssistant?.type === "agent_message" ? (
            <div className="context-thinking">
              <span>Agent is considering</span>
              <p>{latestAssistant.text}</p>
            </div>
          ) : null}
        </section>

        <section>
          <h2>Session map</h2>
          <dl className="context-stats">
            <div>
              <dt>Changes</dt>
              <dd>{props.sessionState?.changeUnitCount ?? 0}</dd>
            </div>
            <div>
              <dt>Decisions</dt>
              <dd>{props.sessionState?.decisionCount ?? 0}</dd>
            </div>
            <div>
              <dt>Files touched</dt>
              <dd>{changedFiles.length}</dd>
            </div>
          </dl>
        </section>

        {changedFiles.length > 0 ? (
          <section>
            <h2>Files in play</h2>
            <ul className="context-files">
              {changedFiles.slice(0, 8).map((file) => (
                <li key={file} title={file}>{truncateMiddle(file, 48)}</li>
              ))}
            </ul>
          </section>
        ) : null}

        <section>
          <h2>Instruction queue</h2>
          {pending.length === 0 ? (
            <p className="context-empty">Nothing waiting. New direction can be sent immediately.</p>
          ) : (
            <ul className="instruction-queue">
              {pending.map((item) => (
                <li key={item.id}>
                  <span className="instruction-mode">{item.mode === "steer" ? "Steer" : "Next"}</span>
                  <p>{item.text}</p>
                  <button
                    type="button"
                    onClick={() => void bridge.agent.cancelInstruction(sessionId ?? "", item.id)}
                  >
                    Cancel
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
    </section>
  );
}
