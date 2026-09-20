import type {
  AgentState,
  ChangeUnit,
  Decision,
  EvidenceFact,
  JevDecisionLog,
  NormalizedAgentEvent,
  StructuredDecision,
} from "@jevcode/contracts";
import {
  DecisionSchema,
  EvidenceFactSchema,
  MainToRendererChannels,
  NormalizedAgentEventSchema,
  SemanticEventSchema,
  newId,
  nowIso,
} from "@jevcode/contracts";
import type {
  AgentInstruction,
  AnswerDecisionParams,
  DelegateDecisionParams,
} from "@jevcode/contracts";
import { CodexAdapter } from "@jevcode/agent-codex";
import type { CodingAgentAdapter } from "@jevcode/agent-core";
import { InMemorySink } from "@jevcode/evidence-engine";
import type { InstructionDeliveryResult } from "./instruction-router.js";
import { createJevClient } from "@jevcode/jev-router";
import type { JevClient } from "@jevcode/jev-router";
import { PipelineCoordinator } from "@jevcode/semantic-core";
import type { PipelineRecord, PipelineStores } from "@jevcode/semantic-core";
import { createTelemetryEvent } from "@jevcode/telemetry";
import type { TelemetryEventInput } from "@jevcode/telemetry";

import { IpcError } from "../../shared/errors.js";
import { buildSessionState } from "../session-service.js";
import {
  createEvidenceSession,
  gitDiffFiles,
  type EvidenceSession,
} from "./evidence-runtime.js";
import { runJevStage } from "./jev-stage.js";
import type { JevStageUnitState } from "./types.js";
import { MockAgentAdapter } from "./mock-agent-adapter.js";
import type { MockAgentScript } from "./mock-agent-adapter.js";
import { PlaybackLabels } from "./playback.js";
import { createStorageStores } from "./storage-stores.js";
import {
  compileCallsiteSurface,
  compileChangeUnitSurface,
  compileCompletionSurface,
  compileDecisionSurface,
  compileDiffSurface,
  compileTerminalSurface,
  diffSpecs,
  specHash,
  surfaceIdForDecision,
  surfaceIdForDiff,
  surfaceIdForUnit,
  COMPLETION_SURFACE_ID,
  TERMINAL_SURFACE_ID,
  type UiStageContext,
} from "./ui-stage.js";
import type {
  AgentMode,
  IngestibleRecord,
  PipelineRuntimeOptions,
  SessionStartOptions,
  SurfaceRecord,
} from "./types.js";

const SYNC_DEBOUNCE_MS = 600;

const RESUME_BUDGET = 3;

interface ActiveSession {
  sessionId: string;
  repoId: string;
  repoPath: string;
  prompt: string;
  adapter: CodingAgentAdapter | null;
  adapterKind: "codex" | "mock" | "none";
  coordinator: PipelineCoordinator;
  client: JevClient;
  facts: EvidenceFact[];
  unitState: Map<string, JevStageUnitState & { coreSignature: string }>;
  surfaces: Map<string, SurfaceRecord>;
  openDecisions: Set<string>;
  emittedValidationIds: Set<string>;
  agentState: AgentState;
  interruptedForDecision: boolean;
  threadId: string | null;
  completionEmitted: boolean;
  evidence: EvidenceSession | null;
  syncTimer: ReturnType<typeof setTimeout> | null;
  syncChain: Promise<void>;
  ingestFailures: number;
  stopping: boolean;
  pinned: Set<string>;
  dismissed: Set<string>;
  playbackLabels: PlaybackLabels | null;
}

export class PipelineRuntime {
  private readonly sessions = new Map<string, ActiveSession>();

  private readonly opts: PipelineRuntimeOptions;

  constructor(opts: PipelineRuntimeOptions) {
    this.opts = opts;
  }

