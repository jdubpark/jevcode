import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { NormalizedAgentEventSchema, type NormalizedAgentEvent } from "@jevcode/contracts";

import { CodexAdapter } from "./codex-adapter.js";

const FAKE_BIN = fileURLToPath(
  new URL("../test/fixtures/fake-codex.cjs", import.meta.url),
);

let fakeCwd = "";

const openAdapters: CodexAdapter[] = [];

function createAdapter(): CodexAdapter {
  const adapter = new CodexAdapter({ binPath: FAKE_BIN });
  openAdapters.push(adapter);
  return adapter;
}

function collect(
  adapter: CodexAdapter,
): { events: NormalizedAgentEvent[]; exited: Promise<number> } {
  const events: NormalizedAgentEvent[] = [];
  adapter.onEvent((e) => {
    NormalizedAgentEventSchema.parse(e);
    events.push(e);
  });
  const exited = new Promise<number>((resolve) => {
    adapter.onExit((code) => resolve(code));
  });
  return { events, exited };
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 5000,
  label = "condition",
): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const sessionInput = () => ({
  repoPath: fakeCwd,
  cwd: fakeCwd,
  prompt: "add a function",
  env: {},
});

type AgentMessageEvent = Extract<NormalizedAgentEvent, { type: "agent_message" }>;

const resumeEvents = (events: NormalizedAgentEvent[]): AgentMessageEvent[] =>
  events.filter(
    (e): e is AgentMessageEvent =>
      e.type === "agent_message" &&
      e.text.startsWith("resumed thread fake-thread-123"),
  );

beforeAll(() => {
  fakeCwd = mkdtempSync(join(tmpdir(), "jevcode-codex-delivery-test-"));
});

afterEach(() => {
  for (const adapter of openAdapters.splice(0)) {
    void adapter.stop();
  }
});

