import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import {
  transition,
  serializeStructuredDecision,
  defaultNormalizerContext,
  InstructionQueue,
  SerialQueue,
  type InstructionStore,
  type AgentLifecycleEvent,
  type EventNormalizerContext,
} from "@jevcode/agent-core";
import {
  NormalizedAgentEventSchema,
  type AgentDetection,
  type AgentInstruction,
  type AgentSession,
  type AgentState,
  type CodingAgentAdapter,
  type NormalizedAgentEvent,
  type StartSessionInput,
  type StructuredDecision,
  type Unsubscribe,
} from "@jevcode/contracts";
import pty, { type IPty } from "node-pty";

import { detectAuthFailure } from "./auth.js";
import { extractCodexThreadId, mapCodexJsonlEvent } from "./jsonl.js";
import { initialTranscriptState, parseTranscriptLine } from "./fallback.js";

export type InstructionDeliveryStatus = "delivered" | "queued" | "declined";

export interface CodexAdapterOptions {
  binPath?: string;
  useJson?: boolean;
  sandboxArgs?: string[];
  env?: Record<string, string>;
  now?: () => string;
  sessionId?: string;
  warn?: (message: string) => void;
  instructionStore?: InstructionStore;
}

const DEFAULT_SANDBOX_ARGS = ["--dangerously-bypass-approvals-and-sandbox"];

const THREAD_ID_WAIT_MS = 30_000;

function resolveSandboxArgs(optionArgs: string[] | undefined): string[] {
  if (optionArgs !== undefined) {
    return optionArgs;
  }
  const override = process.env["JEVCODE_CODEX_SANDBOX_ARGS"];
  if (override !== undefined) {
    return override.trim() === "" ? [] : override.split(/\s+/);
  }
  return DEFAULT_SANDBOX_ARGS;
}

export type DeliveryAwareCodingAgentAdapter = Omit<
  CodingAgentAdapter,
  "sendInstruction"
> & {
  sendInstruction(input: AgentInstruction): Promise<InstructionDeliveryStatus>;
};

export class CodexAdapter implements DeliveryAwareCodingAgentAdapter
{
  readonly id = "codex" as const;

  private readonly binPath: string;
  private readonly useJson: boolean;
  private readonly sandboxArgs: string[];
  private readonly extraEnv: Record<string, string>;
  private readonly now: () => string;
  private readonly pinnedSessionId: string | undefined;
  private readonly warnFn: (message: string) => void;

  private readonly ops = new SerialQueue();
  private readonly queue: InstructionQueue;

  private ptyProc: IPty | null = null;
  private suppressedExits = new Set<IPty>();
  private state: AgentState = "starting";
  private sessionId = "";
  private threadId: string | null = null;
  private context: EventNormalizerContext | null = null;
  private transcriptState = initialTranscriptState();
  private lineBuffer = "";
  private terminalEventSeen = false;
  private dataReceived = false;
  private writeQueue: string[] = [];
  private cwd = "";
  private approvalMode: StartSessionInput["approvalMode"];
  private model: string | undefined;
  private reasoningEffort: string | undefined;
  private deliveredIds = new Set<string>();
  private autoRelayArmed = true;
  private threadWaiters: { resolve: (ok: boolean) => void; timer: NodeJS.Timeout }[] =
    [];
  private stallTimer: NodeJS.Timeout | null = null;
  private stallNotified = false;

  private readonly eventHandlers = new Set<(e: NormalizedAgentEvent) => void>();
  private readonly exitHandlers = new Set<(code: number) => void>();

  constructor(options: CodexAdapterOptions = {}) {
    this.binPath =
      options.binPath ?? process.env["JEVCODE_CODEX_BIN"] ?? "codex";
    this.useJson = options.useJson ?? true;
    this.sandboxArgs = resolveSandboxArgs(options.sandboxArgs);
    this.extraEnv = options.env ?? {};
    this.now = options.now ?? (() => new Date().toISOString());
    this.pinnedSessionId = options.sessionId;
    this.warnFn = options.warn ?? ((message) => console.warn(message));
    this.queue = new InstructionQueue({ store: options.instructionStore });
  }

  private warn(message: string): void {
    this.warnFn(`[codex-adapter] ${message}`);
  }

