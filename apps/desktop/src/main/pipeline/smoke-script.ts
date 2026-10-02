import type { NormalizedAgentEvent } from "@jevcode/contracts";

import type { MockAgentScript, MockScriptEntry } from "./mock-agent-adapter.js";
import type { SessionStartOptions } from "./types.js";

export interface SmokeScriptOptions {
  /** Each step is a message, an edit claim, a command start and its completion. */
  steps: number;
  /** Gap before every entry; wider than the 50 ms hint window plus V-1's 50 ms hinted-commit gap, so each append is measured on its own. */
  spacingMs: number;
}

export const SMOKE_SCRIPT_DEFAULTS: SmokeScriptOptions = { steps: 6, spacingMs: 150 };

/** A deterministic mock agent run for the Electron workspace smoke (D-2 screenshots, D-6 append latency). */
export function smokeMockScript(
  input: Pick<SessionStartOptions, "sessionId" | "repoPath" | "prompt">,
  options: SmokeScriptOptions = SMOKE_SCRIPT_DEFAULTS,
): MockAgentScript {
  const sessionId = input.sessionId;
  const base = Date.now();
  let tick = 0;
  const ts = (): string => {
    tick += options.spacingMs;
    return new Date(base + tick).toISOString();
  };
  const agent = (event: NormalizedAgentEvent): MockScriptEntry => ({ kind: "agent", event, delayMs: options.spacingMs });
  const entries: MockScriptEntry[] = [];
  for (let step = 1; step <= options.steps; step += 1) {
    const file = `src/module-${step}.ts`;
    const command = `pnpm test -- module-${step}`;
    entries.push(
      agent({ type: "agent_message", sessionId, role: "assistant", text: `Step ${step}: updating ${file} and checking it.`, ts: ts() }),
      agent({ type: "file_changed", sessionId, path: file, ts: ts() }),
      agent({ type: "command_started", sessionId, command, ts: ts() }),
      agent({
        type: "command_completed",
        sessionId,
        command,
        exitCode: 0,
        stdout: `✓ module-${step} (3 tests)\n`,
        stderr: "",
        ts: ts(),
      }),
    );
  }
  entries.push(agent({ type: "agent_completed", sessionId, ts: ts() }));
  return { sessionId, repoPath: input.repoPath, cwd: input.repoPath, prompt: input.prompt, entries };
}