  get activeSessions(): string[] {
    return [...this.sessions.keys()];
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async startSession(input: SessionStartOptions): Promise<void> {
    const sessionId = input.sessionId;
    if (this.sessions.has(sessionId)) {
      throw new IpcError(
        "SESSION_NOT_RUNNING",
        `session ${sessionId} is already running`,
      );
    }
    const mode = this.resolveAgentMode(input.agentMode ?? this.opts.agentMode);
    const stores = this.buildStores(sessionId);

    let adapter: CodingAgentAdapter | null = null;
    let adapterKind: ActiveSession["adapterKind"] = "none";

    if (mode === "mock") {
      const script = input.mockScript ?? defaultMockScript(input);
      adapter = new MockAgentAdapter(script, {
        entryDelayMs: 1,
        threadId: input.mockThreadId,
        hooks: {
          onRecord: (record) => {
            this.ingestRecord(sessionId, record);
          },
          onTerminal: (data) => {
            this.opts.terminal?.data(sessionId, data);
          },
        },
      });
      adapterKind = "mock";
    }

    if (mode === "codex" || mode === "auto") {
      const codex = new CodexAdapter({ sessionId: input.sessionId });
      const detection = await codex.detect();
      if (detection.available) {
        adapter = codex;
        adapterKind = "codex";
      } else if (mode === "auto") {
        const script = input.mockScript ?? defaultMockScript(input);
        adapter = new MockAgentAdapter(script, {
          entryDelayMs: 1,
          threadId: input.mockThreadId,
          hooks: {
            onRecord: (record) => {
              this.ingestRecord(sessionId, record);
            },
            onTerminal: (data) => {
              this.opts.terminal?.data(sessionId, data);
            },
          },
        });
        adapterKind = "mock";
        this.log(
          `codex unavailable (${detection.error ?? "not found"}); falling back to mock agent`,
        );
      } else {
        throw new IpcError(
          "NO_AGENT_AVAILABLE",
          `codex is not available on this machine (${detection.error ?? "not found"}). Set JEVC_AGENT=mock for the offline demo.`,
        );
      }
    }

    const session: ActiveSession = {
      sessionId,
      repoId: input.repoId,
      repoPath: input.repoPath,
      prompt: input.prompt,
      adapter,
      adapterKind,
      coordinator: new PipelineCoordinator({ stores }),
      client: this.opts.jevClient ?? createJevClient(),
      facts: [],
      unitState: new Map(),
      surfaces: new Map(),
      openDecisions: new Set(),
      emittedValidationIds: new Set(),
      agentState: "starting",
      interruptedForDecision: false,
      threadId: null,
      completionEmitted: false,
      evidence: null,
      syncTimer: null,
      syncChain: Promise.resolve(),
      ingestFailures: 0,
      stopping: false,
      pinned: new Set(),
      dismissed: new Set(),
      playbackLabels: input.playbackLabels ?? null,
    };
    this.sessions.set(sessionId, session);
    this.log(`session ${sessionId} started (agent: ${adapterKind})`);
    this.opts.db.setExecutionClaim(sessionId, this.nowIso());

    if (this.opts.evidence !== false && adapterKind !== "none") {
      const evidence = createEvidenceSession({
        repoId: input.repoId,
        sessionId,
        repoPath: input.repoPath,
        baseCommit: input.baseCommit,
        sink: new InMemorySink(false),
        onFact: (fact) => {
          this.ingestRecord(sessionId, fact);
        },
        log: (message) => this.log(message),
      });
      session.evidence = evidence;
      void evidence.start().catch((error: unknown) => {
        this.log(`evidence start failed: ${String(error)}`);
      });
    }

    adapter?.onEvent((event) => {
      this.ingestRecord(sessionId, event);
    });
    adapter?.onExit((code) => {
      this.handleAgentExit(session, code);
    });

    this.opts.db.setSessionState(sessionId, "starting");
    await adapter?.startSession({
      repoPath: input.repoPath,
      cwd: input.repoPath,
      prompt: input.prompt,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      approvalMode: input.approvalMode,
      env: {},
    });
    this.emitAgentState(session);
  }

  getIngestFailures(sessionId: string): number {
    return this.sessions.get(sessionId)?.ingestFailures ?? 0;
  }

  getAdapter(sessionId: string): CodingAgentAdapter | null {
    return this.sessions.get(sessionId)?.adapter ?? null;
  }

  ingestRecord(sessionId: string, record: IngestibleRecord): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.stopping) return;
    try {
      this.ingestRecordUnsafe(session, record);
    } catch (error) {
      // Error isolation: one bad record must not take down the pipeline
      // (the adapter's PTY callback has no caller to surface exceptions).
      session.ingestFailures += 1;
      this.log(
        `session ${sessionId}: ingest failed (${recordType(record)}), record dropped: ${String(error)}`,
      );
    }
  }

  private ingestRecordUnsafe(
    session: ActiveSession,
    record: IngestibleRecord,
  ): void {
    const sessionId = session.sessionId;
    if (EvidenceFactSchema.safeParse(record).success) {
      const fact = record as EvidenceFact;
      this.opts.db.appendEvidenceFact(sessionId, fact);
      if (fact.type === "command_executed") {
        this.opts.db.recordCommand(sessionId, {
          command: fact.command,
          exitCode: fact.exitCode,
          isDestructive: fact.isDestructive,
          ts: fact.ts,
        });
      }
      this.recordTelemetry(session, "fact_count", {});
      session.facts.push(fact);
      session.coordinator.ingest(fact);
      this.scheduleSync(session);
      return;
    }
    if (NormalizedAgentEventSchema.safeParse(record).success) {
      const event = record as NormalizedAgentEvent;
      this.opts.db.appendAgentEvent(sessionId, event);
      this.recordTelemetry(session, "agent_event_count", {});
      this.opts.emit(MainToRendererChannels.agentEvent, event);
      const terminalLine = formatAgentEventForTerminal(event);
      if (terminalLine !== null) {
        this.opts.terminal?.data(sessionId, terminalLine);
      }
      session.coordinator.ingest(event);
      this.observeAgentEventForEvidence(session, event);
      this.applyTerminalAgentState(session, event);
      this.scheduleSync(session);
      return;
    }
    if (DecisionSchema.safeParse(record).success) {
      const decision = record as Decision;
      const wasOpen = session.openDecisions.has(decision.id);
      this.opts.db.upsertDecision(decision);
      session.coordinator.ingest(decision);
      if (decision.status === "open" && !wasOpen) {
        session.openDecisions.add(decision.id);
        this.opts.emit(MainToRendererChannels.decisionOpen, {
          sessionId,
          decision,
        });
        if (
          this.opts.interruptAgentOnDecision !== false &&
          session.adapterKind !== "none" &&
          (decision.severity === "required" || decision.severity === "recommended") &&
          session.agentState !== "waiting_decision"
        ) {
          void session.adapter?.interrupt();
          session.agentState = "waiting_decision";
          session.interruptedForDecision = true;
          this.opts.db.setSessionState(sessionId, "waiting_decision");
          this.emitAgentState(session);
        }
      } else if (
        decision.status !== "open" &&
        wasOpen &&
        decision.answer !== undefined
      ) {
        session.openDecisions.delete(decision.id);
        this.opts.emit(MainToRendererChannels.decisionResolved, {
          sessionId,
          decisionId: decision.id,
          answer: decision.answer,
        });
        this.resumeAfterDecision(session);
      }
      this.scheduleSync(session);
      return;
    }
    if (SemanticEventSchema.safeParse(record).success) {
      session.coordinator.ingest(record);
      this.scheduleSync(session);
      return;
    }
    this.log(`session ${sessionId}: dropped unrecognized record`);
  }

  ingestPipelineRecord(sessionId: string, record: PipelineRecord): void {
    this.ingestRecord(sessionId, record as IngestibleRecord);
  }

  async syncAll(): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      await this.syncSession(session);
    }
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    session.stopping = true;
    if (session.syncTimer !== null) {
      clearTimeout(session.syncTimer);
      session.syncTimer = null;
    }
    await session.evidence?.stop();
    await session.adapter?.stop();
    this.sessions.delete(sessionId);
    // Preserve a terminal state: a session that already failed or completed
    // keeps that state instead of being rewritten to "completed".
    const terminalState =
      session.agentState === "failed" || session.agentState === "completed"
        ? session.agentState
        : "completed";
    this.opts.db.setSessionState(sessionId, terminalState);
    this.opts.db.setSessionEnded(sessionId);
    this.opts.db.setExecutionClaim(sessionId, null);
    this.emitAgentState(session);
    this.emitSessionState(sessionId);
    this.log(`session ${sessionId} stopped (state ${terminalState})`);
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await session.adapter?.interrupt();
    session.agentState = "paused";
    this.opts.db.setSessionState(sessionId, "paused");
    this.emitAgentState(session);
    this.emitSessionState(sessionId);
  }

  async resume(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const attempts = this.opts.db.incrementResumeAttempts(sessionId);
    if (attempts >= RESUME_BUDGET) {
      this.log(
        `session ${sessionId}: resume budget exhausted (${attempts} attempt(s)); marking failed`,
      );
      session.agentState = "failed";
      this.opts.db.setSessionState(sessionId, "failed");
      this.opts.db.setSessionEnded(sessionId);
      this.opts.db.setExecutionClaim(sessionId, null);
      this.opts.emit(MainToRendererChannels.agentEvent, {
        type: "agent_failed",
        sessionId,
        error: "resume budget exhausted",
        ts: this.nowIso(),
      });
      this.opts.terminal?.data(
        sessionId,
        "[agent] failed: resume budget exhausted",
      );
      this.emitAgentState(session);
      this.emitSessionState(sessionId);
      return;
    }
    this.refreshThreadId(session);
    await session.adapter?.resume();
    session.agentState = "running";
    session.interruptedForDecision = false;
    this.opts.db.setSessionState(sessionId, "running");
    this.emitAgentState(session);
    this.emitSessionState(sessionId);
  }

  async sendInstruction(
    sessionId: string,
    instruction: AgentInstruction,
  ): Promise<InstructionDeliveryResult> {
    const session = this.requireSession(sessionId);
    this.refreshThreadId(session);
    if (session.adapter === null) return "declined";
    const result: unknown = await session.adapter.sendInstruction(instruction);
    return typeof result === "string" ? (result as InstructionDeliveryResult) : "delivered";
  }

  async pendingInstructionIds(sessionId: string): Promise<string[]> {
    const session = this.requireSession(sessionId);
    const adapter = session.adapter as
      | (CodingAgentAdapter & { pendingInstructions?: () => Promise<string[]> })
      | null;
    if (adapter?.pendingInstructions === undefined) return [];
    return adapter.pendingInstructions();
  }

  async cancelAgentInstruction(
    sessionId: string,
    instructionId: string,
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    const adapter = session.adapter as
      | (CodingAgentAdapter & { cancelInstruction?: (id: string) => Promise<boolean> })
      | null;
    if (adapter?.cancelInstruction !== undefined) {
      await adapter.cancelInstruction(instructionId);
    }
  }

  async answerDecision(
    sessionId: string,
    params: AnswerDecisionParams,
  ): Promise<StructuredDecision> {
    const session = this.requireSession(sessionId);
    const decision = this.opts.db.getDecision(params.decisionId);
    if (decision === undefined || decision.sessionId !== sessionId) {
      throw new IpcError(
        "UNKNOWN_DECISION",
        `no decision ${params.decisionId} in session ${sessionId}`,
      );
    }
    if (decision.status !== "open") {
      throw new IpcError(
        "UNKNOWN_DECISION",
        `decision ${params.decisionId} is ${decision.status}, not open`,
      );
    }
    const structured: StructuredDecision = {
      decisionId: decision.id,
      decision: params.decision,
      evidence: params.evidence ?? decision.evidence,
      instruction: buildDecisionInstruction(decision, params.decision),
    };
    this.refreshThreadId(session);
    await session.adapter?.sendDecision(structured);
    const answered: Decision = { ...decision, status: "answered", answer: structured };
    this.opts.db.upsertDecision(answered);
    session.coordinator.ingest(answered);
    session.openDecisions.delete(decision.id);
    this.recordTelemetry(session, "decision_answered", {});
    this.opts.emit(MainToRendererChannels.decisionResolved, {
      sessionId,
      decisionId: decision.id,
      answer: structured,
    });
    this.resumeAfterDecision(session);
    await this.syncSession(session);
    return structured;
  }

  async delegateDecision(
    sessionId: string,
    params: DelegateDecisionParams,
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    const decision = this.opts.db.getDecision(params.decisionId);
    if (decision === undefined || decision.sessionId !== sessionId) {
      throw new IpcError(
        "UNKNOWN_DECISION",
        `no decision ${params.decisionId} in session ${sessionId}`,
      );
    }
    const structured: StructuredDecision = {
      decisionId: decision.id,
      decision: {},
      evidence: decision.evidence,
      instruction:
        "The developer delegated this decision to you. Choose the option you judge best and continue.",
    };
    await session.adapter?.sendDecision(structured);
    const delegated: Decision = { ...decision, status: "delegated", answer: structured };
    this.opts.db.upsertDecision(delegated);
    session.coordinator.ingest(delegated);
    session.openDecisions.delete(decision.id);
    this.recordTelemetry(session, "decision_delegated", {});
    this.opts.emit(MainToRendererChannels.decisionResolved, {
      sessionId,
      decisionId: decision.id,
      answer: structured,
    });
    this.resumeAfterDecision(session);
    await this.syncSession(session);
  }

  async acceptChanges(
    sessionId: string,
    changeUnitId?: string,
    updateTest?: string,
  ): Promise<void> {
    const units = this.opts.db
      .listChangeUnits(sessionId)
      .filter((unit) => changeUnitId === undefined || unit.id === changeUnitId);
    for (const unit of units) {
      const validated: ChangeUnit = { ...unit, status: "validated" };
      this.opts.db.upsertChangeUnit(validated);
      this.opts.emit(MainToRendererChannels.changeUnitUpsert, {
        sessionId,
        changeUnit: validated,
      });
    }
    if (updateTest !== undefined && updateTest.trim().length > 0) {
      await this.sendInstruction(sessionId, {
        id: newId("instr"),
        sessionId,
        mode: "queue",
        text: `Review feedback: update the tests per "${updateTest}".`,
      });
    }
  }

  async requestChanges(sessionId: string, instruction?: string): Promise<void> {
    await this.sendInstruction(sessionId, {
      id: newId("instr"),
      sessionId,
      mode: "queue",
      text:
        instruction !== undefined && instruction.trim().length > 0
          ? `Review feedback: ${instruction}`
          : "Review feedback: revise the recent changes.",
    });
  }

  async restorePreviousApiSemantics(
    sessionId: string,
    symbol: string,
  ): Promise<void> {
    await this.sendInstruction(sessionId, {
      id: newId("instr"),
      sessionId,
      mode: "queue",
      text: `Restore the previous API semantics of ${symbol}. Keep the surrounding changes but undo the behavioral/contract change to this symbol.`,
    });
  }

  async showExactDiff(sessionId: string, files: readonly string[]): Promise<void> {
    const session = this.requireSession(sessionId);
    const diff = await gitDiffFiles(session.repoPath, files);
    const surfaceId = surfaceIdForDiff(files);
    const spec = compileDiffSurface(files[0] ?? "diff", diff);
    this.emitSurface(session, {
      surfaceId,
      spec,
      specHash: specHash(spec),
      renderedAt: this.nowIso(),
    });
    this.recordTelemetry(session, "diff_opened", {});
  }

  async inspectCallSites(sessionId: string, symbol: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const files = new Set<string>();
    for (const unit of this.opts.db.listChangeUnits(sessionId)) {
      if (unit.symbols.some((entry) => entry.name === symbol)) {
        for (const file of unit.files) files.add(file);
      }
    }
    const surfaceId = `callsites:${symbol}`;
    const spec = compileCallsiteSurface(symbol, [...files]);
    this.emitSurface(session, {
      surfaceId,
      spec,
      specHash: specHash(spec),
      renderedAt: this.nowIso(),
    });
  }

  async openTerminal(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    this.opts.terminal?.ensure(sessionId, session.repoPath);
    const spec = compileTerminalSurface();
    this.emitSurface(session, {
      surfaceId: TERMINAL_SURFACE_ID,
      spec,
      specHash: specHash(spec),
      renderedAt: this.nowIso(),
    });
    this.recordTelemetry(session, "terminal_opened", {});
  }

  pinSurface(sessionId: string, surfaceId: string, pinned: boolean): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    if (pinned) {
      session.pinned.add(surfaceId);
    } else {
      session.pinned.delete(surfaceId);
    }
    this.recordTelemetry(session, "surface_pinned", {});
  }

  dismissSurface(sessionId: string, surfaceId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    session.dismissed.add(surfaceId);
    session.surfaces.delete(surfaceId);
    this.recordTelemetry(session, "surface_dismissed", {});
  }

  snapshotSurfaces(sessionId: string): SurfaceRecord[] {
    const session = this.sessions.get(sessionId);
    return session === undefined ? [] : [...session.surfaces.values()];
  }

  private resolveAgentMode(mode: AgentMode | undefined): AgentMode {
    const envMode = process.env["JEVC_AGENT"];
    if (mode !== undefined) return mode;
    if (
      envMode === "mock" ||
      envMode === "codex" ||
      envMode === "auto" ||
      envMode === "replay"
    ) {
      return envMode;
    }
    return "auto";
  }

  private buildStores(sessionId: string): PipelineStores {
    return createStorageStores(this.opts.db, sessionId, {
      onSemanticEvent: (event) => {
        this.opts.emit(MainToRendererChannels.semanticUpdate, {
          sessionId,
          event,
        });
      },
      persistSemanticEvents: true,
    });
  }

  private observeAgentEventForEvidence(
    session: ActiveSession,
    event: NormalizedAgentEvent,
  ): void {
    if (session.evidence === null) return;
    if (event.type === "command_completed") {
      session.evidence.observeCommand(event.command, event.exitCode);
      if (event.stdout.trim().length > 0) {
        session.evidence.observeTestOutput(event.command, event.stdout);
      }
    }
  }

  private applyTerminalAgentState(
    session: ActiveSession,
    event: NormalizedAgentEvent,
  ): void {
    switch (event.type) {
      case "agent_completed":
        if (session.agentState !== "waiting_decision") {
          this.refreshThreadId(session);
          session.agentState = "completed";
          this.opts.db.setSessionState(session.sessionId, "completed");
          this.opts.db.setSessionEnded(session.sessionId);
          this.opts.db.setExecutionClaim(session.sessionId, null);
          this.emitAgentState(session);
          this.emitSessionState(session.sessionId);
          void this.syncSession(session).then(() => {
            this.emitCompletionSurface(session);
          });
        }
        break;
      case "agent_failed":
        if (session.agentState === "waiting_decision") {
          session.agentState = "paused";
          this.opts.db.setSessionState(session.sessionId, "paused");
          this.emitAgentState(session);
        } else {
          session.agentState = "failed";
          this.opts.db.setSessionState(session.sessionId, "failed");
          this.opts.db.setSessionEnded(session.sessionId);
          this.opts.db.setExecutionClaim(session.sessionId, null);
          this.emitAgentState(session);
          this.emitSessionState(session.sessionId);
        }
        break;
      default:
        break;
    }
  }

  private handleAgentExit(session: ActiveSession, code: number): void {
    if (session.stopping) return;
    this.log(`session ${session.sessionId} agent exited with code ${code}`);
    this.refreshThreadId(session);
    if (session.agentState === "waiting_decision") {
      session.agentState = "paused";
      session.interruptedForDecision = true;
      this.opts.db.setSessionState(session.sessionId, "paused");
      this.emitAgentState(session);
      this.emitSessionState(session.sessionId);
      return;
    }
    if (code === 0 && session.agentState === "running") {
      session.agentState = "completed";
      this.opts.db.setSessionState(session.sessionId, "completed");
      this.opts.db.setSessionEnded(session.sessionId);
      this.opts.db.setExecutionClaim(session.sessionId, null);
      this.emitAgentState(session);
      this.emitSessionState(session.sessionId);
      void this.syncSession(session).then(() => {
        this.emitCompletionSurface(session);
      });
      return;
    }
    if (
      code !== 0 &&
      (session.agentState === "running" || session.agentState === "starting")
    ) {
      // A nonzero exit with no terminal event must not leave the session
      // stuck; default it to failed.
      this.log(
        `session ${session.sessionId} exited nonzero while ${session.agentState}; marking failed`,
      );
      session.agentState = "failed";
      this.opts.db.setSessionState(session.sessionId, "failed");
      this.opts.db.setSessionEnded(session.sessionId);
      this.opts.db.setExecutionClaim(session.sessionId, null);
      this.emitAgentState(session);
      this.emitSessionState(session.sessionId);
    }
  }

  private refreshThreadId(session: ActiveSession): void {
    const threadId = session.adapter?.getThreadId() ?? null;
    if (threadId !== null && threadId !== session.threadId) {
      session.threadId = threadId;
      this.log(`session ${session.sessionId} codex thread id: ${threadId}`);
    }
  }

  private resumeAfterDecision(session: ActiveSession): void {
    if (session.agentState !== "waiting_decision") return;
    this.refreshThreadId(session);
    session.agentState = "running";
    session.interruptedForDecision = false;
    this.opts.db.setSessionState(session.sessionId, "running");
    this.emitAgentState(session);
  }

  private scheduleSync(session: ActiveSession): void {
    if (session.stopping) return;
    if (session.syncTimer !== null) {
      clearTimeout(session.syncTimer);
    }
    session.syncTimer = setTimeout(() => {
      session.syncTimer = null;
      void this.syncSession(session);
    }, SYNC_DEBOUNCE_MS);
  }

  private syncSession(session: ActiveSession): Promise<void> {
    // Serialize syncs per session: the 600ms debounce, answerDecision, and
    // completion paths can all request a sync nearly simultaneously, and a
    // concurrent second pass would re-derive the same Jev calls and emit
    // duplicate ui:spec payloads for the same units.
    if (session.stopping) {
      return session.syncChain;
    }
    session.syncChain = session.syncChain.then(() => this.runSync(session));
    return session.syncChain;
  }

  private async runSync(session: ActiveSession): Promise<void> {
    if (session.stopping) return;
    try {
      session.coordinator.flush();
      const snapshot = session.coordinator.snapshot();
      const ctx = this.buildUiContext(session, snapshot);
      const changedUnits = snapshot.units.filter((unit) => {
        const core = coreSignature(unit);
        const previous = session.unitState.get(unit.id);
        const version = snapshot.decisionVersions.get(unit.id) ?? 1;
        return (
          previous === undefined ||
          previous.coreSignature !== core ||
          previous.version !== version
        );
      });
      if (changedUnits.length > 0) {
        const result = await runJevStage({
          db: this.opts.db,
          coordinator: session.coordinator,
          client: session.client,
          sessionId: session.sessionId,
          taskPrompt: session.prompt,
          facts: session.facts,
          decisions: snapshot.decisions,
          semanticEvents: snapshot.events,
          nowIso: () => this.nowIso(),
          resolveSlug: session.playbackLabels
            ? (files, symbols) => session.playbackLabels?.match(files, symbols)
            : undefined,
          onJevLog: (log) => this.emitJevDebug(session, log),
          onRedaction: (count) => {
            this.recordTelemetry(session, "redaction", { count });
          },
        });
        this.syncOutcomes(session, result, ctx);
      }
      this.emitDecisions(session, ctx);
      this.emitValidations(session);
      this.emitSessionState(session.sessionId);
    } catch (error) {
      this.log(`sync failed for ${session.sessionId}: ${String(error)}`);
    }
  }

  private syncOutcomes(
    session: ActiveSession,
    result: Awaited<ReturnType<typeof runJevStage>>,
    ctx: UiStageContext,
  ): void {
    const snapshot = session.coordinator.snapshot();
    for (const outcome of result.outcomes) {
      const unit = snapshot.units.find(
        (candidate) => candidate.id === outcome.unitId,
      );
      if (unit === undefined) continue;
      const core = coreSignature(unit);
      session.unitState.set(outcome.unitId, {
        ...outcome.state,
        coreSignature: core,
      });
      this.opts.emit(MainToRendererChannels.changeUnitUpsert, {
        sessionId: session.sessionId,
        changeUnit: unit,
      });
      if (!outcome.state.shouldSurface || outcome.intent === undefined) {
        continue;
      }
      const linkedDecision = outcome.intent.representation === "decision"
        ? ctx.decisions.find((decision) =>
            decision.affectedChangeUnits.includes(unit.id) ||
            decision.evidence.some((ref) => unit.evidence.includes(ref)),
          ) ??
          ctx.decisions.find((decision) => decision.status === "open") ??
          ctx.decisions[0]
        : undefined;
      if (outcome.intent.representation === "decision" && linkedDecision === undefined) {
        continue;
      }
      const surfaceId =
        linkedDecision !== undefined
          ? surfaceIdForDecision(linkedDecision.id)
          : surfaceIdForUnit(unit.id);
      if (session.dismissed.has(surfaceId)) continue;
      const spec =
        linkedDecision !== undefined
          ? compileDecisionSurface(linkedDecision, ctx)
          : compileChangeUnitSurface(unit, outcome.intent, ctx);
      const hash = specHash(spec);
      const previous = session.surfaces.get(surfaceId);
      session.surfaces.set(surfaceId, {
        surfaceId,
        spec,
        specHash: hash,
        changeUnitId: unit.id,
        intent: outcome.intent,
        renderedAt: this.nowIso(),
        replaySlug: outcome.replaySlug,
      });
      this.opts.db.upsertUiIntent(session.sessionId, {
        changeUnitId: unit.id,
        intent: outcome.intent,
      });
      this.opts.db.upsertUiSnapshot(session.sessionId, {
        surfaceId,
        changeUnitId: unit.id,
        intent: outcome.intent,
        spec,
      });
      const patch = previous !== undefined ? diffSpecs(previous.spec, spec) : null;
      if (patch !== null) {
        this.opts.emit(MainToRendererChannels.uiSpecPatch, {
          sessionId: session.sessionId,
          surfaceId,
          patch: patch.patch,
        });
      } else {
        this.opts.emit(MainToRendererChannels.uiSpec, {
          sessionId: session.sessionId,
          surfaceId,
          spec,
        });
        this.recordTelemetry(session, "surface_shown", {
          specHash: hash,
          confidence: outcome.intent.confidence,
          renderMode: outcome.intent.renderMode,
        });
      }
    }
  }

  private buildUiContext(
    session: ActiveSession,
    snapshot: ReturnType<PipelineCoordinator["snapshot"]>,
  ): UiStageContext {
    return {
      sessionId: session.sessionId,
      facts: session.facts,
      validations: snapshot.validations,
      failures: snapshot.failures,
      decisions: snapshot.decisions,
      semanticEvents: snapshot.events,
      graphNodes: snapshot.graphNodes,
      graphEdges: snapshot.graphEdges,
      agentEvents: this.opts.db.listAgentEvents(session.sessionId),
      units: snapshot.units,
    };
  }

  private emitCompletionSurface(session: ActiveSession): void {
    if (session.stopping || session.completionEmitted) return;
    session.completionEmitted = true;
    const snapshot = session.coordinator.snapshot();
    const ctx = this.buildUiContext(session, snapshot);
    const spec = compileCompletionSurface(ctx);
    const hash = specHash(spec);
    session.surfaces.set(COMPLETION_SURFACE_ID, {
      surfaceId: COMPLETION_SURFACE_ID,
      spec,
      specHash: hash,
      renderedAt: this.nowIso(),
    });
    this.opts.db.upsertUiSnapshot(session.sessionId, {
      surfaceId: COMPLETION_SURFACE_ID,
      spec,
    });
    this.opts.emit(MainToRendererChannels.uiSpec, {
      sessionId: session.sessionId,
      surfaceId: COMPLETION_SURFACE_ID,
      spec,
    });
    this.recordTelemetry(session, "surface_shown", {
      specHash: hash,
      confidence: 1,
      renderMode: "generic",
    });
  }

  private emitDecisions(session: ActiveSession, ctx: UiStageContext): void {
    const snapshot = session.coordinator.snapshot();
    for (const decision of snapshot.decisions) {
      if (decision.status === "open" && session.openDecisions.has(decision.id)) {
        const surfaceId = surfaceIdForDecision(decision.id);
        const already = session.surfaces.has(surfaceId);
        if (!session.dismissed.has(surfaceId) && !already) {
          const spec = compileDecisionSurface(decision, ctx);
          session.surfaces.set(surfaceId, {
            surfaceId,
            spec,
            specHash: specHash(spec),
            changeUnitId: decision.affectedChangeUnits[0],
            renderedAt: this.nowIso(),
          });
          this.opts.db.upsertUiSnapshot(session.sessionId, {
            surfaceId,
            changeUnitId: decision.affectedChangeUnits[0],
            spec,
          });
          this.opts.emit(MainToRendererChannels.uiSpec, {
            sessionId: session.sessionId,
            surfaceId,
            spec,
          });
        }
        if (
          this.opts.interruptAgentOnDecision !== false &&
          session.adapterKind !== "none" &&
          (decision.severity === "required" || decision.severity === "recommended") &&
          session.agentState !== "waiting_decision"
        ) {
          void session.adapter?.interrupt();
          session.agentState = "waiting_decision";
          session.interruptedForDecision = true;
          this.opts.db.setSessionState(session.sessionId, "waiting_decision");
          this.emitAgentState(session);
        }
      }
    }
  }

  private emitValidations(session: ActiveSession): void {
    const snapshot = session.coordinator.snapshot();
    const fresh = snapshot.validations.filter(
      (validation) => !session.emittedValidationIds.has(validation.id),
    );
    if (fresh.length === 0) return;
    for (const validation of fresh) {
      session.emittedValidationIds.add(validation.id);
    }
    this.opts.emit(MainToRendererChannels.validationUpdate, {
      sessionId: session.sessionId,
      validations: fresh,
    });
  }

  private emitJevDebug(session: ActiveSession, _log: JevDecisionLog): void {
    this.opts.emit(MainToRendererChannels.jevDebug, {
      sessionId: session.sessionId,
      decisions: this.opts.db.latestJevDecisions(session.sessionId, 50),
    });
  }

  private recordTelemetry(
    session: ActiveSession,
    type: TelemetryEventInput["type"],
    payload: Record<string, unknown>,
  ): void {
    let input: TelemetryEventInput;
    switch (type) {
      case "surface_shown": {
        const mode =
          payload["renderMode"] === "autonomous" ||
          payload["renderMode"] === "conservative" ||
          payload["renderMode"] === "generic" ||
          payload["renderMode"] === "suppressed"
            ? payload["renderMode"]
            : "generic";
        input = {
          type,
          specHash: String(payload["specHash"] ?? ""),
          confidence: Number(payload["confidence"] ?? 0),
          renderMode: mode,
        };
        break;
      }
      case "view_switched":
        input = {
          type,
          from: String(payload["from"] ?? ""),
          to: String(payload["to"] ?? ""),
        };
        break;
      case "agent_event_count":
      case "fact_count":
      case "evidence_expanded":
      case "diff_opened":
      case "terminal_opened":
      case "decision_answered":
      case "decision_overridden":
      case "decision_delegated":
      case "surface_dismissed":
      case "surface_pinned":
        input = { type };
        break;
      case "redaction":
        input = { type, count: Number(payload["count"] ?? 0) };
        break;
    }
    const event = createTelemetryEvent(session.sessionId, input);
    const full = event as unknown as Record<string, unknown>;
    const telemetryPayload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(full)) {
      if (key !== "id" && key !== "sessionId" && key !== "ts") {
        telemetryPayload[key] = value;
      }
    }
    this.opts.db.appendTelemetry(event.type, telemetryPayload, session.sessionId);
  }

  private emitAgentState(session: ActiveSession): void {
    this.opts.emit(MainToRendererChannels.agentState, {
      sessionId: session.sessionId,
      state: session.agentState,
    });
  }

  private emitSessionState(sessionId: string): void {
    try {
      const session = this.sessions.get(sessionId);
      this.opts.emit(
        MainToRendererChannels.sessionState,
        buildSessionState(this.opts.db, sessionId, session?.threadId ?? null),
      );
    } catch {
      // session may be mid-teardown
    }
  }

  private emitSurface(session: ActiveSession, record: SurfaceRecord): void {
    session.surfaces.set(record.surfaceId, record);
    this.opts.emit(MainToRendererChannels.uiSpec, {
      sessionId: session.sessionId,
      surfaceId: record.surfaceId,
      spec: record.spec,
    });
    this.opts.db.upsertUiSnapshot(session.sessionId, {
      surfaceId: record.surfaceId,
      changeUnitId: record.changeUnitId,
      intent: record.intent,
      spec: record.spec,
    });
  }

  private requireSession(sessionId: string): ActiveSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new IpcError(
        "SESSION_NOT_RUNNING",
        `no running pipeline session ${sessionId}`,
      );
    }
    return session;
  }

  private nowIso(): string {
    return (this.opts.nowIso ?? nowIso)();
  }

  private log(message: string): void {
    this.opts.log?.(message);
  }
}

