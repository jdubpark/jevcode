import { describe, expect, it } from "vitest";

import {
  NormalizedAgentEventSchema,
  type NormalizedAgentEvent,
} from "./agent-events.js";

const sid = "sess_abc";
const ts = "2026-01-15T10:30:00.000Z";

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
