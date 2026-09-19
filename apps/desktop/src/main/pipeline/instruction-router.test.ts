import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentInstructionStatePayloadSchema, MainToRendererChannels } from "@jevcode/contracts";
import type { AgentInstruction } from "@jevcode/contracts";
import { openDb } from "@jevcode/storage";
import type { JevcodeDb } from "@jevcode/storage";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  InstructionRouter,
} from "./instruction-router.js";
import type {
  InstructionDeliverer,
  InstructionDeliveryResult,
} from "./instruction-router.js";
import type { EmitFn } from "./types.js";

const SESSION = "sess_inbox";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function createDb(): JevcodeDb {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jevcode-inbox-"));
  tempDirs.push(dir);
  const db = openDb({ dbPath: path.join(dir, "inbox.db") });
  db.upsertRepository({ id: "repo_r", path: "/work/r", gitRoot: "/work/r" });
  db.createSession({ id: SESSION, repoId: "repo_r" });
  return db;
}

class FakeDeliverer implements InstructionDeliverer {
  readonly delivered: AgentInstruction[] = [];
  readonly cancelled: string[] = [];
  queued: string[] = [];
  result: InstructionDeliveryResult = "delivered";
  failDeliver = false;
  failCancel = false;

  async deliver(instruction: AgentInstruction): Promise<InstructionDeliveryResult> {
    if (this.failDeliver) throw new Error("deliverer down");
    if (this.result === "queued") this.queued.push(instruction.id);
    if (this.result === "delivered") this.delivered.push(instruction);
    return this.result;
  }

  async pending(): Promise<string[]> {
    return [...this.queued];
  }

  async cancel(instructionId: string): Promise<void> {
    if (this.failCancel) throw new Error("cancel failed");
    this.cancelled.push(instructionId);
    this.queued = this.queued.filter((id) => id !== instructionId);
  }
}

function setup(): {
  db: JevcodeDb;
  deliverer: FakeDeliverer;
  router: InstructionRouter;
  emitted: Map<string, unknown[]>;
} {
  const db = createDb();
  const deliverer = new FakeDeliverer();
  const emitted = new Map<string, unknown[]>();
  const emit: EmitFn = (channel, payload) => {
    const list = emitted.get(channel) ?? [];
    list.push(payload);
    emitted.set(channel, list);
  };
  const router = new InstructionRouter({ db, deliverer, emit });
  return { db, deliverer, router, emitted };
}

function instruction(id: string, mode: "queue" | "steer" = "queue"): AgentInstruction {
  return { id, sessionId: SESSION, mode, text: `instruction ${id}` };
}

function lastState(emitted: Map<string, unknown[]>, sessionId: string) {
  const pushes = emitted.get(MainToRendererChannels.agentInstructionState) as
    | { sessionId: string; pending: unknown[] }[]
    | undefined;
  const last = pushes?.[pushes.length - 1];
  expect(last?.sessionId).toBe(sessionId);
  return last;
}

describe("InstructionRouter.admit", () => {
  it("delivers immediately and marks the inbox row delivered", async () => {
    const { db, deliverer, router, emitted } = setup();
    await router.admit(SESSION, instruction("i1"));

    expect(deliverer.delivered.map((entry) => entry.id)).toEqual(["i1"]);
    expect(db.getInstruction(SESSION, "i1")?.status).toBe("delivered");
    expect(db.listPendingInstructions(SESSION)).toEqual([]);

    const state = lastState(emitted, SESSION);
    expect(state?.pending).toEqual([]);
    // Emitted payloads satisfy the contract schema.
    for (const push of emitted.get(MainToRendererChannels.agentInstructionState) ?? []) {
      expect(AgentInstructionStatePayloadSchema.safeParse(push).success).toBe(true);
    }
    db.close();
  });

  it("keeps the instruction pending when the agent queues it", async () => {
    const { db, deliverer, router, emitted } = setup();
    deliverer.result = "queued";
    await router.admit(SESSION, instruction("i1", "steer"));

    expect(deliverer.queued).toEqual(["i1"]);
    expect(db.getInstruction(SESSION, "i1")?.status).toBe("pending");
    const state = lastState(emitted, SESSION);
    expect(state?.pending).toEqual([
      expect.objectContaining({ id: "i1", mode: "steer" }),
    ]);
    db.close();
  });

  it("declines leave the instruction pending", async () => {
    const { db, deliverer, router, emitted } = setup();
    deliverer.result = "declined";
    await router.admit(SESSION, instruction("i1"));

    expect(db.getInstruction(SESSION, "i1")?.status).toBe("pending");
    const state = lastState(emitted, SESSION);
    expect(state?.pending.map((entry) => (entry as { id: string }).id)).toEqual(["i1"]);
    db.close();
  });

  it("keeps the instruction pending when the deliverer throws", async () => {
    const { db, deliverer, router, emitted } = setup();
    deliverer.failDeliver = true;
    await router.admit(SESSION, instruction("i1"));

    expect(db.getInstruction(SESSION, "i1")?.status).toBe("pending");
    const state = lastState(emitted, SESSION);
    expect(state?.pending.map((entry) => (entry as { id: string }).id)).toEqual(["i1"]);
    db.close();
  });

  it("is idempotent per instruction id", async () => {
    const { db, deliverer, router } = setup();
    await router.admit(SESSION, instruction("i1"));
    await router.admit(SESSION, instruction("i1"));

    expect(db.listPendingInstructions(SESSION)).toEqual([]);
    expect(deliverer.delivered.map((entry) => entry.id)).toEqual(["i1", "i1"]);
    const all = db.getInstruction(SESSION, "i1");
    expect(all?.status).toBe("delivered");
    db.close();
  });
});

