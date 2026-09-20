import { z } from "zod";

import { AgentStateSchema, RendererToMainChannels } from "@jevcode/contracts";

import {
  AGENT_MODEL_OPTIONS,
  REASONING_EFFORT_OPTIONS,
} from "./prefs.js";

export const RendererToMainLocalChannels = {
  repoBrowse: "repo:browse",
  repoListRecent: "repo:listRecent",
  repoListSessions: "repo:listSessions",
  sessionSwitch: "session:switch",
  terminalGetScrollback: "terminal:getScrollback",
  debugListTelemetry: "debug:listTelemetry",
  debugListEvents: "debug:listEvents",
  debugListJevDecisions: "debug:listJevDecisions",
  preferencesGet: "preferences:get",
  preferencesSet: "preferences:set",
} as const;

export const MainToRendererLocalChannels = {
  recentRepos: "repo:recentRepos",
  repoSessions: "repo:sessions",
  debugTelemetry: "debug:telemetry",
  preferencesUpdated: "preferences:updated",
} as const;

export type RendererToMainLocalChannelName =
  (typeof RendererToMainLocalChannels)[keyof typeof RendererToMainLocalChannels];

export type MainToRendererLocalChannelName =
  (typeof MainToRendererLocalChannels)[keyof typeof MainToRendererLocalChannels];

export const RepoBrowsePayloadSchema = z.object({});

export const RepoListRecentPayloadSchema = z.object({
  limit: z.number().int().positive().optional(),
});

export const RepoListSessionsPayloadSchema = z.object({
  repoId: z.string().min(1),
});

export const SessionSwitchPayloadSchema = z.object({
  sessionId: z.string().min(1),
});

// Desktop-side extension of the contracts session:start payload: carries the
// model and approval mode through to the adapter's StartSessionInput. This
// entry overrides the contracts schema in the toMain registry (spread after
// `rendererToMainPayloads`), so the extra fields survive zod validation.
export const SessionStartPayloadSchema = z.object({
  repoId: z.string().min(1),
  prompt: z.string(),
  agentId: z.literal("codex").optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  approvalMode: z.enum(["default", "never", "on-failure"]).optional(),
});

export type SessionStartPayload = z.infer<typeof SessionStartPayloadSchema>;

export const TerminalGetScrollbackPayloadSchema = z.object({
  sessionId: z.string().min(1),
  maxLines: z.number().int().positive().optional(),
});

export const TerminalScrollbackResponseSchema = z.object({
  sessionId: z.string().min(1),
  lines: z.array(z.string()),
});

export type TerminalScrollbackResponse = z.infer<
  typeof TerminalScrollbackResponseSchema
>;

export const DebugListTelemetryPayloadSchema = z.object({
  sessionId: z.string().min(1).optional(),
  limit: z.number().int().positive().optional(),
});

export const DebugListEventsPayloadSchema = z.object({
  sessionId: z.string().min(1).optional(),
  limit: z.number().int().positive().optional(),
});

export const DebugListJevDecisionsPayloadSchema = z.object({
  sessionId: z.string().min(1).optional(),
  limit: z.number().int().positive().optional(),
});

export const StoredEventSummarySchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  seq: z.number().int(),
  type: z.string().min(1),
  ts: z.string(),
  payload: z.record(z.string(), z.unknown()),
});

export type StoredEventSummary = z.infer<typeof StoredEventSummarySchema>;

export const DebugEventsPayloadSchema = z.object({
  events: z.array(StoredEventSummarySchema),
});

export type DebugEventsPayload = z.infer<typeof DebugEventsPayloadSchema>;

export const DebugJevDecisionsPayloadSchema = z.object({
  decisions: z.array(z.record(z.string(), z.unknown())),
});

export type DebugJevDecisionsPayload = z.infer<
  typeof DebugJevDecisionsPayloadSchema
>;

export const LocalTelemetryEventSchema = z.object({
  id: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  ts: z.string(),
});

export type LocalTelemetryEvent = z.infer<typeof LocalTelemetryEventSchema>;

export const RepositorySummarySchema = z.object({
  repoId: z.string().min(1),
  path: z.string().min(1),
  name: z.string(),
  branch: z.string(),
  lastOpenedAt: z.string(),
});

