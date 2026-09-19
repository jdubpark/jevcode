import { MainToRendererChannels } from "@jevcode/contracts";
import type { AgentInstruction } from "@jevcode/contracts";
import type { JevcodeDb } from "@jevcode/storage";

import type { EmitFn } from "./types.js";

export type InstructionDeliveryResult = "delivered" | "queued" | "declined";

/**
 * Local seam between the durable instruction inbox and the agent adapter.
 * The real adapter wiring lands in a later glue commit; the router only
 * depends on this interface so it is fully testable with a fake deliverer.
 */
export interface InstructionDeliverer {
  /**
   * Attempt to hand an instruction to the agent.
   * - "delivered": the agent accepted it now.
   * - "queued": the agent keeps it in its own queue (delivery is durable
   *   there too; the inbox row stays pending until confirmed).
   * - "declined": the agent cannot take it now; keep it pending in the inbox.
   */
  deliver(instruction: AgentInstruction): Promise<InstructionDeliveryResult>;
  /** Instruction ids the agent currently holds undelivered. */
  pending(): Promise<string[]>;
  /** Best-effort withdrawal of an undelivered instruction from the agent. */
  cancel(instructionId: string): Promise<void>;
}

export interface InstructionRouterDeps {
  db: JevcodeDb;
  deliverer: InstructionDeliverer;
  emit: EmitFn;
  log?: (message: string) => void;
}

export interface PendingInstructionView {
  id: string;
  mode: "queue" | "steer";
  text: string;
  createdAt: string;
}

/**
 * Durable instruction admission routing. Every instruction is first persisted
 * to the storage inbox (idempotent by (sessionId, instructionId)) and only
 * then offered to the deliverer. Inbox state is the source of truth: a
 * deliverer that restarts mid-delivery can re-read the pending list on boot.
 */
export class InstructionRouter {
  private readonly db: JevcodeDb;
  private readonly deliverer: InstructionDeliverer;
  private readonly emit: EmitFn;
  private readonly log: (message: string) => void;

  constructor(deps: InstructionRouterDeps) {
    this.db = deps.db;
    this.deliverer = deps.deliverer;
    this.emit = deps.emit;
    this.log = deps.log ?? (() => {});
  }

  async admit(sessionId: string, instruction: AgentInstruction): Promise<void> {
    this.db.upsertInstruction({
      sessionId,
      instructionId: instruction.id,
      mode: instruction.mode,
      text: instruction.text,
    });
    await this.attemptDelivery(sessionId, instruction);
    this.emitState(sessionId);
  }

  async cancelInstruction(
    sessionId: string,
    instructionId: string,
  ): Promise<void> {
    // The durable mark comes first: even if the agent-side cancel fails, the
    // inbox reflects the user's intent and the glue can reconcile later.
    this.db.markInstructionCancelled(sessionId, instructionId);
    try {
      await this.deliverer.cancel(instructionId);
    } catch (error) {
      this.log(
        `cancel of instruction ${instructionId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.emitState(sessionId);
  }

  /**
   * Boot-time reconciliation: re-offer every durable pending instruction for
   * the session and push the resulting inbox state. Instructions the agent
   * cannot take yet stay pending, so admission survives restarts.
   */
  async reloadPending(sessionId: string): Promise<void> {
    for (const record of this.db.listPendingInstructions(sessionId)) {
      await this.attemptDelivery(sessionId, {
        id: record.instructionId,
        sessionId,
        mode: record.mode,
        text: record.text,
      });
    }
    this.emitState(sessionId);
  }

  emitState(sessionId: string): void {
    const pending: PendingInstructionView[] = this.db
      .listPendingInstructions(sessionId)
      .map((record) => ({
        id: record.instructionId,
        mode: record.mode,
        text: record.text,
        createdAt: record.createdAt,
      }));
    this.emit(MainToRendererChannels.agentInstructionState, {
      sessionId,
      pending,
    });
  }

  private async attemptDelivery(
    sessionId: string,
    instruction: AgentInstruction,
  ): Promise<void> {
    try {
      const result = await this.deliverer.deliver(instruction);
      if (result === "delivered") {
        this.db.markInstructionDelivered(sessionId, instruction.id);
      }
      // "queued"/"declined": the inbox row stays pending.
    } catch (error) {
      this.log(
        `delivery of instruction ${instruction.id} failed: ${error instanceof Error ? error.message : String(error)}; keeping pending`,
      );
    }
  }
}
