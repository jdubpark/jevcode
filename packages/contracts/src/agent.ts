import { z } from "zod";

import type { NormalizedAgentEvent } from "./agent-events.js";
import type { StructuredDecision } from "./semantic.js";

export const AgentStateSchema = z.enum([
  "starting",
  "running",
  "waiting_decision",
  "paused",
  "completed",
  "failed",
]);

export type AgentState = z.infer<typeof AgentStateSchema>;

export const AgentDetectionSchema = z.object({
  available: z.boolean(),
  version: z.string().optional(),
  path: z.string().optional(),
  error: z.string().optional(),
});

export type AgentDetection = z.infer<typeof AgentDetectionSchema>;

export const StartSessionInputSchema = z.object({
  repoPath: z.string().min(1),
  cwd: z.string().min(1),
  prompt: z.string(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  approvalMode: z.enum(["default", "never", "on-failure"]).optional(),
  env: z.record(z.string(), z.string()),
});

export type StartSessionInput = z.infer<typeof StartSessionInputSchema>;

export const AgentInstructionSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  text: z.string(),
  mode: z.enum(["queue", "steer"]).default("queue"),
});

export type AgentInstruction = z.infer<typeof AgentInstructionSchema>;

export const AgentSessionSchema = z.object({
  sessionId: z.string().min(1),
  agentId: z.literal("codex"),
  repoPath: z.string().min(1),
  cwd: z.string().min(1),
  baseCommit: z.string().optional(),
  startedAt: z.string(),
});

export type AgentSession = z.infer<typeof AgentSessionSchema>;

export type InstructionDeliveryStatus = "delivered" | "queued" | "declined";

export interface CodingAgentAdapter {
  readonly id: "codex";
  detect(): Promise<AgentDetection>;
  startSession(input: StartSessionInput): Promise<AgentSession>;
  sendInstruction(
    input: AgentInstruction,
  ): Promise<void | InstructionDeliveryStatus>;
  sendDecision(input: StructuredDecision): Promise<void>;
  interrupt(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  onEvent(handler: (e: NormalizedAgentEvent) => void): Unsubscribe;
  onExit(handler: (code: number) => void): Unsubscribe;
  getThreadId(): string | null;
}

export type Unsubscribe = () => void;
