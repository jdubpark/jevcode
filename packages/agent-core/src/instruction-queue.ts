import type { AgentInstruction } from "@jevcode/contracts";

export interface InstructionStore {
  load(): readonly AgentInstruction[];
  save(instructions: readonly AgentInstruction[]): void;
}

export interface InstructionQueueOptions {
  store?: InstructionStore;
  onChange?: (pending: readonly AgentInstruction[]) => void;
}

const DEFAULT_MODE: AgentInstruction["mode"] = "queue";

export class InstructionQueue {
  private readonly entries: AgentInstruction[] = [];
  private readonly store: InstructionStore | undefined;
  private readonly onChange:
    | ((pending: readonly AgentInstruction[]) => void)
    | undefined;

  constructor(options: InstructionQueueOptions = {}) {
    this.store = options.store;
    this.onChange = options.onChange;
    if (this.store !== undefined) {
      for (const entry of this.store.load()) {
        this.admit(entry, false);
      }
    }
  }

  enqueue(instruction: AgentInstruction): AgentInstruction {
    const existing = this.entries.find(
      (entry) => entry.id === instruction.id,
    );
    if (existing !== undefined) {
      return existing;
    }
    const admitted = this.admit(instruction, true);
    return admitted;
  }

  cancel(id: string): boolean {
    return this.remove(id);
  }

  pending(): AgentInstruction[] {
    return [
      ...this.entries.filter((entry) => entry.mode === "steer"),
      ...this.entries.filter((entry) => entry.mode === "queue"),
    ];
  }

  markDelivered(id: string): boolean {
    return this.remove(id);
  }

  markDeclined(id: string): boolean {
    return this.remove(id);
  }

  private admit(
    instruction: AgentInstruction,
    notify: boolean,
  ): AgentInstruction {
    if (instruction.id.trim() === "") {
      throw new Error("instruction id must be non-empty");
    }
    const entry: AgentInstruction = {
      ...instruction,
      mode: instruction.mode ?? DEFAULT_MODE,
    };
    this.entries.push(entry);
    if (notify) {
      this.changed();
    }
    return entry;
  }

  private remove(id: string): boolean {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index < 0) {
      return false;
    }
    this.entries.splice(index, 1);
    this.changed();
    return true;
  }

  private changed(): void {
    const snapshot = this.pending();
    this.store?.save(snapshot);
    this.onChange?.(snapshot);
  }
}