export type RepositorySummary = z.infer<typeof RepositorySummarySchema>;

export const RecentReposPayloadSchema = z.object({
  repositories: z.array(RepositorySummarySchema),
});

export type RecentReposPayload = z.infer<typeof RecentReposPayloadSchema>;

export const SessionSummarySchema = z.object({
  sessionId: z.string().min(1),
  repoId: z.string().min(1),
  prompt: z.string(),
  state: AgentStateSchema,
  startedAt: z.string(),
});

export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const RepoSessionsPayloadSchema = z.object({
  sessions: z.array(SessionSummarySchema),
});

export type RepoSessionsPayload = z.infer<typeof RepoSessionsPayloadSchema>;

export const DebugTelemetryPayloadSchema = z.object({
  events: z.array(LocalTelemetryEventSchema),
});

export type DebugTelemetryPayload = z.infer<typeof DebugTelemetryPayloadSchema>;

const AGENT_MODEL_ENUM = z.enum(AGENT_MODEL_OPTIONS);

const REASONING_EFFORT_ENUM = z.enum(REASONING_EFFORT_OPTIONS);

const BUDGET_FRACTION = z
  .string()
  .regex(/^(0(\.\d+)?|1(\.0+)?)$/, "usage budget fraction must be a 0..1 decimal string");

export const AgentPreferencesSchema = z.object({
  model: AGENT_MODEL_ENUM,
  reasoningEffort: REASONING_EFFORT_ENUM,
  usageBudgetFraction: z.union([BUDGET_FRACTION, z.null()]),
});

export type AgentPreferencesPayload = z.infer<typeof AgentPreferencesSchema>;

export const PreferencesGetPayloadSchema = z.object({});

export const PreferencesSetPayloadSchema = z
  .object({
    model: AGENT_MODEL_ENUM.optional(),
    reasoningEffort: REASONING_EFFORT_ENUM.optional(),
    usageBudgetFraction: z.union([BUDGET_FRACTION, z.null()]).optional(),
  })
  .refine(
    (patch) =>
      patch.model !== undefined ||
      patch.reasoningEffort !== undefined ||
      patch.usageBudgetFraction !== undefined,
    { message: "at least one preference must be set" },
  );

export type PreferencesSetPayload = z.infer<typeof PreferencesSetPayloadSchema>;

export const PreferencesUpdatedPayloadSchema = AgentPreferencesSchema;

export type PreferencesUpdatedPayload = z.infer<
  typeof PreferencesUpdatedPayloadSchema
>;

export const localToMain = {
  [RendererToMainChannels.sessionStart]: SessionStartPayloadSchema,
  [RendererToMainLocalChannels.repoBrowse]: RepoBrowsePayloadSchema,
  [RendererToMainLocalChannels.repoListRecent]: RepoListRecentPayloadSchema,
  [RendererToMainLocalChannels.repoListSessions]: RepoListSessionsPayloadSchema,
  [RendererToMainLocalChannels.sessionSwitch]: SessionSwitchPayloadSchema,
  [RendererToMainLocalChannels.terminalGetScrollback]:
    TerminalGetScrollbackPayloadSchema,
  [RendererToMainLocalChannels.debugListTelemetry]:
    DebugListTelemetryPayloadSchema,
  [RendererToMainLocalChannels.debugListEvents]: DebugListEventsPayloadSchema,
  [RendererToMainLocalChannels.debugListJevDecisions]:
    DebugListJevDecisionsPayloadSchema,
  [RendererToMainLocalChannels.preferencesGet]: PreferencesGetPayloadSchema,
  [RendererToMainLocalChannels.preferencesSet]: PreferencesSetPayloadSchema,
} as const;

export const localFromMain = {
  [MainToRendererLocalChannels.recentRepos]: RecentReposPayloadSchema,
  [MainToRendererLocalChannels.repoSessions]: RepoSessionsPayloadSchema,
  [MainToRendererLocalChannels.debugTelemetry]: DebugTelemetryPayloadSchema,
  [MainToRendererLocalChannels.preferencesUpdated]:
    PreferencesUpdatedPayloadSchema,
} as const;
