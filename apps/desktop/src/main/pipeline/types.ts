import type {
  AgentState,
  AttentionDecision,
  ChangeUnit,
  Decision,
  EvidenceFact,
  JsonRenderSpec,
  NormalizedAgentEvent,
  SemanticEvent,
  UIIntent,
} from "@jevcode/contracts";
import type { JevClient } from "@jevcode/jev-router";
import type { JevcodeDb } from "@jevcode/storage";

import type { FromMainChannelName, FromMainPayload } from "../../shared/ipc-registry.js";
import type { MockAgentScript } from "./mock-agent-adapter.js";

export type AgentMode = "codex" | "mock" | "auto" | "replay";

export type EmitFn = (
  channel: FromMainChannelName,
  payload: FromMainPayload<FromMainChannelName>,
) => void;

export interface TerminalSink {
  data(sessionId: string, data: string): void;
  ensure(sessionId: string, cwd: string): void;
}

export interface PipelineRuntimeOptions {
  db: JevcodeDb;
  emit: EmitFn;
  agentMode?: AgentMode;
  jevClient?: JevClient;
  evidence?: boolean;
  interruptAgentOnDecision?: boolean;
  terminal?: TerminalSink;
  nowIso?: () => string;
  log?: (message: string) => void;
}

export interface SessionStartOptions {
  sessionId: string;
  repoId: string;
  repoPath: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  approvalMode?: "default" | "never" | "on-failure";
  baseCommit?: string;
  mockScript?: MockAgentScript;
  mockThreadId?: string;
  agentMode?: AgentMode;
  playbackLabels?: PlaybackLabels;
}

import type { PlaybackLabels } from "./playback.js";

export type IngestibleRecord =
  | NormalizedAgentEvent
  | EvidenceFact
  | SemanticEvent
  | Decision;

export interface SurfaceRecord {
  surfaceId: string;
  spec: JsonRenderSpec;
  specHash: string;
  changeUnitId?: string;
  intent?: UIIntent;
  renderedAt: string;
  replaySlug?: string;
}

export interface JevStageUnitState {
  signature: string;
  version: number;
  shouldSurface: boolean;
  attention?: AttentionDecision;
  intent?: UIIntent;
  replaySlug?: string;
}

export interface SessionSummary {
  sessionId: string;
  agentState: AgentState;
  units: ChangeUnit[];
  surfaces: SurfaceRecord[];
}
