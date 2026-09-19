import type { AgentInstruction } from "@jevcode/contracts";

import type {
  InstructionDeliverer,
  InstructionDeliveryResult,
} from "./instruction-router.js";
import type { PipelineRuntime } from "./pipeline-runtime.js";

/**
 * Bridges the durable instruction router to the running pipeline/agent
 * adapter. Delivery status comes from the adapter (codex: steer/queue/
 * declined semantics; mock: always delivered with id-idempotency). The
 * router owns durability; the adapter owns delivery semantics.
 */
export class RuntimeInstructionDeliverer implements InstructionDeliverer {
  private readonly runtime: PipelineRuntime;
  private readonly log: (message: string) => void;
  private readonly sessionByInstruction = new Map<string, string>();

  constructor(runtime: PipelineRuntime, log: (message: string) => void = () => {}) {
    this.runtime = runtime;
    this.log = log;
  }

  async deliver(instruction: AgentInstruction): Promise<InstructionDeliveryResult> {
    this.sessionByInstruction.set(instruction.id, instruction.sessionId);
    if (!this.runtime.hasSession(instruction.sessionId)) {
      return "declined";
    }
    try {
      return await this.runtime.sendInstruction(instruction.sessionId, instruction);
    } catch (error) {
      this.log(`instruction ${instruction.id}: delivery failed: ${String(error)}`);
      return "queued";
    }
  }

  async pending(): Promise<string[]> {
    const ids: string[] = [];
    for (const [instructionId, sessionId] of this.sessionByInstruction) {
      try {
        const sessionPending = await this.runtime.pendingInstructionIds(sessionId);
        if (sessionPending.includes(instructionId)) ids.push(instructionId);
      } catch {
        // session gone: not pending anywhere
      }
    }
    return ids;
  }

  async cancel(instructionId: string): Promise<void> {
    const sessionId = this.sessionByInstruction.get(instructionId);
    if (sessionId === undefined) return;
    try {
      await this.runtime.cancelAgentInstruction(sessionId, instructionId);
    } catch (error) {
      this.log(`instruction ${instructionId}: agent-side cancel failed: ${String(error)}`);
    }
  }
}
