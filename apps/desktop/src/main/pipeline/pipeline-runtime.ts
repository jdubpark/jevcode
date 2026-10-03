import type {
  AgentState,
  ChangeUnit,
  Decision,
  EvidenceFact,
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
  defaultModelSelector,
  type ModelSelectionResult,
} from "./model-selection.js";
import { createMainSlicer, type MainSlicer } from "./main-slicer.js";
import { resolveSessionModelSelection } from "./model-resolution.js";
import { deriveRepoContext } from "./repo-context.js";
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

/** Thrown by a pass's pace() once its session is stopped: the pass ends there and writes nothing more. */
class PassStopped extends Error {
  constructor() {
    super("session stopped during the sync pass");
  }
}

interface Slicer {
  /**
   * Yields through the main slicer once this event-loop turn's shared budget (MAIN_SLICE_MS) is spent, calling
   * beforeYield first, so IPC, the renderer's rows requests among it, is answered during a long pass (spec §6.1,
   * lane 03 PL-2; one slicer for the pass and the session explainer since lane 07 PL-3). Then throws PassStopped if
   * the session has been stopped, whether during this yield or during an earlier await.
   */
  pace(): Promise<void>;
  /** How many times pace() has yielded. */
  readonly yields: number;
}

function createSlicer(main: MainSlicer, isStopped: () => boolean, beforeYield: () => void): Slicer {
  let yields = 0;
  return {
    async pace() {
      if (main.spent()) {
        beforeYield();
        await main.yield();
        yields += 1;
      }
      if (isStopped()) throw new PassStopped();
    },
    get yields() {
      return yields;
    },
  };
}

const RESUME_BUDGET = 3;

interface ActiveSession {
  sessionId: string;
  repoId: string;
  repoPath: string;
  prompt: string;
  adapter: CodingAgentAdapter | null;
  adapterKind: "codex" | "mock" | "none";
  coordinator: PipelineCoordinator;
  /** The coordinator's stores: the session state counts the change units the unit store already holds (PL-3). */
  stores: PipelineStores;
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
  // Stopped with `teardown: false`: registered but inert (`stopping` set,
  // evidence paused) until unpark() runs.
  parked: boolean;
  pinned: Set<string>;
  dismissed: Set<string>;
  playbackLabels: PlaybackLabels | null;
}

export class PipelineRuntime {
  private readonly sessions = new Map<string, ActiveSession>();

  private readonly opts: PipelineRuntimeOptions;

  private readonly slicer: MainSlicer;

