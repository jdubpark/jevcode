import { z } from "zod";

import { NormalizedAgentEventSchema } from "./agent-events.js";
import {
  AgentInstructionSchema,
  AgentStateSchema,
} from "./agent.js";
import {
  JevDecisionLogSchema,
} from "./jev.js";
import {
  JsonRenderSpecPatchSchema,
  JsonRenderSpecSchema,
} from "./json-render.js";
import {
  ChangeUnitSchema,
  DecisionSchema,
  SemanticEventSchema,
  StructuredDecisionSchema,
  ValidationResultSchema,
} from "./semantic.js";
import { ActionRefSchema } from "./ui/actions.js";

export const RendererToMainChannels = {
  repoOpen: "repo:open",
  repoClose: "repo:close",
  sessionStart: "session:start",
  sessionStop: "session:stop",
  agentInterrupt: "agent:interrupt",
  agentResume: "agent:resume",
  agentSendInstruction: "agent:sendInstruction",
  agentCancelInstruction: "agent:cancelInstruction",
  actionInvoke: "action:invoke",
  terminalInput: "terminal:input",
  terminalResize: "terminal:resize",
  surfacePin: "surface:pin",
  surfaceDismiss: "surface:dismiss",
  telemetryFlush: "telemetry:flush",
} as const;

export const MainToRendererChannels = {
  repoOpened: "repo:opened",
  sessionState: "session:state",
  agentEvent: "agent:event",
  agentState: "agent:state",
  agentInstructionState: "agent:instructionState",
  semanticUpdate: "semantic:update",
  changeUnitUpsert: "changeunit:upsert",
  decisionOpen: "decision:open",
  decisionResolved: "decision:resolved",
  validationUpdate: "validation:update",
  uiSpec: "ui:spec",
  uiSpecPatch: "ui:specPatch",
  terminalData: "terminal:data",
  terminalScrollback: "terminal:scrollback",
  jevDebug: "jev:debug",
  telemetryAck: "telemetry:ack",
} as const;

export type RendererToMainChannelName =
  (typeof RendererToMainChannels)[keyof typeof RendererToMainChannels];

export type MainToRendererChannelName =
  (typeof MainToRendererChannels)[keyof typeof MainToRendererChannels];

export const RepoOpenPayloadSchema = z.object({
  path: z.string().min(1),
});

export const RepoClosePayloadSchema = z.object({
  repoId: z.string().min(1),
});

export const RepoOpenedPayloadSchema = z.object({
  repoId: z.string().min(1),
  path: z.string().min(1),
  gitRoot: z.string().min(1),
  branch: z.string(),
  baseCommit: z.string(),
});

export const SessionStartPayloadSchema = z.object({
  repoId: z.string().min(1),
  prompt: z.string(),
  agentId: z.literal("codex").optional(),
});

export const SessionStopPayloadSchema = z.object({
  sessionId: z.string().min(1),
});

export const SessionStatePayloadSchema = z.object({
  sessionId: z.string().min(1),
  state: AgentStateSchema,
  changeUnitCount: z.number().int().nonnegative(),
  decisionCount: z.number().int().nonnegative(),
  agentThreadId: z.string().optional(),
  ts: z.string(),
});

export const AgentControlPayloadSchema = z.object({
  sessionId: z.string().min(1),
});

export const AgentCancelInstructionPayloadSchema = z.object({
  sessionId: z.string().min(1),
  instructionId: z.string().min(1),
});

export const AgentInstructionStatePayloadSchema = z.object({
  sessionId: z.string().min(1),
  pending: z.array(
    z.object({
      id: z.string().min(1),
      mode: z.enum(["queue", "steer"]),
      text: z.string(),
      createdAt: z.string(),
    }),
  ),
});

export const AgentStatePayloadSchema = z.object({
  sessionId: z.string().min(1),
  state: AgentStateSchema,
});

export const ActionInvokePayloadSchema = ActionRefSchema.and(
  z.object({
    surfaceId: z.string().optional(),
  }),
);

export const TerminalInputPayloadSchema = z.object({
  sessionId: z.string().min(1),
  data: z.string(),
});

