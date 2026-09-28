import { z } from "zod";

const eventBase = {
  sessionId: z.string().min(1),
  ts: z.string(),
  // Minted by the adapter once per agent process (exec or exec resume).
  turnId: z.string().min(1).optional(),
};

// `${turnId}:${item.id}` for Codex. Shared by the start and the completion
// of one call; stamped as sourceCallId on the facts derived from it.
const call = {
  callId: z.string().min(1).optional(),
};

export const AgentInterruptReasonSchema = z.enum(["interrupt", "steer", "stop"]);

export type AgentInterruptReason = z.infer<typeof AgentInterruptReasonSchema>;

export const NormalizedAgentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent_started"), ...eventBase, prompt: z.string() }),
  z.object({
    type: z.literal("agent_message"),
    ...eventBase,
    role: z.enum(["assistant", "user"]),
    text: z.string(),
  }),
  z.object({
    type: z.literal("agent_reasoning"),
    ...eventBase,
    ...call,
    text: z.string(),
  }),
  z.object({
    type: z.literal("tool_started"),
    ...eventBase,
    ...call,
    tool: z.string().min(1),
    input: z.string(),
  }),
  z.object({
    type: z.literal("tool_completed"),
    ...eventBase,
    ...call,
    tool: z.string().min(1),
    output: z.string(),
  }),
  z.object({
    type: z.literal("command_started"),
    ...eventBase,
    ...call,
    command: z.string().min(1),
  }),
  z.object({
    type: z.literal("command_completed"),
    ...eventBase,
    ...call,
    command: z.string().min(1),
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
  }),
  z.object({ type: z.literal("file_read"), ...eventBase, path: z.string().min(1) }),
  z.object({
    type: z.literal("file_changed"),
    ...eventBase,
    ...call,
    path: z.string().min(1),
  }),
  z.object({
    type: z.literal("approval_requested"),
    ...eventBase,
    ...call,
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
  z.object({
    type: z.literal("agent_interrupted"),
    ...eventBase,
    reason: AgentInterruptReasonSchema,
  }),
]);

export type NormalizedAgentEvent = z.infer<typeof NormalizedAgentEventSchema>;

export type NormalizedAgentEventType = NormalizedAgentEvent["type"];
