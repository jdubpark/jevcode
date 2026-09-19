import { z } from "zod";

const eventBase = {
  sessionId: z.string().min(1),
  ts: z.string(),
};

export const NormalizedAgentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent_started"), ...eventBase, prompt: z.string() }),
  z.object({
    type: z.literal("agent_message"),
    ...eventBase,
    role: z.enum(["assistant", "user"]),
    text: z.string(),
  }),
  z.object({
    type: z.literal("tool_started"),
    ...eventBase,
    tool: z.string().min(1),
    input: z.string(),
  }),
  z.object({
    type: z.literal("tool_completed"),
    ...eventBase,
    tool: z.string().min(1),
    output: z.string(),
  }),
  z.object({
    type: z.literal("command_started"),
    ...eventBase,
    command: z.string().min(1),
  }),
  z.object({
    type: z.literal("command_completed"),
    ...eventBase,
    command: z.string().min(1),
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
  }),
  z.object({ type: z.literal("file_read"), ...eventBase, path: z.string().min(1) }),
  z.object({
    type: z.literal("file_changed"),
    ...eventBase,
    path: z.string().min(1),
  }),
  z.object({
    type: z.literal("approval_requested"),
    ...eventBase,
    command: z.string().min(1),
    rationale: z.string(),
  }),
  z.object({
    type: z.literal("test_started"),
    ...eventBase,
    command: z.string().min(1),
  }),
  z.object({
    type: z.literal("test_completed"),
    ...eventBase,
    command: z.string().min(1),
    exitCode: z.number().int(),
  }),
  z.object({ type: z.literal("agent_waiting"), ...eventBase }),
  z.object({ type: z.literal("agent_completed"), ...eventBase }),
  z.object({ type: z.literal("agent_failed"), ...eventBase, error: z.string() }),
]);

export type NormalizedAgentEvent = z.infer<typeof NormalizedAgentEventSchema>;

export type NormalizedAgentEventType = NormalizedAgentEvent["type"];