export const TerminalResizePayloadSchema = z.object({
  sessionId: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

export const TerminalDataPayloadSchema = z.object({
  sessionId: z.string().min(1),
  data: z.string(),
});

export const TerminalScrollbackPayloadSchema = z.object({
  sessionId: z.string().min(1),
  lines: z.array(z.string()),
});

export const SurfacePinPayloadSchema = z.object({
  surfaceId: z.string().min(1),
  pinned: z.boolean(),
});

export const SurfaceDismissPayloadSchema = z.object({
  surfaceId: z.string().min(1),
});

export const SemanticUpdatePayloadSchema = z.object({
  sessionId: z.string().min(1),
  event: SemanticEventSchema,
});

export const ChangeUnitUpsertPayloadSchema = z.object({
  sessionId: z.string().min(1),
  changeUnit: ChangeUnitSchema,
});

export const DecisionOpenPayloadSchema = z.object({
  sessionId: z.string().min(1),
  decision: DecisionSchema,
});

export const DecisionResolvedPayloadSchema = z.object({
  sessionId: z.string().min(1),
  decisionId: z.string().min(1),
  answer: StructuredDecisionSchema,
});

export const ValidationUpdatePayloadSchema = z.object({
  sessionId: z.string().min(1),
  validations: z.array(ValidationResultSchema),
});

export const UiSpecPayloadSchema = z.object({
  sessionId: z.string().min(1),
  surfaceId: z.string().min(1),
  spec: JsonRenderSpecSchema,
});

export const UiSpecPatchPayloadSchema = z.object({
  sessionId: z.string().min(1),
  surfaceId: z.string().min(1),
  patch: JsonRenderSpecPatchSchema,
});

export const JevDebugPayloadSchema = z.object({
  sessionId: z.string().min(1),
  decisions: z.array(JevDecisionLogSchema),
});

export const TelemetryFlushPayloadSchema = z.object({
  sessionId: z.string().optional(),
});

export const TelemetryAckPayloadSchema = z.object({
  count: z.number().int().nonnegative(),
});

export const rendererToMainPayloads = {
  [RendererToMainChannels.repoOpen]: RepoOpenPayloadSchema,
  [RendererToMainChannels.repoClose]: RepoClosePayloadSchema,
  [RendererToMainChannels.sessionStart]: SessionStartPayloadSchema,
  [RendererToMainChannels.sessionStop]: SessionStopPayloadSchema,
  [RendererToMainChannels.agentInterrupt]: AgentControlPayloadSchema,
  [RendererToMainChannels.agentResume]: AgentControlPayloadSchema,
  [RendererToMainChannels.agentSendInstruction]: AgentInstructionSchema,
  [RendererToMainChannels.agentCancelInstruction]: AgentCancelInstructionPayloadSchema,
  [RendererToMainChannels.actionInvoke]: ActionInvokePayloadSchema,
  [RendererToMainChannels.terminalInput]: TerminalInputPayloadSchema,
  [RendererToMainChannels.terminalResize]: TerminalResizePayloadSchema,
  [RendererToMainChannels.surfacePin]: SurfacePinPayloadSchema,
  [RendererToMainChannels.surfaceDismiss]: SurfaceDismissPayloadSchema,
  [RendererToMainChannels.telemetryFlush]: TelemetryFlushPayloadSchema,
} as const;

export const mainToRendererPayloads = {
  [MainToRendererChannels.repoOpened]: RepoOpenedPayloadSchema,
  [MainToRendererChannels.sessionState]: SessionStatePayloadSchema,
  [MainToRendererChannels.agentEvent]: NormalizedAgentEventSchema,
  [MainToRendererChannels.agentState]: AgentStatePayloadSchema,
  [MainToRendererChannels.agentInstructionState]: AgentInstructionStatePayloadSchema,
  [MainToRendererChannels.semanticUpdate]: SemanticUpdatePayloadSchema,
  [MainToRendererChannels.changeUnitUpsert]: ChangeUnitUpsertPayloadSchema,
  [MainToRendererChannels.decisionOpen]: DecisionOpenPayloadSchema,
  [MainToRendererChannels.decisionResolved]: DecisionResolvedPayloadSchema,
  [MainToRendererChannels.validationUpdate]: ValidationUpdatePayloadSchema,
  [MainToRendererChannels.uiSpec]: UiSpecPayloadSchema,
  [MainToRendererChannels.uiSpecPatch]: UiSpecPatchPayloadSchema,
  [MainToRendererChannels.terminalData]: TerminalDataPayloadSchema,
  [MainToRendererChannels.terminalScrollback]: TerminalScrollbackPayloadSchema,
  [MainToRendererChannels.jevDebug]: JevDebugPayloadSchema,
  [MainToRendererChannels.telemetryAck]: TelemetryAckPayloadSchema,
} as const;

export type RendererToMainPayloads = {
  [K in RendererToMainChannelName]: z.infer<
    (typeof rendererToMainPayloads)[K]
  >;
};

export type MainToRendererPayloads = {
  [K in MainToRendererChannelName]: z.infer<
    (typeof mainToRendererPayloads)[K]
  >;
};

export type IpcDirection = "toMain" | "fromMain";

const payloadMaps: Record<IpcDirection, Record<string, z.ZodTypeAny>> = {
  toMain: rendererToMainPayloads,
  fromMain: mainToRendererPayloads,
};

export function getPayloadSchema(
  direction: IpcDirection,
  channel: string,
): z.ZodTypeAny | undefined {
  return payloadMaps[direction][channel];
}

export type ValidationOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export function validatePayload(
  direction: IpcDirection,
  channel: string,
  payload: unknown,
): ValidationOutcome {
  const schema = getPayloadSchema(direction, channel);
  if (schema === undefined) {
    return { ok: false, error: `unknown channel: ${channel}` };
  }
  const result = schema.safeParse(payload);
  if (!result.success) {
    return { ok: false, error: result.error.message };
  }
  return { ok: true, value: result.data };
}

export function allChannelNames(): string[] {
  return [
    ...Object.values(RendererToMainChannels),
    ...Object.values(MainToRendererChannels),
  ];
}