  constructor(opts: PipelineRuntimeOptions) {
    this.opts = opts;
    this.slicer = opts.slicer ?? createMainSlicer();
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
      const script = input.mockScript ?? this.opts.mockScriptFor?.(input) ?? defaultMockScript(input);
      adapter = new MockAgentAdapter(script, {
        entryDelayMs: 1,
        threadId: input.mockThreadId,
        hooks: {
          onRecord: (record) => {
            this.ingestRecord(sessionId, record);
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
        const script = input.mockScript ?? this.opts.mockScriptFor?.(input) ?? defaultMockScript(input);
        adapter = new MockAgentAdapter(script, {
          entryDelayMs: 1,
          threadId: input.mockThreadId,
          hooks: {
            onRecord: (record) => {
              this.ingestRecord(sessionId, record);
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

    let startModel =
      input.model ?? process.env["JEVCODE_CODEX_MODEL"] ?? undefined;
    let startEffort =
      input.reasoningEffort ??
      process.env["JEVCODE_CODEX_REASONING_EFFORT"] ??
      undefined;
    let modelSelection: ModelSelectionResult | null = null;

    if (adapterKind === "codex") {
      const resolution = await resolveSessionModelSelection(
        {
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          prompt: input.prompt,
          repoPath: input.repoPath,
        },
        {
          env: (key) => process.env[key],
          getPreference: (key) => this.opts.db.getPreference(key),
          deriveContext: deriveRepoContext,
          select: this.opts.modelSelector ?? defaultModelSelector,
        },
      );
      startModel = resolution.model;
      startEffort = resolution.reasoningEffort;
      modelSelection = resolution.selection;
    }

    const session: ActiveSession = {
      sessionId,
      repoId: input.repoId,
      repoPath: input.repoPath,
      prompt: input.prompt,
      adapter,
      adapterKind,
      coordinator: new PipelineCoordinator({ stores, onRebuildError: (error) => this.log(`pipeline rebuild failed (retried on the next sync): ${String(error)}`) }),
      stores,
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
      parked: false,
      pinned: new Set(),
      dismissed: new Set(),
      playbackLabels: input.playbackLabels ?? null,
    };
    this.sessions.set(sessionId, session);
    this.log(
      `session ${sessionId} started (agent: ${adapterKind}${
        startModel !== undefined ? `, model: ${startModel}` : ""
      }${
        startEffort !== undefined ? `, effort: ${startEffort}` : ""
      }${modelSelection !== null ? ", model: auto-selected" : ""})`,
    );
    this.opts.db.setExecutionClaim(sessionId, this.nowIso());

    if (modelSelection !== null) {
      this.recordTelemetry(session, "model_selected", {
        modelId: startModel,
        reasoningEffort: startEffort,
        tier: modelSelection.tier,
        auto: true,
        confidence: modelSelection.confidence,
        rationale: modelSelection.rationale,
        contextTokensEstimate: modelSelection.contextTokensEstimate,
      });
    }

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

    this.ensureSessionRow(sessionId, input);
    this.opts.db.setSessionState(sessionId, "starting");
    await adapter?.startSession({
      repoPath: input.repoPath,
      cwd: input.repoPath,
      prompt: input.prompt,
      model: startModel,
      reasoningEffort: startEffort,
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
      this.ingestIntoCoordinator(session, fact);
      if (fact.type === "file_changed") this.notifyRepoFilesChanged(session, fact.path);
      this.scheduleSync(session);
      return;
    }
    if (NormalizedAgentEventSchema.safeParse(record).success) {
      const event = record as NormalizedAgentEvent;
      this.opts.db.appendAgentEvent(sessionId, event);
      this.recordTelemetry(session, "agent_event_count", {});
      this.opts.emit(MainToRendererChannels.agentEvent, event);
      this.ingestIntoCoordinator(session, event);
      this.observeAgentEventForEvidence(session, event);
      this.applyTerminalAgentState(session, event);
      this.scheduleSync(session);
      return;
    }
    if (DecisionSchema.safeParse(record).success) {
      const decision = record as Decision;
      const wasOpen = session.openDecisions.has(decision.id);
      this.opts.db.upsertDecision(decision);
      this.ingestIntoCoordinator(session, decision);
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
      this.ingestIntoCoordinator(session, record);
      this.scheduleSync(session);
      return;
    }
    this.log(`session ${sessionId}: dropped unrecognized record`);
  }

  /**
   * The coordinator keeps a record whose ingest flushed a window and threw in that window's rebuild, and runs the
   * rebuild again at the next flush (scheduleSync). So the failure is logged here and the record's other steps still
   * run: agent_completed still ends the turn, a decision still opens, an answered decision still resumes the agent
   * (lane 03 fix wave I-2).
   */
  private ingestIntoCoordinator(session: ActiveSession, record: PipelineRecord): void {
    try {
      session.coordinator.ingest(record);
    } catch (error) {
      session.ingestFailures += 1;
      this.log(
        `session ${session.sessionId}: rebuild failed while ingesting ${recordType(record as IngestibleRecord)}; the record is kept and the next sync retries: ${String(error)}`,
      );
    }
  }

  ingestPipelineRecord(sessionId: string, record: PipelineRecord): void {
    this.ingestRecord(sessionId, record as IngestibleRecord);
  }

  async syncAll(): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      await this.syncSession(session);
    }
  }

  /**
   * Stops a session's agent. A live session is paused, not ended (D10): the
   * runtime records `agent_interrupted {reason: "stop"}`, stores `paused` and
   * keeps the execution claim. With `teardown: false` (the user's Stop) a
   * paused session stays registered with its adapter, which keeps the Codex
   * thread id, so `resume()` can relaunch it; its evidence collection pauses
   * until then. `teardown: true`, the default (repo close, the replay CLI and
   * soak), releases the session as before.
   */
  /**
   * The app is quitting (index.ts will-quit) and the database closes next. Every session stops at once and writes
   * nothing more: a pass waiting at a slicer yield, or on a Jev client, ends at its next slice check (PassStopped)
   * without touching the database, ingestion drops records, sync timers are cleared, and the agent and the evidence
   * collector are told to stop without waiting for them. Sessions keep the state the database holds; the boot sweep
   * (session-recovery.ts) settles them at the next start. Synchronous, so the database can close right after it.
   */
  shutdown(): void {
    for (const session of this.sessions.values()) {
      session.stopping = true;
      if (session.syncTimer !== null) {
        clearTimeout(session.syncTimer);
        session.syncTimer = null;
      }
      for (const [what, stop] of [
        ["evidence", () => session.evidence?.stop()],
        ["agent", () => session.adapter?.stop()],
      ] as const) {
        try {
          void Promise.resolve(stop()).catch((error: unknown) => this.log(`quit: ${what} stop failed: ${String(error)}`));
        } catch (error) {
          this.log(`quit: ${what} stop failed: ${String(error)}`);
        }
      }
    }
  }

  async stopSession(
    sessionId: string,
    opts: { teardown?: boolean } = {},
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    // D10: stopping a live session pauses it (resumable). Record why before
    // `stopping` makes ingestRecord drop records.
    const pausing =
      session.agentState !== "completed" && session.agentState !== "failed";
    const keep = pausing && opts.teardown === false;
    if (pausing) {
      this.ingestRecord(sessionId, {
        type: "agent_interrupted",
        sessionId,
        reason: "stop",
        ts: this.nowIso(),
      });
    }
    session.stopping = true;
    if (session.syncTimer !== null) {
      clearTimeout(session.syncTimer);
      session.syncTimer = null;
    }
    // Paused rather than left polling: `stopping` drops facts, and the git
    // collector would never re-emit a diff it saw while stopped.
    await session.evidence?.stop();
    await session.adapter?.stop();
    if (keep) {
      session.parked = true;
    } else {
      this.sessions.delete(sessionId);
    }
    if (pausing) {
      // Paused, not ended: endedAt stays unset and the execution claim is
      // kept, so the boot sweep keeps the session resumable for 24 h.
      session.agentState = "paused";
      this.opts.db.setSessionState(sessionId, "paused");
    } else {
      // A session that already failed or completed keeps that state.
      this.opts.db.setSessionState(sessionId, session.agentState);
      this.opts.db.setSessionEnded(sessionId);
      this.opts.db.setExecutionClaim(sessionId, null);
    }
    this.emitAgentState(session);
    this.emitSessionState(sessionId);
    this.log(`session ${sessionId} stopped (state ${session.agentState})`);
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
      const failed: NormalizedAgentEvent = {
        type: "agent_failed",
        sessionId,
        error: "resume budget exhausted",
        ts: this.nowIso(),
      };
      // Persist first: the trace must show why the session ended. Not through
      // ingestRecord, which would rerun the terminal transition.
      this.opts.db.appendAgentEvent(sessionId, failed);
      this.opts.emit(MainToRendererChannels.agentEvent, failed);
      this.emitAgentState(session);
      this.emitSessionState(sessionId);
      return;
    }
    this.unpark(session);
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
    this.unpark(session);
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
    this.unpark(session);
    this.refreshThreadId(session);
    await session.adapter?.sendDecision(structured);
    // ts: when the status changed (R4); readers fall back to the row ts.
    const answered: Decision = {
      ...decision,
      status: "answered",
      answer: structured,
      ts: this.nowIso(),
    };
    this.opts.db.upsertDecision(answered);
    this.ingestIntoCoordinator(session, answered);
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
    this.unpark(session);
    await session.adapter?.sendDecision(structured);
    const delegated: Decision = {
      ...decision,
      status: "delegated",
      answer: structured,
      ts: this.nowIso(),
    };
    this.opts.db.upsertDecision(delegated);
    this.ingestIntoCoordinator(session, delegated);
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
      session.evidence.observeCommand(event.command, event.exitCode, event.callId);
      if (event.stdout.trim().length > 0) {
        session.evidence.observeTestOutput(event.command, event.stdout, event.callId);
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
          void this.syncSession(session, { completing: true });
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
      case "agent_interrupted":
        // D10: interrupt and stop pause the session; it is never failed or
        // ended. A steer relaunches the agent at once, so the state stays.
        if (event.reason !== "steer" && session.agentState !== "paused") {
          session.agentState = "paused";
          this.opts.db.setSessionState(session.sessionId, "paused");
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
      void this.syncSession(session, { completing: true });
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

  /**
   * Ends a paused stop (`stopSession` with `teardown: false`) before the
   * agent may run again: records are ingested again and evidence collection
   * restarts, so the git collector reports what changed while stopped. Every
   * call that can relaunch the agent or send it a user message (resume, an
   * instruction, a decision answer or delegation) runs this first; otherwise
   * a relaunched agent's events would be dropped.
   */
  private unpark(session: ActiveSession): void {
    if (!session.parked) return;
    session.parked = false;
    session.stopping = false;
    void session.evidence?.start().catch((error: unknown) => {
      this.log(`evidence restart failed: ${String(error)}`);
    });
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

  /** completing: the turn ended; the pass ends with the completion surface (lane 03 D-6). */
  private syncSession(session: ActiveSession, options: { completing?: boolean } = {}): Promise<void> {
    // Serialize syncs per session: the 600ms debounce, answerDecision, and
    // completion paths can all request a sync nearly simultaneously, and a
    // concurrent second pass would re-derive the same Jev calls and emit
    // duplicate ui:spec payloads for the same units.
    if (session.stopping) {
      return session.syncChain;
    }
    const completing = options.completing === true;
    session.syncChain = session.syncChain.then(() => this.runSync(session, completing));
    return session.syncChain;
  }

  /**
   * One sync pass. Each write commits on its own as it happens, and each committed trace row is hinted at once
   * (observeTraceAppends): the Jev stage stores a unit's decisions and labels as its answers arrive, before the next
   * unit's client call. Lane 03 D-6 ran the pass in two transactions and deferred the Jev writes past the client's
   * last await; PL-2 dropped both (D-6 review I-1, I-2). A rollback undid rows that the stores' and this runtime's
   * caches still counted as written, so later passes skipped them for good, and a networked client held every live
   * decision back until its last call. The transactions saved about 20 ms of commits at a turn end.
   *
   * Errors: a throw ends the pass with the earlier rows committed. Every cache that lets a later pass skip work (the
   * stores' last payloads, unitState, surfaces, completionEmitted) is updated only after the writes it stands for,
   * so the next pass writes what this one did not.
   *
   * Per-batch reads (PL-2): the Jev debug channel gets the latest decisions at each slice that yields and once after
   * the Jev stage, not once per decision. Snapshots are shared where no store changes in between (see below). Below
   * that, the unit and graph stores reread their lists only after a row of their kind was written (lane 07 PL-3), so
   * a snapshot, the rebuild's unit lists and emitSessionState after no such write cost no O(session) read.
   *
   * Slices (PL-2): the pass checks its slice after the flush, before each Jev batch and unit, before each surface,
   * once before the decision, validation and completion steps, which run together, and once after them, before the
   * explainer hook (onPipelineSync, lane 07 S-2), which only a completed pass reaches. The slice is the main slicer's
   * per-turn budget, shared with the session explainer (lane 07 PL-3): when the turn's budget is spent the pass sends
   * unsent Jev decisions to the debug panel and yields through the slicer, so no event-loop turn runs past spec
   * §6.1's 50 ms. Other work may run between slices, as it already could across a networked Jev client's awaits.
   * The Jev stage keeps the snapshot read at the pass's start, and the surfaces the one read after the stage, across
   * their own yields; the snapshot is read again before the decision step only if the surfaces yielded.
   * Each check also ends the pass (PassStopped) once the session is stopped, so a suspended pass writes nothing after
   * a stop and never interrupts a stopped adapter.
   */
  private async runSync(session: ActiveSession, completing = false): Promise<void> {
    if (session.stopping) return;
    let jevUnsent = false;
    const sendJevDebug = (): void => {
      if (!jevUnsent || session.stopping) return;
      jevUnsent = false;
      this.emitJevDebug(session);
    };
    const slicer = createSlicer(this.slicer, () => session.stopping, sendJevDebug);
    const pace = (): Promise<void> => slicer.pace();
    try {
      session.coordinator.flush();
      await pace();
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
      let current = snapshot;
      if (changedUnits.length > 0) {
        const stage = runJevStage({
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
          snapshot,
          pace,
          onJevLog: () => {
            jevUnsent = true;
          },
          onRedaction: (count) => {
            this.recordTelemetry(session, "redaction", { count });
          },
        });
        let result: Awaited<typeof stage>;
        try {
          result = await stage;
        } finally {
          sendJevDebug();
        }
        await pace();
        // Read after the stage's label writes. Surfaces, decision surfaces and telemetry change none of the
        // coordinator's stores, so this read serves the steps below unless a decision interrupts the agent.
        current = session.coordinator.snapshot();
        const yieldsAtRead = slicer.yields;
        await this.syncOutcomes(session, result, ctx, current, pace);
        await pace();
        if (slicer.yields !== yieldsAtRead) current = session.coordinator.snapshot();
      }
      if (this.emitDecisions(session, ctx, current)) current = session.coordinator.snapshot();
      this.emitValidations(session, current);
      if (completing) this.emitCompletionSurface(session, current);
      this.emitSessionState(session.sessionId);
      // Lane 07 S-2: once per completed pass. The decision, validation and completion steps above run as one block,
      // so the pass checks its slice (and a stop) again before the hook. current is the pass's last snapshot.
      await pace();
      this.notifyPipelineSync(session, current);
    } catch (error) {
      // Stopped mid-pass: the stop owns the session from here.
      if (error instanceof PassStopped) return;
      this.log(`sync failed for ${session.sessionId}: ${String(error)}`);
      // As before, a turn end shows its completion surface even when the sync failed.
      if (completing) {
        try {
          this.emitCompletionSurface(session);
        } catch (surfaceError) {
          this.log(`completion surface failed for ${session.sessionId}: ${String(surfaceError)}`);
        }
      }
    }
  }

  private async syncOutcomes(
    session: ActiveSession,
    result: Awaited<ReturnType<typeof runJevStage>>,
    ctx: UiStageContext,
    snapshot: ReturnType<PipelineCoordinator["snapshot"]>,
    pace: () => Promise<void>,
  ): Promise<void> {
    for (const outcome of result.outcomes) {
      await pace();
      const unit = snapshot.units.find(
        (candidate) => candidate.id === outcome.unitId,
      );
      if (unit === undefined) continue;
      // Recorded once the unit's rows are written: a throw before then leaves the unit to the next pass.
      const settle = (): void => {
        session.unitState.set(outcome.unitId, {
          ...outcome.state,
          coreSignature: coreSignature(unit),
        });
      };
      this.opts.emit(MainToRendererChannels.changeUnitUpsert, {
        sessionId: session.sessionId,
        changeUnit: unit,
      });
      if (!outcome.state.shouldSurface || outcome.intent === undefined) {
        settle();
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
        settle();
        continue;
      }
      const surfaceId =
        linkedDecision !== undefined
          ? surfaceIdForDecision(linkedDecision.id)
          : surfaceIdForUnit(unit.id);
      if (session.dismissed.has(surfaceId)) {
        settle();
        continue;
      }
      const spec =
        linkedDecision !== undefined
          ? compileDecisionSurface(linkedDecision, ctx)
          : compileChangeUnitSurface(unit, outcome.intent, ctx);
      const hash = specHash(spec);
      const previous = session.surfaces.get(surfaceId);
      const surface: SurfaceRecord = {
        surfaceId,
        spec,
        specHash: hash,
        changeUnitId: unit.id,
        intent: outcome.intent,
        renderedAt: this.nowIso(),
        replaySlug: outcome.replaySlug,
      };
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
      // After the surface's rows: a surface the runtime holds is patched next time, without a surface_shown row.
      session.surfaces.set(surfaceId, surface);
      settle();
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

  private emitCompletionSurface(
    session: ActiveSession,
    current?: ReturnType<PipelineCoordinator["snapshot"]>,
  ): void {
    if (session.stopping || session.completionEmitted) return;
    const snapshot = current ?? session.coordinator.snapshot();
    const ctx = this.buildUiContext(session, snapshot);
    const spec = compileCompletionSurface(ctx);
    const hash = specHash(spec);
    const surface: SurfaceRecord = {
      surfaceId: COMPLETION_SURFACE_ID,
      spec,
      specHash: hash,
      renderedAt: this.nowIso(),
    };
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
    // Marked after its rows: a throw above lets the turn end's catch, or a later call, write them.
    session.surfaces.set(COMPLETION_SURFACE_ID, surface);
    session.completionEmitted = true;
  }

  /** Returns true when it interrupted the agent for a decision: the interrupt may ingest an agent event. */
  private emitDecisions(
    session: ActiveSession,
    ctx: UiStageContext,
    snapshot: ReturnType<PipelineCoordinator["snapshot"]>,
  ): boolean {
    let interrupted = false;
    for (const decision of snapshot.decisions) {
      if (decision.status === "open" && session.openDecisions.has(decision.id)) {
        const surfaceId = surfaceIdForDecision(decision.id);
        const already = session.surfaces.has(surfaceId);
        if (!session.dismissed.has(surfaceId) && !already) {
          const spec = compileDecisionSurface(decision, ctx);
          const surface: SurfaceRecord = {
            surfaceId,
            spec,
            specHash: specHash(spec),
            changeUnitId: decision.affectedChangeUnits[0],
            renderedAt: this.nowIso(),
          };
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
          // After its row: a decision surface the runtime holds is not written again.
          session.surfaces.set(surfaceId, surface);
        }
        if (
          this.opts.interruptAgentOnDecision !== false &&
          session.adapterKind !== "none" &&
          (decision.severity === "required" || decision.severity === "recommended") &&
          session.agentState !== "waiting_decision"
        ) {
          void session.adapter?.interrupt();
          interrupted = true;
          session.agentState = "waiting_decision";
          session.interruptedForDecision = true;
          this.opts.db.setSessionState(session.sessionId, "waiting_decision");
          this.emitAgentState(session);
        }
      }
    }
    return interrupted;
  }

  private emitValidations(
    session: ActiveSession,
    snapshot: ReturnType<PipelineCoordinator["snapshot"]>,
  ): void {
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

  /**
   * Console-explainer spec §6.1: the explainer stage reads every completed pass, once, with the snapshot the pass
   * last held (runSync's current). A hook error never fails the pass.
   */
  private notifyPipelineSync(session: ActiveSession, snapshot: ReturnType<PipelineCoordinator["snapshot"]>): void {
    const hook = this.opts.onPipelineSync;
    if (hook === undefined) return;
    try {
      hook(session.repoPath, {
        sessionId: session.sessionId,
        lastSeq: this.opts.db.getSession(session.sessionId)?.lastEventSeq ?? 0,
        changeUnits: snapshot.units,
        decisions: snapshot.decisions,
      });
    } catch (error) {
      this.log(`session ${session.sessionId}: explainer hook failed: ${String(error)}`);
    }
  }

  /** The latest 50 Jev decisions, read and sent at a pass's yields and after its Jev stage (lane 03 PL-2). */
  private emitJevDebug(session: ActiveSession): void {
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
      case "model_selected": {
        input = {
          type,
          modelId: String(payload["modelId"] ?? ""),
          reasoningEffort: modelSelectedEffort(payload["reasoningEffort"]),
          tier: modelSelectedTier(payload["tier"]),
          auto: payload["auto"] === true,
          confidence: Number(payload["confidence"] ?? 0),
          rationale: String(payload["rationale"] ?? ""),
          contextTokensEstimate: Number(
            payload["contextTokensEstimate"] ?? 0,
          ),
        };
        break;
      }
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
      // A pass emits this after its snapshot, so the unit store's list is current and reread only after a unit write.
      const changeUnitCount = session?.stores.units.all().length;
      this.opts.emit(
        MainToRendererChannels.sessionState,
        buildSessionState(this.opts.db, sessionId, session?.threadId ?? null, changeUnitCount),
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

  private ensureSessionRow(sessionId: string, input: SessionStartOptions): void {
    if (this.opts.db.getSession(sessionId) !== undefined) return;
    const repository = this.opts.db.upsertRepository({
      path: input.repoPath,
      gitRoot: input.repoPath,
      branch: "",
      baseCommit: input.baseCommit ?? "",
    });
    this.opts.db.createSession({
      id: sessionId,
      repoId: repository.id,
      prompt: input.prompt,
      baseCommit: input.baseCommit ?? "",
      branch: "",
      state: "starting",
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

  /** Forwards a repo file change to the explainer stage; its failures never reach ingestion. */
  private notifyRepoFilesChanged(session: ActiveSession, filePath: string): void {
    const hook = this.opts.onRepoFilesChanged;
    if (hook === undefined) return;
    try {
      hook(session.repoPath, [filePath]);
    } catch (error) {
      this.log(`session ${session.sessionId}: explainer file hook failed: ${String(error)}`);
    }
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

function modelSelectedEffort(value: unknown): "low" | "medium" | "high" | "xhigh" {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh"
    ? value
    : "medium";
}

function modelSelectedTier(value: unknown): "economy" | "standard" | "premium" {
  return value === "economy" || value === "standard" || value === "premium"
    ? value
    : "standard";
}

