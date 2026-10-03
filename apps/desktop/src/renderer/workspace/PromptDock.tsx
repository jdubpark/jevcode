import { agentStateLabel, displayUntrusted } from "@jevcode/trace-viewer/model";
import { useEffect, useRef, useState, type Dispatch } from "react";

import type { AgentInstructionStatePayload, JevcodeApi } from "../../shared/api.js";
import { traceNoteTarget, traceNoteTargetTitle, type ComposerEvent, type ComposerState } from "../components/composer-prefill.js";
import { Glyph } from "../components/glyph.js";
import type { SessionStatePayload } from "../payload-types.js";

export type InstructionMode = "steer" | "queue";
type AgentState = SessionStatePayload["state"];

/** A finished or paused session continues: the text is queued, then the agent resumes. */
export function continuesSession(state: AgentState | null): boolean {
  return state === "completed" || state === "paused" || state === "failed";
}

export interface PromptDockProps {
  bridge: Pick<JevcodeApi, "agent" | "session">;
  sessionId: string;
  state: AgentState | null;
  composer: ComposerState;
  dispatch: Dispatch<ComposerEvent>;
  pending: AgentInstructionStatePayload["pending"];
  /** The held note's session prompt, once known (WorkspaceHost asks repo:listSessions). */
  noteTargetPrompt: string | undefined;
}

/**
 * The prompt line docked under every view (spec §3.1). It is today's composer
 * in a CLI shape: a › glyph, monospace input, Enter for a new line, Cmd+Enter
 * to send, Steer or Queue, Continue on a finished session, queued items above
 * the line, and the held-note notice. Draft rules stay in composerReducer.
 */
export function PromptDock(props: PromptDockProps) {
  const { bridge, sessionId, state, composer, dispatch, pending } = props;
  const [mode, setMode] = useState<InstructionMode>("steer");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const continuing = continuesSession(state);
  const note = composer.held;

  useEffect(() => {
    setError(null);
  }, [sessionId]);

  // Spec §3.7: Cmd+L focuses the prompt line from anywhere in the window.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "l") {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A note that arrived during a send takes focus once the input is enabled again.
  useEffect(() => {
    if (!composer.focusPending) return;
    const element = inputRef.current;
    if (element === null || element.disabled) return;
    element.focus();
    const end = element.value.length;
    element.setSelectionRange(end, end);
    element.scrollTop = element.scrollHeight;
    dispatch({ type: "focusDone" });
  }, [composer.focusPending, sending, sessionId, dispatch]);

  const send = async (): Promise<void> => {
    const text = composer.draft.trim();
    if (text.length === 0 || sending) return;
    const sentDraft = composer.draft;
    setSending(true);
    setError(null);
    try {
      await bridge.agent.sendInstruction(sessionId, text, continuing ? "queue" : mode);
      if (continuing) await bridge.agent.resume(sessionId);
      dispatch({ type: "sent", text: sentDraft });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };

  const toggleAgent = async (): Promise<void> => {
    setError(null);
    try {
      if (state === "running" || state === "starting") await bridge.agent.interrupt(sessionId);
      else if (state === "paused") await bridge.agent.resume(sessionId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const switchToNote = (): void => {
    if (note === null) return;
    setError(null);
    void bridge.session.switchTo(note.note.sessionId).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  const canPause = state === "running" || state === "starting";
  return (
    <section className="prompt-dock" aria-label="Prompt">
      {note !== null ? (
        <p className="dock-note" role="status">
          {note.replaced ? "Newer trace note for another session replaced the earlier one" : "Trace note for another session"}{" "}
          <span className="dock-note-target" title={traceNoteTargetTitle(props.noteTargetPrompt, note.note.sessionId)}>
            ({traceNoteTarget(props.noteTargetPrompt, note.note.sessionId)})
          </span>{" "}
          <button type="button" className="dock-link" onClick={switchToNote}>
            Switch
          </button>{" "}
          <button type="button" className="dock-link dock-link-muted" onClick={() => dispatch({ type: "dismiss" })}>
            Dismiss
          </button>
        </p>
      ) : null}
      {pending.length > 0 ? (
        <ul className="dock-queue" aria-label="Queued instructions">
          {pending.map((item) => (
            <li key={item.id}>
              <Glyph name="clock" />
              <span className="dock-queue-text" title={displayUntrusted(item.text, { multiline: true })}>
                Queued · {displayUntrusted(item.text)}
              </span>
              <button
                type="button"
                className="dock-queue-cancel"
                aria-label="Cancel queued instruction"
                onClick={() => void bridge.agent.cancelInstruction(sessionId, item.id)}
              >
                Cancel
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="dock-line">
        <span className="dock-glyph" aria-hidden="true">
          ›
        </span>
        <textarea
          ref={inputRef}
          className="dock-input"
          aria-label="Guide the agent"
          rows={1}
          placeholder={continuing ? "Ask for a follow-up or revision…" : "Redirect, add a constraint, or ask what the agent is doing…"}
          value={composer.draft}
          disabled={sending}
          onChange={(event) => dispatch({ type: "edit", draft: event.target.value })}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void send();
            }
          }}
        />
      </div>
      <div className="dock-footer">
        {continuing ? (
          <span className="dock-hint">Continues the session</span>
        ) : (
          <button
            type="button"
            className="dock-mode"
            // The name carries the current mode, which the label would otherwise hide (final review C M-2).
            aria-label={`Instruction timing: ${mode === "steer" ? "Steer" : "Queue"}`}
            onClick={() => setMode((current) => (current === "steer" ? "queue" : "steer"))}
          >
            {mode === "steer" ? "Steer" : "Queue"} <span aria-hidden="true">▾</span>
          </button>
        )}
        <span className="dock-shortcut">⌘↵ send</span>
        {state !== null ? (
          <span className={`dock-status dock-status-${state}`}>
            <span className="dock-status-dot" aria-hidden="true" />
            {agentStateLabel(state)}
          </span>
        ) : null}
        {canPause || state === "paused" ? (
          <button type="button" className="dock-pause" onClick={() => void toggleAgent()}>
            {state === "paused" ? "Resume" : "Pause"}
          </button>
        ) : null}
        <button
          type="button"
          className="dock-send"
          disabled={composer.draft.trim().length === 0 || sending}
          onClick={() => void send()}
        >
          {sending ? "Sending…" : continuing ? "Continue" : mode === "steer" ? "Steer agent" : "Add to queue"}
        </button>
      </div>
      {error !== null ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
