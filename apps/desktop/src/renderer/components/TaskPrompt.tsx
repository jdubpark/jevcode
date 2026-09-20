import { useState } from "react";

import type { RepoOpenedPayload } from "../payload-types.js";

interface TaskPromptProps {
  repo: RepoOpenedPayload | null;
  agentLine: string;
  onSubmit: (prompt: string) => void | Promise<void>;
}

export function TaskPrompt(props: TaskPromptProps) {
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const text = prompt.trim();
    if (!props.repo || text.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await props.onSubmit(text);
      setPrompt("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="task-launcher">
      <div className="task-launcher-copy">
        <h1>What are we building?</h1>
        <p>
          Describe the outcome. Jevcode will keep the decisions, changes, and
          verification visible as it works.
        </p>
      </div>
      <div className="task-composer">
      <textarea
        className="task-input"
        placeholder={
          props.repo
            ? "Add rate limiting, stop for the Redis fallback decision, then verify the API behavior…"
            : "Open a repository first"
        }
        disabled={!props.repo || submitting}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void submit();
          }
        }}
      />
        <div className="task-composer-footer">
          <span className="task-agent-line">{props.agentLine}</span>
          <span className="task-shortcut">⌘ ↵</span>
          <button
            type="button"
            className="primary-button"
            disabled={!props.repo || prompt.trim().length === 0 || submitting}
            onClick={() => void submit()}
          >
            {submitting ? "Starting…" : "Start task"}
          </button>
        </div>
        {error !== null ? (
          <p className="form-error" role="alert">{error}</p>
        ) : null}
      </div>
    </section>
  );
}