describe("CodexAdapter instruction delivery semantics", () => {
  it("steer mode delivers immediately via a resume relaunch", async () => {
    const adapter = createAdapter();
    const { events, exited } = collect(adapter);
    const session = await adapter.startSession(sessionInput());
    await exited;
    await waitFor(() => adapter.getThreadId() === "fake-thread-123", 5000, "thread id");

    const status = await adapter.sendInstruction({
      id: "steer-1",
      sessionId: session.sessionId,
      text: "stop using axios and use fetch",
      mode: "steer",
    });

    expect(status).toBe("delivered");
    await waitFor(
      () => resumeEvents(events).some((e) => e.text.includes("stop using axios and use fetch")),
      5000,
      "steer delivered via resume",
    );
    expect(adapter.getThreadId()).toBe("fake-thread-123");
    expect(adapter.pendingInstructions()).toEqual([]);
  });

  it("steer mode terminates a running turn and relaunches with the instruction", async () => {
    const adapter = createAdapter();
    const { events } = collect(adapter);
    const session = await adapter.startSession(sessionInput());

    const status = await adapter.sendInstruction({
      id: "steer-2",
      sessionId: session.sessionId,
      text: "change course now",
      mode: "steer",
    });

    expect(status).toBe("delivered");
    await waitFor(
      () => resumeEvents(events).some((e) => e.text.includes("change course now")),
      5000,
      "steer relaunch while running",
    );
    expect(events.filter((e) => e.type === "agent_started").length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.type === "agent_failed")).toBe(false);
  });

  it("queue mode holds the instruction and delivers one after completion", async () => {
    const adapter = createAdapter();
    const { events, exited } = collect(adapter);
    const session = await adapter.startSession(sessionInput());

    const status = await adapter.sendInstruction({
      id: "q-1",
      sessionId: session.sessionId,
      text: "add a divide function",
      mode: "queue",
    });

    expect(status).toBe("queued");
    expect(adapter.pendingInstructions().map((i) => i.id)).toEqual(["q-1"]);

    await exited;
    await waitFor(
      () => resumeEvents(events).some((e) => e.text.includes("add a divide function")),
      5000,
      "queued instruction delivered after agent_completed",
    );
    await waitFor(() => adapter.pendingInstructions().length === 0, 5000, "queue drained");
  });

  it("caps auto-relaunches after a completion at one, leaving the rest queued", async () => {
    const adapter = createAdapter();
    const { events } = collect(adapter);
    const session = await adapter.startSession(sessionInput());

    await adapter.sendInstruction({ id: "q-a", sessionId: session.sessionId, text: "one", mode: "queue" });
    await adapter.sendInstruction({ id: "q-b", sessionId: session.sessionId, text: "two", mode: "queue" });

    await waitFor(
      () => events.filter((e) => e.type === "agent_completed").length >= 2,
      5000,
      "original turn plus one auto-relaunched turn completed",
    );

    expect(resumeEvents(events).length).toBe(1);
    expect(adapter.pendingInstructions().map((i) => i.id)).toEqual(["q-b"]);
    expect(events.filter((e) => e.type === "agent_started").length).toBe(2);
  });

  it("delivers one queued instruction per resume() call", async () => {
    const adapter = createAdapter();
    const { events, exited } = collect(adapter);
    const session = await adapter.startSession(sessionInput());

    await adapter.sendInstruction({ id: "q-c", sessionId: session.sessionId, text: "first extra", mode: "queue" });
    await adapter.sendInstruction({ id: "q-d", sessionId: session.sessionId, text: "second extra", mode: "queue" });

    await exited;
    await waitFor(() => resumeEvents(events).length === 1, 5000, "auto-relay of first queued");

    await adapter.resume();
    await waitFor(() => resumeEvents(events).length === 2, 5000, "resume() delivers next queued");
    expect(resumeEvents(events)[1]?.text).toContain("second extra");
    expect(adapter.pendingInstructions()).toEqual([]);
  });

  it("keeps queued instructions when interrupted", async () => {
    const adapter = createAdapter();
    const { events } = collect(adapter);
    const session = await adapter.startSession(sessionInput());

    await adapter.sendInstruction({ id: "q-keep", sessionId: session.sessionId, text: "survive the interrupt", mode: "queue" });
    await adapter.interrupt();
    await waitFor(() => adapter.getState() === "failed", 5000, "failed after interrupt");
    expect(events.some((e) => e.type === "agent_failed")).toBe(true);

    expect(adapter.pendingInstructions().map((i) => i.id)).toEqual(["q-keep"]);
  });

  it("returns declined when no process and no thread id can accept the instruction", async () => {
    const adapter = new CodexAdapter({ binPath: FAKE_BIN });
    openAdapters.push(adapter);
    expect(
      await adapter.sendInstruction({ id: "dead-1", sessionId: "", text: "hi", mode: "queue" }),
    ).toBe("declined");
    expect(
      await adapter.sendInstruction({ id: "dead-2", sessionId: "", text: "hi", mode: "steer" }),
    ).toBe("declined");
  });

  it("is idempotent for a duplicate queued instruction id", async () => {
    const adapter = createAdapter();
    const { events, exited } = collect(adapter);
    const session = await adapter.startSession(sessionInput());

    expect(
      await adapter.sendInstruction({ id: "dup-1", sessionId: session.sessionId, text: "original", mode: "queue" }),
    ).toBe("queued");
    expect(
      await adapter.sendInstruction({ id: "dup-1", sessionId: session.sessionId, text: "retry", mode: "queue" }),
    ).toBe("queued");

    expect(adapter.pendingInstructions().map((i) => i.text)).toEqual(["original"]);

    await exited;
    await waitFor(
      () => resumeEvents(events).some((e) => e.text.includes("original")),
      5000,
      "original text delivered once",
    );
    expect(resumeEvents(events).filter((e) => e.text.includes("original")).length).toBe(1);
  });

  it("cancels a pending queued instruction", async () => {
    const adapter = createAdapter();
    const { exited } = collect(adapter);
    const session = await adapter.startSession(sessionInput());

    await adapter.sendInstruction({ id: "q-cancel", sessionId: session.sessionId, text: "never mind", mode: "queue" });
    expect(adapter.pendingInstructions().length).toBe(1);
    expect(adapter.cancelInstruction("q-cancel")).toBe(true);
    expect(adapter.cancelInstruction("q-cancel")).toBe(false);
    expect(adapter.pendingInstructions()).toEqual([]);

    await exited;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(adapter.pendingInstructions()).toEqual([]);
  });

  it("queues a decision without instruction as a plain decline", async () => {
    const adapter = createAdapter();
    const { events, exited } = collect(adapter);
    const session = await adapter.startSession(sessionInput());

    await adapter.sendDecision({
      decisionId: "d-decline",
      decision: { policy: "fail_open" },
      evidence: ["rate_limit_design"],
    });

    const pending = adapter.pendingInstructions();
    expect(pending.map((i) => i.id)).toEqual(["decision:d-decline"]);
    expect(pending[0]?.mode).toBe("queue");
    expect(pending[0]?.text).toContain("declined: developer declined without further instruction");

    await exited;
    await waitFor(
      () =>
        resumeEvents(events).some((e) => e.text.includes("declined: developer declined")),
      5000,
      "declined decision delivered after completion",
    );
    expect(session.sessionId).toBeTruthy();
  });
});
