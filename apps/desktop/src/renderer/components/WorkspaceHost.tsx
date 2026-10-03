import { setActionDispatcher } from "@jevcode/ui-catalog";
import { useCallback, useEffect, useReducer, useState } from "react";

import type { AgentInstructionStatePayload } from "../../shared/api.js";
import { getBridge } from "../bridge.js";
import type { RepoOpenedPayload, SessionStatePayload } from "../payload-types.js";
import { EmbeddedWorkspace } from "../workspace/EmbeddedWorkspace.js";
import { PromptDock } from "../workspace/PromptDock.js";
import { SurfacesContext, useSessionSurfaces } from "../workspace/session-surfaces.js";
import { composerReducer, initialComposer } from "./composer-prefill.js";
import { TaskPrompt } from "./TaskPrompt.js";

interface WorkspaceHostProps {
  repo: RepoOpenedPayload | null;
  sessionState: SessionStatePayload | null;
  activePrompt: string;
  agentLine: string;
  onStart: (prompt: string) => void | Promise<void>;
}

/**
 * The main window's center column (spec §3.1, §9): TaskPrompt before the first
 * prompt, then the embedded viewer for the active session above the prompt
 * dock. The composer's draft lives here so that both the dock and the viewer's
 * "Request changes" (mainHost) feed the same composerReducer.
 */
export function WorkspaceHost(props: WorkspaceHostProps) {
  const bridge = getBridge();
  const sessionId = props.sessionState?.sessionId ?? null;
  const surfaces = useSessionSurfaces(bridge, props.sessionState);
  const [pending, setPending] = useState<AgentInstructionStatePayload["pending"]>([]);
  const [composer, dispatchComposer] = useReducer(composerReducer, sessionId, initialComposer);
  const noteSessionId = composer.held?.note.sessionId ?? null;
  const repoId = props.repo?.repoId ?? null;
  const [noteTarget, setNoteTarget] = useState<{ sessionId: string; prompt: string | undefined } | null>(null);

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

  useEffect(() => {
    dispatchComposer({ type: "sessionChanged", sessionId });
  }, [sessionId]);

  useEffect(() => {
    return bridge.onComposerPrefill((payload) => {
      dispatchComposer({ type: "prefill", payload });
    });
  }, [bridge]);

  const onRequestChanges = useCallback(
    (text: string) => {
      if (sessionId !== null) dispatchComposer({ type: "prefill", payload: { sessionId, text } });
    },
    [sessionId],
  );

  if (props.activePrompt.trim().length === 0 || sessionId === null) {
    return (
      <section className="workspace workspace-onboarding">
        <TaskPrompt repo={props.repo} agentLine={props.agentLine} onSubmit={props.onStart} />
      </section>
    );
  }

  return (
    <section className="workspace workspace-session">
      <SurfacesContext.Provider value={surfaces}>
        <EmbeddedWorkspace
          key={sessionId}
          sessionId={sessionId}
          repoRoot={props.repo?.gitRoot ?? null}
          onRequestChanges={onRequestChanges}
        />
      </SurfacesContext.Provider>
      <PromptDock
        bridge={bridge}
        sessionId={sessionId}
        state={props.sessionState?.state ?? null}
        composer={composer}
        dispatch={dispatchComposer}
        pending={pending}
        noteTargetPrompt={noteTarget?.sessionId === noteSessionId ? noteTarget?.prompt : undefined}
      />
    </section>
  );
}
