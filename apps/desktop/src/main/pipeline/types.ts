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
import type { ModelSelector } from "./model-selection.js";

export type AgentMode = "codex" | "mock" | "auto" | "replay";

export type EmitFn = (
  channel: FromMainChannelName,
  payload: FromMainPayload<FromMainChannelName>,
) => void;

/** The person's own shell (TerminalPanel's sh -i). The pipeline may start it, never write to it (spec E7). */
export interface TerminalSink {
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
  modelSelector?: ModelSelector;
  /**
   * Repo files the watcher saw change (file_changed facts), for the explainer stage's
   * incremental rebuild (console-explainer spec §5.1). Errors are logged, never thrown.
   */
  onRepoFilesChanged?: (repoPath: string, paths: readonly string[]) => void;
  /** Script for a mock session started without input.mockScript (the Electron workspace smoke). */
  mockScriptFor?: (input: SessionStartOptions) => MockAgentScript;
  /**
   * Called once per completed sync pass with the session's units and decisions (console-explainer
   * spec §6.1 triggers), never after a pass that a stop ended or that threw; index.ts routes it to the
   * repo's explainer stage. Errors are logged, never thrown.
   */
  onPipelineSync?: (repoPath: string, sync: PipelineSyncSnapshot) => void;
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

/** What the runtime hands the explainer stage after each finished sync (console-explainer spec §6.1). */
export interface PipelineSyncSnapshot {
  sessionId: string;
  /** The session's lastEventSeq when the sync finished. */
  lastSeq: number;
  changeUnits: ChangeUnit[];
  decisions: Decision[];
}

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