function coreSignature(unit: ChangeUnit): string {
  return JSON.stringify({
    files: unit.files,
    symbols: unit.symbols.map((symbol) => symbol.name),
    evidence: unit.evidence,
    status: unit.status,
    depChanges: unit.dependencyChanges,
    schemaChanges: unit.schemaChanges,
    interfacesChanged: unit.interfacesChanged,
  });
}

function buildDecisionInstruction(
  decision: Decision,
  answer: Record<string, string>,
): string {
  const entries = Object.entries(answer)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}: ${value}`);
  return `${decision.title} — the developer chose ${
    entries.length > 0 ? entries.join(", ") : "to delegate"
  }. Continue the task accordingly.`;
}

function formatAgentEventForTerminal(event: NormalizedAgentEvent): string | null {
  switch (event.type) {
    case "agent_message":
      return `[agent] ${event.text.trim()}`;
    case "command_started":
      return `$ ${event.command}`;
    case "command_completed":
      return `(exit ${event.exitCode})`;
    case "file_read":
      return `read ${event.path}`;
    case "file_changed":
      return `changed ${event.path}`;
    case "tool_started":
      return `[tool] ${event.tool}`;
    case "agent_completed":
      return "[agent] completed";
    case "agent_failed":
      return `[agent] failed: ${event.error}`;
    case "approval_requested":
      return `[approval] ${event.command}`;
    default:
      return null;
  }
}

function recordType(record: IngestibleRecord): string {
  if (typeof record !== "object" || record === null) return "unknown";
  const candidate = record as { type?: unknown; kind?: unknown; severity?: unknown };
  if (candidate.severity !== undefined) return "decision";
  if (candidate.kind !== undefined) return "semantic_event";
  if (typeof candidate.type === "string") return candidate.type;
  return "unknown";
}

function defaultMockScript(input: SessionStartOptions): MockAgentScript {
  return {
    sessionId: input.sessionId,
    repoPath: input.repoPath,
    cwd: input.repoPath,
    prompt: input.prompt,
    entries: [
      {
        kind: "agent",
        event: {
          type: "agent_message",
          sessionId: input.sessionId,
          role: "assistant",
          text: `Mock agent running: ${input.prompt}`,
          ts: new Date().toISOString(),
        },
      },
      {
        kind: "agent",
        event: {
          type: "agent_completed",
          sessionId: input.sessionId,
          ts: new Date().toISOString(),
        },
      },
    ],
  };
}
