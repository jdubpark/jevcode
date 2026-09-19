import { useState } from "react";

import type { RepoOpenedPayload } from "../payload-types.js";

interface TaskPromptProps {
  repo: RepoOpenedPayload | null;
  onSubmit: (prompt: string) => void;
}

export function TaskPrompt(props: TaskPromptProps) {
  const [prompt, setPrompt] = useState("");

  return (
    <section className="panel">
      <h2>Task prompt</h2>
      <textarea
        className="task-input"
        placeholder={
          props.repo
            ? "Describe the task for the agent, e.g. add rate limiting with a fail-open decision"
            : "Open a repository first"
        }
        disabled={!props.repo}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            if (props.repo && prompt.trim().length > 0) {
              props.onSubmit(prompt.trim());
              setPrompt("");
            }
          }
        }}
      />
      <button
        type="button"
        disabled={!props.repo || prompt.trim().length === 0}
        onClick={() => {
          if (props.repo && prompt.trim().length > 0) {
            props.onSubmit(prompt.trim());
            setPrompt("");
          }
        }}
      >
        Start task
      </button>
    </section>
  );
}
