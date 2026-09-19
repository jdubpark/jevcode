import type { NormalizedAgentEvent } from "@jevcode/contracts";
import type { EventNormalizerContext } from "@jevcode/agent-core";

export interface TranscriptState {
  lastCommand: string;
}

export const initialTranscriptState = (): TranscriptState => ({
  lastCommand: "(unknown)",
});

const COMMAND_START_PATTERN = /^\s*[$>❯]\s+(.+)$/;
const EXIT_CODE_PATTERN = /(?:^|\s)exit code[: ]\s*(-?\d+)/i;
const APPROVAL_PATTERN =
  /approval|approve this|allow (?:this|the) (?:command|action|change)|ask for permission|do you want to proceed/i;

export function parseTranscriptLine(
  line: string,
  ctx: EventNormalizerContext,
  state: TranscriptState,
): { events: NormalizedAgentEvent[]; state: TranscriptState } {
  const text = line.replace(/\r$/, "");
  const nextState = { ...state };

  const commandMatch = text.match(COMMAND_START_PATTERN);
  if (commandMatch !== null) {
    const command = commandMatch[1]!.trim();
    nextState.lastCommand = command;
    return {
      state: nextState,
      events: [
        {
          type: "command_started",
          sessionId: ctx.sessionId,
          command,
          ts: ctx.now(),
        },
      ],
    };
  }

  const exitMatch = text.match(EXIT_CODE_PATTERN);
  if (exitMatch !== null) {
    return {
      state: nextState,
      events: [
        {
          type: "command_completed",
          sessionId: ctx.sessionId,
          command: state.lastCommand,
          exitCode: Number(exitMatch[1]),
          stdout: "",
          stderr: "",
          ts: ctx.now(),
        },
      ],
    };
  }

  if (APPROVAL_PATTERN.test(text)) {
    return {
      state: nextState,
      events: [
        {
          type: "approval_requested",
          sessionId: ctx.sessionId,
          command: state.lastCommand,
          rationale: text.trim(),
          ts: ctx.now(),
        },
      ],
    };
  }

  if (text.trim() === "") {
    return { state: nextState, events: [] };
  }

  return {
    state: nextState,
    events: [
      {
        type: "agent_message",
        sessionId: ctx.sessionId,
        role: "assistant",
        text: text.trim(),
        ts: ctx.now(),
      },
    ],
  };
}
