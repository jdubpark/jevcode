import { describe, expect, it } from "vitest";

import {
  canTransition,
  transition,
  type AgentLifecycleEvent,
  type AgentState,
} from "./lifecycle.js";
import type { AgentState as ContractAgentState } from "@jevcode/contracts";

const states: ContractAgentState[] = [
  "starting",
  "running",
  "waiting_decision",
  "paused",
  "completed",
  "failed",
];

const events: AgentLifecycleEvent[] = [
  "agent_started",
  "decision_requested",
  "decision_resolved",
  "interrupted",
  "resumed",
  "completed",
  "failed",
];

describe("agent lifecycle state machine", () => {
  it("covers the documented happy path", () => {
    let s: AgentState = "starting";
    s = transition(s, "agent_started");
    expect(s).toBe("running");
    s = transition(s, "decision_requested");
    expect(s).toBe("waiting_decision");
    s = transition(s, "decision_resolved");
    expect(s).toBe("running");
    s = transition(s, "completed");
    expect(s).toBe("completed");
  });

  it("covers the interrupt/resume path from running and waiting_decision", () => {
    expect(transition("running", "interrupted")).toBe("paused");
    expect(transition("waiting_decision", "interrupted")).toBe("paused");
    expect(transition("paused", "resumed")).toBe("running");
  });

  it("allows terminal events from every non-terminal state", () => {
    expect(transition("starting", "failed")).toBe("failed");
    expect(transition("running", "completed")).toBe("completed");
    expect(transition("running", "failed")).toBe("failed");
    expect(transition("waiting_decision", "completed")).toBe("completed");
    expect(transition("waiting_decision", "failed")).toBe("failed");
    expect(transition("paused", "completed")).toBe("completed");
    expect(transition("paused", "failed")).toBe("failed");
  });

});

describe("agent lifecycle transition matrix", () => {
  const legal: Record<AgentState, AgentLifecycleEvent[]> = {
    starting: ["agent_started", "failed"],
    running: [
      "decision_requested",
      "interrupted",
      "completed",
      "failed",
    ],
    waiting_decision: [
      "decision_resolved",
      "interrupted",
      "completed",
      "failed",
    ],
    paused: ["resumed", "completed", "failed"],
    completed: [],
    failed: [],
  };

  for (const state of states) {
    for (const event of events) {
      const expected = (legal[state] ?? []).includes(event);
      it(`${state} --${event}-> ${expected ? "legal" : "illegal"}`, () => {
        expect(canTransition(state, event)).toBe(expected);
        if (expected) {
          expect(() => transition(state, event)).not.toThrow();
          expect(transition(state, event)).not.toBe(state);
        } else {
          expect(() => transition(state, event)).toThrow(/Illegal/);
        }
      });
    }
  }
});

describe("spec-derived transition matrix (SPEC §10)", () => {
  // Independent expectation list written from SPEC §10 ("Agent Adapter"),
  // not from the implementation table above: the adapter PTY lifecycle is
  // start (agent_started -> running), approval flow (decision_requested ->
  // waiting_decision, decision_resolved -> running), interrupt/resume
  // (interrupted -> paused, resumed -> running), and exit handling
  // (completed/failed from any non-terminal state). Terminal states are
  // absorbing. Any newly-allowed transition must update this list and the
  // spec, so the full-table equality below fails when the implementation
  // silently diverges from the documented machine.
  const specLegal: Record<AgentState, AgentLifecycleEvent[]> = {
    starting: ["agent_started", "failed"],
    running: ["decision_requested", "interrupted", "completed", "failed"],
    waiting_decision: ["decision_resolved", "interrupted", "completed", "failed"],
    paused: ["resumed", "completed", "failed"],
    completed: [],
    failed: [],
  };

  it("allows exactly the SPEC §10 transitions from every state", () => {
    for (const state of states) {
      for (const event of events) {
        const specAllows = (specLegal[state] ?? []).includes(event);
        expect(
          canTransition(state, event),
          `${state} --${event}-> diverges from SPEC §10`,
        ).toBe(specAllows);
      }
    }
  });
});
