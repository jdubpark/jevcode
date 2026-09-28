import { describe, expect, it } from "vitest";

import {
  AgentInterruptReasonSchema,
  NormalizedAgentEventSchema,
  type NormalizedAgentEvent,
} from "./agent-events.js";

const sid = "sess_abc";
const ts = "2026-01-15T10:30:00.000Z";
const turnId = "turn_0123456789abcdef0123456789abcdef";
const callId = `${turnId}:item_7`;

const events: NormalizedAgentEvent[] = [
  { type: "agent_started", sessionId: sid, prompt: "Add rate limiting to the public API.", ts },
  { type: "agent_message", sessionId: sid, role: "assistant", text: "I will add rate limiting.", ts },
  { type: "agent_message", sessionId: sid, role: "user", text: "Go ahead.", ts },
  { type: "tool_started", sessionId: sid, tool: "read_file", input: "src/app.ts", ts },
  { type: "tool_completed", sessionId: sid, tool: "write_file", output: "wrote src/app.ts", ts },
  { type: "command_started", sessionId: sid, command: "pnpm test", ts },
  {
    type: "command_completed",
    sessionId: sid,
    command: "pnpm test",
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    ts,
  },
  { type: "file_read", sessionId: sid, path: "src/app.ts", ts },
  { type: "file_changed", sessionId: sid, path: "src/app.ts", ts },
  {
    type: "approval_requested",
    sessionId: sid,
    command: "rm -rf build",
    rationale: "Cleans stale build output",
    ts,
  },
  { type: "test_started", sessionId: sid, command: "vitest run", ts },
  { type: "test_completed", sessionId: sid, command: "vitest run", exitCode: 1, ts },
  { type: "agent_waiting", sessionId: sid, ts },
  { type: "agent_completed", sessionId: sid, ts },
  { type: "agent_failed", sessionId: sid, error: "codex exited unexpectedly", ts },
  {
    type: "agent_reasoning",
    sessionId: sid,
    turnId,
    callId,
    text: "Check the callback first.",
    ts,
  },
  { type: "agent_interrupted", sessionId: sid, turnId, reason: "interrupt", ts },
];

describe("NormalizedAgentEventSchema", () => {
  it("parses every SPEC section 4.1 variant", () => {
    for (const event of events) {
      const result = NormalizedAgentEventSchema.safeParse(event);
      expect(result.success, JSON.stringify(event)).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe(event.type);
        expect(result.data.sessionId).toBe(sid);
      }
    }
  });

  it("rejects an unknown event type", () => {
    const result = NormalizedAgentEventSchema.safeParse({
      type: "agent_teleported",
      sessionId: sid,
      ts,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing sessionId", () => {
    const result = NormalizedAgentEventSchema.safeParse({
      type: "agent_completed",
      ts,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid agent_message role", () => {
    const result = NormalizedAgentEventSchema.safeParse({
      type: "agent_message",
      sessionId: sid,
      role: "system",
      text: "hidden",
      ts,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a command_completed without stdout/stderr", () => {
    const result = NormalizedAgentEventSchema.safeParse({
      type: "command_completed",
      sessionId: sid,
      command: "ls",
      exitCode: 0,
      ts,
    });
    expect(result.success).toBe(false);
  });
});

describe("trace identity fields and lifecycle variants", () => {
  const CALL_TYPES = new Set([
    "tool_started",
    "tool_completed",
    "command_started",
    "command_completed",
    "file_changed",
    "approval_requested",
  ]);

  it("keeps turnId on every variant and callId on the six call variants", () => {
    for (const event of events) {
      const withIds = CALL_TYPES.has(event.type) ? { ...event, turnId, callId } : { ...event, turnId };
      const parsed = NormalizedAgentEventSchema.parse(withIds);
      // zod strips undeclared keys silently; equality proves nothing was dropped.
      expect(parsed, event.type).toEqual(withIds);
    }
  });

  it("parses agent_reasoning with and without a callId", () => {
    const reasoning = { type: "agent_reasoning", sessionId: sid, turnId, text: "Check the callback first.", ts };
    expect(NormalizedAgentEventSchema.parse(reasoning)).toEqual(reasoning);
    expect(NormalizedAgentEventSchema.parse({ ...reasoning, callId })).toEqual({ ...reasoning, callId });
  });

  it("parses agent_interrupted for interrupt, steer and stop", () => {
    expect(AgentInterruptReasonSchema.options).toEqual(["interrupt", "steer", "stop"]);
    for (const reason of AgentInterruptReasonSchema.options) {
      const event = { type: "agent_interrupted", sessionId: sid, reason, ts };
      expect(NormalizedAgentEventSchema.parse(event)).toEqual(event);
    }
  });

  it("rejects an unknown interrupt reason", () => {
    const result = NormalizedAgentEventSchema.safeParse({
      type: "agent_interrupted",
      sessionId: sid,
      reason: "cancel",
      ts,
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty turnId and callId", () => {
    const base = { type: "command_started", sessionId: sid, command: "pnpm test", ts };
    expect(NormalizedAgentEventSchema.safeParse({ ...base, turnId: "" }).success).toBe(false);
    expect(NormalizedAgentEventSchema.safeParse({ ...base, callId: "" }).success).toBe(false);
  });

  it("covers every discriminator in NormalizedAgentEventSchema (a new variant must be added here)", () => {
    const fixtureTypes = new Set(events.map((event) => event.type));
    const schemaTypes = new Set(NormalizedAgentEventSchema.optionsMap.keys());
    expect(fixtureTypes).toEqual(schemaTypes);
  });
});