describe("InstructionRouter.cancelInstruction", () => {
  it("marks cancelled, cancels at the agent, and emits state", async () => {
    const { db, deliverer, router, emitted } = setup();
    deliverer.result = "queued";
    await router.admit(SESSION, instruction("i1"));
    await router.cancelInstruction(SESSION, "i1");

    expect(db.getInstruction(SESSION, "i1")?.status).toBe("cancelled");
    expect(deliverer.cancelled).toEqual(["i1"]);
    await expect(deliverer.pending()).resolves.toEqual([]);
    const state = lastState(emitted, SESSION);
    expect(state?.pending).toEqual([]);
    db.close();
  });

  it("keeps the durable cancelled mark when the agent cancel fails", async () => {
    const { db, deliverer, router } = setup();
    deliverer.result = "queued";
    await router.admit(SESSION, instruction("i1"));
    deliverer.failCancel = true;
    await router.cancelInstruction(SESSION, "i1");

    expect(db.getInstruction(SESSION, "i1")?.status).toBe("cancelled");
    expect(db.listPendingInstructions(SESSION)).toEqual([]);
    db.close();
  });
});

describe("InstructionRouter.reloadPending", () => {
  it("re-offers durable pending instructions and emits state (boot reconciliation)", async () => {
    const { db, deliverer, router, emitted } = setup();
    deliverer.result = "declined";
    await router.admit(SESSION, instruction("i1"));
    await router.admit(SESSION, instruction("i2"));
    expect(db.listPendingInstructions(SESSION)).toHaveLength(2);

    // Simulate boot: the agent is available again and accepts both.
    deliverer.result = "delivered";
    await router.reloadPending(SESSION);

    expect(deliverer.delivered.map((entry) => entry.id)).toEqual(["i1", "i2"]);
    expect(db.listPendingInstructions(SESSION)).toEqual([]);
    const state = lastState(emitted, SESSION);
    expect(state?.pending).toEqual([]);
    db.close();
  });

  it("survives a close/reopen: pending rows reload from disk", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jevcode-inbox-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "inbox.db");

    const first = openDb({ dbPath });
    first.upsertRepository({ id: "repo_r", path: "/work/r", gitRoot: "/work/r" });
    first.createSession({ id: SESSION, repoId: "repo_r" });
    first.upsertInstruction({ sessionId: SESSION, instructionId: "i1", mode: "queue", text: "durable" });
    first.close();

    const db = openDb({ dbPath });
    const deliverer = new FakeDeliverer();
    deliverer.result = "declined";
    const emitted = new Map<string, unknown[]>();
    const emit: EmitFn = (channel, payload) => {
      const list = emitted.get(channel) ?? [];
      list.push(payload);
      emitted.set(channel, list);
    };
    const router = new InstructionRouter({ db, deliverer, emit });
    await router.reloadPending(SESSION);

    expect(db.listPendingInstructions(SESSION)).toHaveLength(1);
    const state = lastState(emitted, SESSION);
    expect(state?.pending.map((entry) => (entry as { id: string }).id)).toEqual(["i1"]);
    db.close();
  });
});

describe("InstructionRouter emit shape", () => {
  it("validates against the contract payload schema", async () => {
    const { router, emitted, deliverer, db } = setup();
    deliverer.result = "queued";
    await router.admit(SESSION, instruction("i1", "steer"));
    const push = emitted.get(MainToRendererChannels.agentInstructionState)?.at(-1);
    const parsed = AgentInstructionStatePayloadSchema.safeParse(push);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sessionId).toBe(SESSION);
      expect(parsed.data.pending).toHaveLength(1);
      expect(parsed.data.pending[0]).toMatchObject({
        id: "i1",
        mode: "steer",
        text: "instruction i1",
      });
      expect(typeof parsed.data.pending[0]?.createdAt).toBe("string");
    }
    db.close();
  });
});

describe("InstructionRouter with mocked emit", () => {
  it("uses the injected emit function", async () => {
    const { db, deliverer } = setup();
    const emit = vi.fn();
    const router = new InstructionRouter({ db, deliverer, emit });
    deliverer.result = "queued";
    await router.admit(SESSION, instruction("i1"));
    expect(emit).toHaveBeenCalledWith(MainToRendererChannels.agentInstructionState, {
      sessionId: SESSION,
      pending: [expect.objectContaining({ id: "i1" })],
    });
    db.close();
  });
});