  getState(): AgentState {
    return this.state;
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  pendingInstructions(): AgentInstruction[] {
    return this.queue.pending();
  }

  cancelInstruction(id: string): boolean {
    return this.queue.cancel(id);
  }

  async detect(): Promise<AgentDetection> {
    const bin = resolveBinPath(this.binPath);
    if (bin === null) {
      return { available: false, error: `codex binary not found: ${this.binPath}` };
    }
    const result = spawnSync(bin, ["--version"], {
      encoding: "utf8",
      env: { ...process.env, ...this.extraEnv },
    });
    if (result.error !== undefined) {
      return {
        available: false,
        path: bin,
        error: `failed to run codex: ${result.error.message}`,
      };
    }
    const version = result.stdout.trim().match(/(\d+\.\d+\.\d+)/)?.[1];
    if (result.status === 0 && version !== undefined) {
      return { available: true, version, path: bin };
    }
    return {
      available: false,
      path: bin,
      error: `codex --version exited with code ${result.status ?? "unknown"}: ${result.stderr.trim()}`,
    };
  }

  async startSession(input: StartSessionInput): Promise<AgentSession> {
    return this.ops.run(async () => {
      if (this.ptyProc !== null) {
        throw new Error("codex session already running");
      }
      const sessionId = this.pinnedSessionId ?? randomUUID();
      this.sessionId = sessionId;
      this.cwd = input.cwd;
      this.approvalMode = input.approvalMode;
      this.model = input.model;
      this.reasoningEffort = input.reasoningEffort;
      this.state = "starting";
      this.threadId = null;
      this.context = defaultNormalizerContext(sessionId);
      this.deliveredIds = new Set();
      this.autoRelayArmed = true;

      const args = [
        "exec",
        "--json",
        "--color",
        "never",
        "-C",
        input.cwd,
        ...this.approvalArgs(input.approvalMode),
        ...this.sandboxArgs,
        ...(input.model !== undefined ? ["--model", input.model] : []),
        ...(input.reasoningEffort !== undefined
          ? ["-c", `model_reasoning_effort="${input.reasoningEffort}"`]
          : []),
        input.prompt,
      ];

      this.emit({
        type: "agent_started",
        sessionId,
        prompt: input.prompt,
        ts: this.now(),
      });
      this.applyEvent("agent_started");

      this.spawnProcess(args, input.cwd, input.env);

      return {
        sessionId,
        agentId: "codex",
        repoPath: input.repoPath,
        cwd: input.cwd,
        startedAt: new Date().toISOString(),
      };
    });
  }

  async sendInstruction(
    input: AgentInstruction,
  ): Promise<InstructionDeliveryStatus> {
    return this.ops.run(async () => {
      if (input.sessionId !== this.sessionId) {
        throw new Error(
          `codex instruction sessionId ${input.sessionId} does not match session ${this.sessionId}`,
        );
      }
      let status: InstructionDeliveryStatus;
      if (input.mode === "steer") {
        status = await this.deliverSteer(input.id, input.text);
      } else {
        status = this.enqueueInstruction(input.id, input.text);
      }
      this.emitUserMessage(input.text);
      return status;
    });
  }

  async sendDecision(input: StructuredDecision): Promise<void> {
    return this.ops.run(async () => {
      const text = serializeStructuredDecision(input);
      const instructionId = `decision:${input.decisionId}`;
      const hasInstruction =
        input.instruction !== undefined && input.instruction.trim().length > 0;
      if (hasInstruction) {
        await this.deliverSteer(instructionId, text);
      } else {
        this.enqueueInstruction(instructionId, text);
      }
      this.emitUserMessage(text);
      this.applyEvent("decision_resolved");
    });
  }

  async interrupt(): Promise<void> {
    return this.ops.run(() => {
      if (this.ptyProc === null && this.threadId === null) {
        this.warn(
          `interrupt() ignored: codex session is not running (state ${this.state})`,
        );
        return;
      }
      if (this.ptyProc === null) {
        this.warn(`interrupt() ignored: no codex process is running (state ${this.state})`);
        return;
      }
      this.write("\u0003");
      this.applyEvent("interrupted");
    });
  }

  async resume(): Promise<void> {
    return this.ops.run(() => {
      if (this.ptyProc !== null) {
        this.write("\n");
        this.applyEvent("resumed");
        return;
      }
      if (this.threadId !== null) {
        this.autoRelayArmed = true;
        const next = this.queue.pending()[0];
        if (next !== undefined) {
          this.queue.markDelivered(next.id);
          this.spawnResume(next.text);
        } else {
          this.spawnResume("Continue the task.");
        }
        return;
      }
      this.warn(`resume() ignored: codex session is not running (state ${this.state})`);
    });
  }

  async stop(): Promise<void> {
    return this.ops.run(() => {
      if (this.ptyProc === null && this.threadId === null) {
        this.warn(`stop() ignored: codex session is not running (state ${this.state})`);
        return;
      }
      this.terminalEventSeen = true;
      this.ptyProc?.kill();
      this.ptyProc = null;
      this.applyEvent("completed");
    });
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

  private approvalArgs(
    mode: StartSessionInput["approvalMode"],
  ): string[] {
    if (mode === "never") return ["-c", "approval_policy=never"];
    if (mode === "on-failure") return ["-c", "approval_policy=on-failure"];
    return [];
  }

  private enqueueInstruction(
    id: string,
    text: string,
  ): InstructionDeliveryStatus {
    if (this.ptyProc === null && this.threadId === null) {
      return "declined";
    }
    this.queue.enqueue({
      id,
      sessionId: this.sessionId,
      text,
      mode: "queue",
    });
    return "queued";
  }

  private async deliverSteer(
    id: string,
    text: string,
  ): Promise<InstructionDeliveryStatus> {
    if (this.deliveredIds.has(id)) {
      return "delivered";
    }
    const relaunchable = await this.ensureRelaunchable();
    if (!relaunchable) {
      return "declined";
    }
    this.deliveredIds.add(id);
    this.terminateRunningProcess();
    this.spawnResume(text);
    return "delivered";
  }

  private ensureRelaunchable(): Promise<boolean> {
    if (this.threadId !== null) {
      return Promise.resolve(true);
    }
    if (this.ptyProc === null) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          this.threadWaiters = this.threadWaiters.filter((w) => w !== waiter);
          resolve(false);
        }, THREAD_ID_WAIT_MS),
      };
      waiter.timer.unref?.();
      this.threadWaiters.push(waiter);
    });
  }

  private flushThreadWaiters(ok: boolean): void {
    for (const waiter of this.threadWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(ok);
    }
  }

  private terminateRunningProcess(): void {
    if (this.ptyProc === null) {
      return;
    }
    this.terminalEventSeen = true;
    this.suppressedExits.add(this.ptyProc);
    this.ptyProc.kill();
  }

  private emitUserMessage(text: string): void {
    if (this.context !== null) {
      this.emit({
        type: "agent_message",
        sessionId: this.sessionId,
        role: "user",
        text,
        ts: this.now(),
      });
    }
  }

  private spawnResume(promptText: string): void {
    const threadId = this.threadId;
    if (threadId === null || this.context === null) {
      throw new Error("codex session is not running and no thread id is available");
    }
    const args = [
      "exec",
      "resume",
      threadId,
      "--json",
      "--color",
      "never",
      "-C",
      this.cwd,
      ...this.approvalArgs(this.approvalMode),
      ...this.sandboxArgs,
      ...(this.model !== undefined ? ["--model", this.model] : []),
      ...(this.reasoningEffort !== undefined
        ? ["-c", `model_reasoning_effort="${this.reasoningEffort}"`]
        : []),
      promptText,
    ];
    this.state = "starting";
    this.emit({
      type: "agent_started",
      sessionId: this.sessionId,
      prompt: promptText,
      ts: this.now(),
    });
    this.spawnProcess(args, this.cwd, {});
    this.applyEvent("agent_started");
  }

  private spawnProcess(
    args: string[],
    cwd: string,
    extraEnv: Record<string, string>,
  ): void {
    this.terminalEventSeen = false;
    this.dataReceived = false;
    this.writeQueue = [];
    this.lineBuffer = "";
    this.transcriptState = initialTranscriptState();

    const previous = this.ptyProc;
    if (previous !== null) {
      this.suppressedExits.add(previous);
    }

    const proc = pty.spawn(this.binPath, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd,
      env: { ...process.env, ...this.extraEnv, ...extraEnv },
    });
    this.ptyProc = proc;

    proc.onData((data) => this.handleData(data));
    proc.onExit(({ exitCode, signal }) => {
      this.clearStallWatchdog();
      if (this.suppressedExits.delete(proc)) {
        return;
      }
      if (this.ptyProc === proc) {
        this.ptyProc = null;
      }
      const code =
        (signal ?? 0) > 0 && exitCode === 0 ? 128 + (signal ?? 0) : exitCode;
      if (!this.terminalEventSeen) {
        const authFailure = detectAuthFailure(this.lineBuffer);
        this.emit({
          type: "agent_failed",
          sessionId: this.sessionId,
          error:
            authFailure !== null
              ? authFailure.message
              : `codex exited with code ${code}`,
          ts: this.now(),
        });
        this.applyEvent("failed");
      }
      this.flushThreadWaiters(false);
      for (const handler of this.exitHandlers) handler(code);
    });

    this.armStallWatchdog();
  }

  private write(data: string): void {
    if (this.ptyProc === null) {
      throw new Error("codex session is not running");
    }
    if (!this.dataReceived) {
      this.writeQueue.push(data);
      return;
    }
    this.ptyProc.write(data);
  }

  private handleData(data: string): void {
    this.armStallWatchdog();
    if (!this.dataReceived) {
      this.dataReceived = true;
      if (this.writeQueue.length > 0 && this.ptyProc !== null) {
        const queued = this.writeQueue;
        this.writeQueue = [];
        for (const chunk of queued) this.ptyProc.write(chunk);
      }
    }
    this.lineBuffer += data;
    const lines = this.lineBuffer.split("\n");
    this.lineBuffer = lines.pop() ?? "";
    for (const line of lines) this.handleLine(line.replace(/\r$/, ""));
  }

  private handleLine(line: string): void {
    if (this.context === null) return;
    if (this.useJson) {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        this.handleNonJsonLine(line);
        return;
      }
      const threadId = extractCodexThreadId(raw);
      if (threadId !== null) {
        this.threadId = threadId;
        this.flushThreadWaiters(true);
      }
      for (const event of mapCodexJsonlEvent(raw, this.context)) {
        this.dispatchEvent(event);
      }
      return;
    }
    const result = parseTranscriptLine(line, this.context, this.transcriptState);
    this.transcriptState = result.state;
    for (const event of result.events) this.dispatchEvent(event);
  }

  private handleNonJsonLine(line: string): void {
    if (line.trim() === "") return;
    const authFailure = detectAuthFailure(line);
    if (authFailure !== null && this.context !== null) {
      this.dispatchEvent({
        type: "agent_failed",
        sessionId: this.context.sessionId,
        error: authFailure.message,
        ts: this.now(),
      });
    }
  }

  private dispatchEvent(event: NormalizedAgentEvent): void {
    const validated = this.emit(event);
    switch (validated.type) {
      case "agent_completed":
        this.applyEvent("completed");
        this.scheduleAutoRelay();
        break;
      case "agent_failed":
        this.applyEvent("failed");
        break;
      case "approval_requested":
        this.applyEvent("decision_requested");
        break;
      default:
        break;
    }
    if (validated.type === "agent_completed" || validated.type === "agent_failed") {
      this.terminalEventSeen = true;
    }
  }

  private scheduleAutoRelay(): void {
    void this.ops.run(() => {
      if (!this.autoRelayArmed) {
        return;
      }
      const next = this.queue.pending()[0];
      if (next === undefined) {
        return;
      }
      this.autoRelayArmed = false;
      this.queue.markDelivered(next.id);
      try {
        this.spawnResume(next.text);
      } catch (error) {
        this.warn(`queued instruction delivery failed: ${String(error)}`);
      }
    });
  }

  private applyEvent(event: AgentLifecycleEvent): void {
    try {
      this.state = transition(this.state, event);
    } catch {
      this.warn(
        `ignoring lifecycle event ${event} from state ${this.state} (out-of-order or terminal)`,
      );
    }
  }

  private emit(event: NormalizedAgentEvent): NormalizedAgentEvent {
    const parsed = NormalizedAgentEventSchema.parse(event);
    for (const handler of this.eventHandlers) {
      try {
        handler(parsed);
      } catch (error) {
        // A throwing subscriber must not break the PTY data callback.
        this.warn(`event handler failed: ${String(error)}`);
      }
    }
    return parsed;
  }

  private readStallMs(): number {
    const raw = process.env["JEVCODE_AGENT_STALL_MS"];
    if (raw === undefined || raw.trim() === "") {
      return 0;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  }

  private armStallWatchdog(): void {
    this.clearStallWatchdog();
    const stallMs = this.readStallMs();
    if (stallMs <= 0) {
      return;
    }
    this.stallNotified = false;
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      if (this.ptyProc !== null && this.state === "running" && !this.stallNotified) {
        this.stallNotified = true;
        this.emit({
          type: "agent_waiting",
          sessionId: this.sessionId,
          ts: this.now(),
        });
        this.warn(
          `agent_waiting: no PTY output for ${stallMs}ms while the agent is running`,
        );
      }
    }, stallMs);
  }

  private clearStallWatchdog(): void {
    if (this.stallTimer !== null) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }
}

function resolveBinPath(binPath: string): string | null {
  if (binPath.includes("/") || existsSync(binPath)) {
    return existsSync(binPath) ? binPath : null;
  }
  for (const dir of (process.env["PATH"] ?? "").split(":")) {
    if (dir === "") continue;
    const candidate = join(dir, binPath);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
