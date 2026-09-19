import { describe, expect, it, vi } from "vitest";

import type { AgentInstruction } from "@jevcode/contracts";

import {
  InstructionQueue,
  type InstructionStore,
} from "./instruction-queue.js";

function instruction(
  id: string,
  mode: AgentInstruction["mode"],
  text = `text ${id}`,
): AgentInstruction {
  return { id, sessionId: "s1", text, mode };
}

describe("InstructionQueue", () => {
  it("enqueues and exposes pending entries", () => {
    const queue = new InstructionQueue();
    queue.enqueue(instruction("a", "queue"));
    queue.enqueue(instruction("b", "queue"));
    expect(queue.pending().map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("is idempotent on enqueue by instruction id", () => {
    const queue = new InstructionQueue();
    queue.enqueue(instruction("dup", "queue", "first"));
    const existing = queue.enqueue(instruction("dup", "queue", "second"));
    expect(existing.text).toBe("first");
    expect(queue.pending().map((entry) => entry.id)).toEqual(["dup"]);
  });

  it("orders steer entries before queue entries, both FIFO", () => {
    const queue = new InstructionQueue();
    queue.enqueue(instruction("q1", "queue"));
    queue.enqueue(instruction("s1", "steer"));
    queue.enqueue(instruction("q2", "queue"));
    queue.enqueue(instruction("s2", "steer"));
    expect(queue.pending().map((entry) => entry.id)).toEqual([
      "s1",
      "s2",
      "q1",
      "q2",
    ]);
  });

  it("cancels a pending entry and reports whether it existed", () => {
    const queue = new InstructionQueue();
    queue.enqueue(instruction("a", "queue"));
    queue.enqueue(instruction("b", "queue"));
    expect(queue.cancel("a")).toBe(true);
    expect(queue.cancel("a")).toBe(false);
    expect(queue.pending().map((entry) => entry.id)).toEqual(["b"]);
  });

  it("removes entries when delivered or declined", () => {
    const queue = new InstructionQueue();
    queue.enqueue(instruction("a", "queue"));
    queue.enqueue(instruction("b", "steer"));
    expect(queue.markDelivered("a")).toBe(true);
    expect(queue.markDeclined("b")).toBe(true);
    expect(queue.markDelivered("a")).toBe(false);
    expect(queue.pending()).toEqual([]);
  });

  it("normalizes a missing mode to queue", () => {
    const queue = new InstructionQueue();
    queue.enqueue({ id: "n", sessionId: "s1", text: "hi" } as AgentInstruction);
    expect(queue.pending()[0]?.mode).toBe("queue");
  });  it("rejects an empty instruction id", () => {
    const queue = new InstructionQueue();
    expect(() =>
      queue.enqueue({ id: " ", sessionId: "s1", text: "x", mode: "queue" }),
    ).toThrow(/non-empty/);
  });

  it("notifies onChange with the pending snapshot after each mutation", () => {
    const onChange = vi.fn<(pending: readonly AgentInstruction[]) => void>();
    const queue = new InstructionQueue({ onChange });
    queue.enqueue(instruction("a", "queue"));
    queue.enqueue(instruction("b", "queue"));
    queue.cancel("a");
    queue.markDelivered("b");
    expect(onChange).toHaveBeenCalledTimes(4);
    expect(onChange.mock.calls[2]?.[0].map((entry) => entry.id)).toEqual(["b"]);
    expect(onChange.mock.calls[3]?.[0]).toEqual([]);
  });

  it("persists pending entries through the injected store", () => {
    const stored: AgentInstruction[] = [];
    const store: InstructionStore = {
      load: () => stored,
      save: (entries) => {
        stored.splice(0, stored.length, ...entries);
      },
    };
    const queue = new InstructionQueue({ store });
    queue.enqueue(instruction("a", "queue"));
    queue.enqueue(instruction("b", "queue"));
    queue.markDelivered("a");
    expect(stored.map((entry) => entry.id)).toEqual(["b"]);
  });

  it("restores pending entries from the injected store on construction", () => {
    const store: InstructionStore = {
      load: () => [instruction("pre", "queue")],
      save: () => undefined,
    };
    const queue = new InstructionQueue({ store });
    expect(queue.pending().map((entry) => entry.id)).toEqual(["pre"]);
  });
});
