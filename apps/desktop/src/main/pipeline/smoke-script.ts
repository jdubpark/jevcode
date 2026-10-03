import type { EvidenceFact, NormalizedAgentEvent } from "@jevcode/contracts";

import type { MockAgentScript, MockScriptEntry } from "./mock-agent-adapter.js";
import type { SessionStartOptions } from "./types.js";

export interface SmokeScriptOptions {
  /**
   * Each step is a message, an edit claim with its git_hunk, and a test command (start, completion) with its vitest
   * result, so the session carries evidence like a real one and the viewer reports no missing_evidence gaps.
   */
  steps: number;
  /** Gap before every entry; wider than the 50 ms hint window plus V-1's 50 ms hinted-commit gap, so each append is measured on its own. */
  spacingMs: number;
}

export const SMOKE_SCRIPT_DEFAULTS: SmokeScriptOptions = { steps: 6, spacingMs: 150 };

/** A deterministic mock agent run for the Electron workspace smoke (D-2 screenshots, D-6 append latency). */
export function smokeMockScript(
  input: Pick<SessionStartOptions, "sessionId" | "repoId" | "repoPath" | "prompt">,
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
  // The adapter hands records to the pipeline's ingest, which stores them as evidence_fact rows.
  const record = (fact: EvidenceFact): MockScriptEntry => ({ kind: "record", record: fact, delayMs: options.spacingMs });
  const repoId = input.repoId;
  const entries: MockScriptEntry[] = [];
  for (let step = 1; step <= options.steps; step += 1) {
    const file = `src/module-${step}.ts`;
    const command = `pnpm test -- module-${step}`;
    const callId = `smoke:${step}`;
    entries.push(
      agent({ type: "agent_message", sessionId, role: "assistant", text: `Step ${step}: updating ${file} and checking it.`, ts: ts() }),
      agent({ type: "file_changed", sessionId, path: file, ts: ts() }),
      record({
        type: "git_hunk",
        repoId,
        sessionId,
        ts: ts(),
        file,
        added: 4,
        removed: 1,
        isFormattingOnly: false,
        isConfigOnly: false,
        isLockfile: false,
      }),
      agent({ type: "command_started", sessionId, command, callId, ts: ts() }),
      agent({
        type: "command_completed",
        sessionId,
        command,
        callId,
        exitCode: 0,
        stdout: `✓ module-${step} (3 tests)\n`,
        stderr: "",
        ts: ts(),
      }),
      record({
        type: "test_result",
        repoId,
        sessionId,
        ts: ts(),
        runner: "vitest",
        command,
        passed: 3,
        failed: 0,
        skipped: 0,
        failures: [],
        sourceCallId: callId,
      }),
    );
  }
  entries.push(agent({ type: "agent_completed", sessionId, ts: ts() }));
  return { sessionId, repoPath: input.repoPath, cwd: input.repoPath, prompt: input.prompt, entries };
}
