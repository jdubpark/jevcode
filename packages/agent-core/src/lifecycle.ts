import type { AgentState } from "@jevcode/contracts";

export type { AgentState } from "@jevcode/contracts";

export const AGENT_LIFECYCLE_EVENTS = [
  "agent_started",
  "decision_requested",
  "decision_resolved",
  "interrupted",
  "resumed",
  "completed",
  "failed",
] as const;

export type AgentLifecycleEvent = (typeof AGENT_LIFECYCLE_EVENTS)[number];

const transitions: Record<
  AgentState,
  Partial<Record<AgentLifecycleEvent, AgentState>>
> = {
  starting: { agent_started: "running", failed: "failed" },
  running: {
    decision_requested: "waiting_decision",
    interrupted: "paused",
    completed: "completed",
    failed: "failed",
  },
  waiting_decision: {
    decision_resolved: "running",
    interrupted: "paused",
    completed: "completed",
    failed: "failed",
  },
  paused: { resumed: "running", completed: "completed", failed: "failed" },
  completed: {},
  failed: {},
};

export function canTransition(
  state: AgentState,
  event: AgentLifecycleEvent,
): boolean {
  return transitions[state][event] !== undefined;
}

export function transition(
  state: AgentState,
  event: AgentLifecycleEvent,
): AgentState {
  const next = transitions[state][event];
  if (next === undefined) {
    throw new Error(
      `Illegal agent lifecycle transition: ${state} --${event}->`,
    );
  }
  return next;
}
