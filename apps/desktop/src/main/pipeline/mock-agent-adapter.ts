import {
  AgentSessionSchema,
  type AgentDetection,
  type AgentInstruction,
  type AgentSession,
  type AgentState,
  type CodingAgentAdapter,
  type Decision,
  type EvidenceFact,
  type InstructionDeliveryStatus,
  type NormalizedAgentEvent,
  type SemanticEvent,
  type StartSessionInput,
  type StructuredDecision,
  type Unsubscribe,
} from "@jevcode/contracts";
import {
  canTransition,
  serializeStructuredDecision,
  transition,
} from "@jevcode/agent-core";

export type MockScriptRecord = EvidenceFact | Decision | SemanticEvent;

export type MockScriptEntry =
  | { kind: "agent"; event: NormalizedAgentEvent; delayMs?: number }
  | { kind: "record"; record: MockScriptRecord; delayMs?: number }
  | { kind: "terminal"; data: string; delayMs?: number };

export interface MockAgentScript {
  sessionId: string;
  repoPath: string;
  cwd: string;
  prompt: string;
  baseCommit?: string;
  entries: MockScriptEntry[];
  onDecision?: (input: StructuredDecision) => MockScriptEntry[];
  autoResumeOnDecision?: boolean;
  /** Exit code reported by stop() and by the auto-exit below. */
  exitCode?: number;
  /** Simulate a crash: after this many script entries, exit with `exitCode` without emitting a terminal event. */
  exitAfterEntries?: number;
}

export interface MockAgentHooks {
  onRecord?: (record: MockScriptRecord) => void;
  onTerminal?: (data: string) => void;
}

export interface MockAgentAdapterOptions {
  entryDelayMs?: number;
  hooks?: MockAgentHooks;
  threadId?: string;
  /** Exit code reported by stop() when the script does not set one. */
  exitCode?: number;
  /** Auto-exit after N entries when the script does not set it. */
  exitAfterEntries?: number;
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export class MockAgentAdapter implements CodingAgentAdapter {
  readonly id = "codex" as const;

  private readonly script: MockAgentScript;
  private readonly entryDelayMs: number;
  private readonly hooks: MockAgentHooks;
  private readonly threadId: string | null;
  private readonly exitCode: number;
  private readonly exitAfterEntries: number | undefined;

  private state: AgentState = "starting";
  private paused = false;
  private running = false;
  private index = 0;
  private injected: MockScriptEntry[] = [];
  private processedEntries = 0;
  private deliveredInstructionIds = new Set<string>();
  lastStartInput: StartSessionInput | null = null;

  private readonly eventHandlers = new Set<(e: NormalizedAgentEvent) => void>();
  private readonly exitHandlers = new Set<(code: number) => void>();

  constructor(script: MockAgentScript, options: MockAgentAdapterOptions = {}) {
    this.script = script;
    this.entryDelayMs = Math.max(0, options.entryDelayMs ?? 0);
    this.hooks = options.hooks ?? {};
    this.threadId = options.threadId ?? null;
    this.exitCode = script.exitCode ?? options.exitCode ?? 0;
    this.exitAfterEntries = script.exitAfterEntries ?? options.exitAfterEntries;
  }

  getState(): AgentState {
    return this.state;
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  async detect(): Promise<AgentDetection> {
    return { available: true, version: "mock", path: "<mock>" };
  }

  async startSession(input: StartSessionInput): Promise<AgentSession> {
    if (this.running) {
      throw new Error("mock agent session already running");
    }
    this.state = "starting";
    this.paused = false;
    this.running = true;
    this.index = 0;
    this.injected = [];
    this.processedEntries = 0;
    this.lastStartInput = input;
    this.emit({
      type: "agent_started",
      sessionId: this.script.sessionId,
      prompt: input.prompt,
      ts: new Date().toISOString(),
    });
    this.applyEvent("agent_started");
    void this.runLoop();
    return AgentSessionSchema.parse({
      sessionId: this.script.sessionId,
      agentId: "codex",
      repoPath: input.repoPath,
      cwd: input.cwd,
      baseCommit: this.script.baseCommit,
      startedAt: new Date().toISOString(),
    });
  }

  async sendInstruction(
    input: AgentInstruction,
  ): Promise<InstructionDeliveryStatus> {
    if (this.deliveredInstructionIds.has(input.id)) {
      return "delivered";
    }
    this.deliveredInstructionIds.add(input.id);
    this.emit({
      type: "agent_message",
      sessionId: this.script.sessionId,
      role: "user",
      text: input.text,
      ts: new Date().toISOString(),
    });
    return "delivered";
  }

  async pendingInstructions(): Promise<string[]> {
    return [];
  }

  async cancelInstruction(_instructionId: string): Promise<boolean> {
    return true;
  }

  async sendDecision(input: StructuredDecision): Promise<void> {
    const text = serializeStructuredDecision(input);
    this.emit({
      type: "agent_message",
      sessionId: this.script.sessionId,
      role: "user",
      text,
      ts: new Date().toISOString(),
    });
    const injected = this.script.onDecision?.(input) ?? [];
    this.injected.push(...injected);
    this.applyEvent("decision_resolved");
    if (this.script.autoResumeOnDecision !== false && this.paused) {
      this.paused = false;
      this.applyEvent("resumed");
    }
  }

  async interrupt(): Promise<void> {
    if (!this.running) return;
    this.paused = true;
    this.applyEvent("interrupted");
  }

  async resume(): Promise<void> {
    if (!this.running) return;
    this.paused = false;
    this.applyEvent("resumed");
  }

  async stop(): Promise<void> {
    if (this.running) {
      this.running = false;
      this.applyEvent("completed");
    }
    for (const handler of this.exitHandlers) handler(this.exitCode);
  }

  onEvent(handler: (e: NormalizedAgentEvent) => void): Unsubscribe {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  onExit(handler: (code: number) => void): Unsubscribe {
    this.exitHandlers.add(handler);
    return () => {
      this.exitHandlers.delete(handler);
    };
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      if (this.paused) {
        await wait(5);
        continue;
      }
      const entry =
        this.injected.length > 0
          ? this.injected.shift()
          : this.index < this.script.entries.length
            ? this.script.entries[this.index++]
            : undefined;
      if (entry === undefined) {
        await wait(5);
        continue;
      }
      const delay = Math.max(this.entryDelayMs, entry.delayMs ?? 0);
      if (delay > 0) {
        await wait(delay);
      }
      if (!this.running || this.paused) continue;
      try {
        switch (entry.kind) {
          case "agent":
            this.emit(entry.event);
            break;
          case "record":
            this.hooks.onRecord?.(entry.record);
            break;
          case "terminal":
            this.hooks.onTerminal?.(entry.data);
            break;
        }
        this.processedEntries += 1;
      } catch (error) {
        // A throwing hook must not silently kill the run loop; log and continue.
        console.warn(
          `[mock-agent-adapter] dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (
        this.exitAfterEntries !== undefined &&
        this.processedEntries >= this.exitAfterEntries &&
        this.running
      ) {
        // Simulated crash: exit without a terminal event.
        this.running = false;
        for (const handler of this.exitHandlers) handler(this.exitCode);
        break;
      }
    }
  }

  private applyEvent(event: Parameters<typeof transition>[1]): void {
    if (!canTransition(this.state, event)) return;
    try {
      this.state = transition(this.state, event);
    } catch {
      // best-effort state tracking
    }
  }

  private emit(event: NormalizedAgentEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        console.warn(
          `[mock-agent-adapter] event handler failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
