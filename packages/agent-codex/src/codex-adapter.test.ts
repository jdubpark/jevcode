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
const FAKE_TRANSCRIPT_BIN = fileURLToPath(
  new URL("../test/fixtures/fake-codex-transcript.cjs", import.meta.url),
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

beforeAll(() => {
  fakeCwd = mkdtempSync(join(tmpdir(), "jevcode-codex-test-"));
});

afterEach(() => {
  for (const adapter of openAdapters.splice(0)) {
    void adapter.stop();
  }
});

describe("CodexAdapter PTY integration (fake codex binary)", () => {
  it("detects the binary and reports its version", async () => {
    const adapter = createAdapter();
    const detection = await adapter.detect();
    expect(detection).toEqual({
      available: true,
      version: "0.155.1",
      path: FAKE_BIN,
    });
  });

  it("detects a missing binary", async () => {
    const adapter = new CodexAdapter({
      binPath: "/nonexistent/codex-binary",
    });
    const detection = await adapter.detect();
    expect(detection.available).toBe(false);
    expect(detection.error).toContain("not found");
  });

  it("runs a session to completion over the PTY", async () => {
    const adapter = createAdapter();
    const { events, exited } = collect(adapter);
    const session = await adapter.startSession(sessionInput());
    expect(session.agentId).toBe("codex");

    const code = await exited;

    expect(code).toBe(0);
    expect(events.map((e) => e.type)).toEqual([
      "agent_started",
      "agent_message",
      "agent_completed",
    ]);
    expect(events[1]).toMatchObject({
      type: "agent_message",
      role: "assistant",
      text: "Fake codex run complete.",
    });
    expect(adapter.getState()).toBe("completed");
  });

  it("routes a queue-mode instruction through the resume relaunch after completion", async () => {
    const adapter = createAdapter();
    const { events, exited } = collect(adapter);
    const session = await adapter.startSession(sessionInput());
    const status = await adapter.sendInstruction({
      id: "instr-1",
      sessionId: session.sessionId,
      text: "please also export a divide function",
      mode: "queue",
    });
    expect(status).toBe("queued");

    await exited;
    await waitFor(
      () =>
        events.some(
          (e) =>
            e.type === "agent_message" &&
            e.text.startsWith("resumed thread fake-thread-123") &&
            e.text.includes("please also export a divide function"),
        ),
      5000,
      "queued instruction delivered via resume",
    );

    const userTurn = events.find((e) => e.type === "agent_message" && e.role === "user");
    expect(userTurn).toMatchObject({
      type: "agent_message",
      role: "user",
      text: "please also export a divide function",
    });
  });

  it("stamps one turnId per Codex process on every event", async () => {
    const adapter = createAdapter();
    const { events, exited } = collect(adapter);
    const session = await adapter.startSession(sessionInput());
    await adapter.sendInstruction({
      id: "instr-turns",
      sessionId: session.sessionId,
      text: "then add a test",
      mode: "queue",
    });
    await exited;
    await waitFor(
      () => events.filter((e) => e.type === "agent_completed").length === 2,
      5000,
      "second turn completes",
    );

    const starts = events.filter((e) => e.type === "agent_started");
    expect(starts).toHaveLength(2);
    const [first, second] = starts.map((e) => e.turnId);
    expect(first).toMatch(/^turn_[0-9a-f]{32}$/);
    expect(second).toMatch(/^turn_[0-9a-f]{32}$/);
    expect(second).not.toBe(first);
    const secondStart = events.indexOf(starts[1]!);
    expect(events.slice(0, secondStart).every((e) => e.turnId === first)).toBe(true);
    expect(events.slice(secondStart).every((e) => e.turnId === second)).toBe(true);
  });

  it("routes a structured decision through the steer resume relaunch", async () => {
    const adapter = createAdapter();
    const { events, exited } = collect(adapter);
    await adapter.startSession(sessionInput());
    await adapter.sendDecision({
      decisionId: "d1",
      decision: { policy: "fail_open" },
      evidence: ["rate_limit_design"],
      instruction: "Proceed with fail-open.",
    });

    await exited;

    const userTurn = events.find((e) => e.type === "agent_message" && e.role === "user");
    expect(userTurn).toBeDefined();
    if (userTurn !== undefined && userTurn.type === "agent_message") {
      expect(userTurn.text).toBe(
        [
          "decision:",
          "  policy: fail_open",
          "",
          "evidence:",
          "  - rate_limit_design",
          "",
          "instruction:",
          "  Proceed with fail-open.",
          "",
        ].join("\n"),
      );
    }
    await waitFor(
      () =>
        events.some(
          (e) =>
            e.type === "agent_message" &&
            e.text.startsWith("resumed thread fake-thread-123"),
        ),
      5000,
      "steer resume relaunch",
    );
  });

  it("interrupt pauses the session and records one agent_interrupted on exit", async () => {
    const adapter = createAdapter();
    const { events, exited } = collect(adapter);
    await adapter.startSession(sessionInput());
    await adapter.interrupt();
    expect(adapter.getState()).toBe("paused");

    const code = await exited;

    expect(code).toBe(1);
    expect(adapter.getState()).toBe("paused");
    const interrupted = events.filter((e) => e.type === "agent_interrupted");
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]).toMatchObject({ type: "agent_interrupted", reason: "interrupt" });
    expect(events.some((e) => e.type === "agent_failed")).toBe(false);
  });

  it("SIGINT during a command yields one agent_interrupted", async () => {
    const adapter = new CodexAdapter({
      binPath: FAKE_BIN,
      env: { FAKE_CODEX_COMPLETE_ON_INTERRUPT: "1" },
    });
    openAdapters.push(adapter);
    const { events, exited } = collect(adapter);
    await adapter.startSession(sessionInput());
    await waitFor(
      () => events.some((e) => e.type === "command_started"),
      5000,
      "command running",
    );
    await adapter.interrupt();

    const code = await exited;

    expect(code).toBe(1);
    expect(events.map((e) => e.type)).toEqual([
      "agent_started",
      "command_started",
      "agent_interrupted",
    ]);
    expect(events[2]).toMatchObject({ reason: "interrupt", turnId: events[0]?.turnId });
    expect(adapter.getState()).toBe("paused");
  });

  it("a steer records agent_interrupted for the running turn before the relaunch", async () => {
    const adapter = new CodexAdapter({
      binPath: FAKE_BIN,
      env: { FAKE_CODEX_COMPLETE_ON_INTERRUPT: "1" },
    });
    openAdapters.push(adapter);
    const { events } = collect(adapter);
    const session = await adapter.startSession(sessionInput());
    await waitFor(
      () => events.some((e) => e.type === "command_started"),
      5000,
      "command running",
    );
    const status = await adapter.sendInstruction({
      id: "steer-1",
      sessionId: session.sessionId,
      text: "use fetch instead",
      mode: "steer",
    });
    expect(status).toBe("delivered");
    await waitFor(
      () => events.some((e) => e.type === "agent_completed"),
      5000,
      "relaunched turn completes",
    );

    const starts = events.filter((e) => e.type === "agent_started");
    const interrupted = events.filter((e) => e.type === "agent_interrupted");
    expect(starts).toHaveLength(2);
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]).toMatchObject({ reason: "steer", turnId: starts[0]?.turnId });
    expect(events.indexOf(interrupted[0]!)).toBeLessThan(events.indexOf(starts[1]!));
    expect(starts[1]?.turnId).not.toBe(starts[0]?.turnId);
    expect(events.some((e) => e.type === "agent_failed")).toBe(false);
  });

  it("captures the codex thread id from thread.started", async () => {
    const adapter = createAdapter();
    const { exited } = collect(adapter);
    await adapter.startSession(sessionInput());
    await exited;
    await waitFor(
      () => adapter.getThreadId() === "fake-thread-123",
      5000,
      "thread id capture",
    );
    expect(adapter.getThreadId()).toBe("fake-thread-123");
  });

  it("resumes an interrupted session by relaunching codex exec resume with the thread id", async () => {
    const adapter = createAdapter();
    const { events, exited } = collect(adapter);
    await adapter.startSession(sessionInput());
    await adapter.interrupt();

    const code = await exited;
    expect(code).toBe(1);
    await waitFor(
      () => events.some((e) => e.type === "agent_interrupted"),
      5000,
      "agent_interrupted after interrupt",
    );
    expect(adapter.getState()).toBe("paused");

    const exitPromise = new Promise<number>((resolve) => {
      adapter.onExit((resumeCode) => resolve(resumeCode));
    });
    await adapter.sendDecision({
      decisionId: "d1",
      decision: { policy: "fail_open" },
      evidence: ["rate_limit_design"],
      instruction: "Proceed with fail-open.",
    });

    const resumeCode = await exitPromise;
    await waitFor(
      () => events.some((e) => e.type === "agent_completed"),
      5000,
      "agent_completed after resume",
    );
    expect(resumeCode).toBe(0);

    const resumed = events.find(
      (e) => e.type === "agent_message" && e.text.startsWith("resumed thread fake-thread-123"),
    );
    expect(resumed).toBeDefined();
    if (resumed !== undefined && resumed.type === "agent_message") {
      expect(resumed.text).toContain("policy: fail_open");
    }
    expect(events.filter((e) => e.type === "agent_started").length).toBe(2);
    expect(events.filter((e) => e.type === "agent_completed").length).toBe(1);
    expect(events.filter((e) => e.type === "agent_interrupted").length).toBe(1);
    expect(events.some((e) => e.type === "agent_failed")).toBe(false);
  });

  it("stop transitions to completed without emitting agent_failed", async () => {
    const adapter = createAdapter();
    const { events, exited } = collect(adapter);
    await adapter.startSession(sessionInput());
    await adapter.stop();
    expect(adapter.getState()).toBe("completed");

    await exited;

    expect(events.some((e) => e.type === "agent_failed")).toBe(false);
    expect(events.some((e) => e.type === "agent_completed")).toBe(false);
  });

  it("rejects instructions for a different session and emits with the adapter session id", async () => {
    const adapter = createAdapter();
    const { events, exited } = collect(adapter);
    const session = await adapter.startSession(sessionInput());
    await expect(
      adapter.sendInstruction({ id: "instr-x", sessionId: "sess-other", text: "nope", mode: "queue" }),
    ).rejects.toThrow(/does not match session/);
    await adapter.sendInstruction({
      id: "instr-2",
      sessionId: session.sessionId,
      text: "please also export a divide function",
      mode: "queue",
    });
    await exited;
    await waitFor(
      () => events.some((e) => e.type === "agent_message" && e.role === "user"),
      5000,
      "user turn event",
    );
    const userTurn = events.find((e) => e.type === "agent_message" && e.role === "user");
    expect(userTurn?.sessionId).toBe(session.sessionId);
  });

  it("warns instead of silently swallowing stop/interrupt on a dead session", async () => {
    const warnings: string[] = [];
    const adapter = new CodexAdapter({
      binPath: FAKE_BIN,
      warn: (message) => warnings.push(message),
    });
    openAdapters.push(adapter);
    await adapter.stop();
    await adapter.interrupt();
    expect(warnings.some((message) => message.includes("stop() ignored"))).toBe(true);
    expect(warnings.some((message) => message.includes("interrupt() ignored"))).toBe(true);
  });

  it("uses a pinned session id when one is provided", async () => {
    const adapter = new CodexAdapter({
      binPath: FAKE_BIN,
      sessionId: "sess-pinned-0001",
    });
    openAdapters.push(adapter);
    const { events, exited } = collect(adapter);
    const session = await adapter.startSession(sessionInput());
    expect(session.sessionId).toBe("sess-pinned-0001");
    await adapter.sendInstruction({ id: "instr-3", sessionId: "sess-pinned-0001", text: "hello", mode: "queue" });
    await exited;
    await waitFor(
      () => events.some((e) => e.type === "agent_message" && e.role === "user"),
      5000,
      "user turn",
    );
    expect(events.every((e) => e.sessionId === "sess-pinned-0001")).toBe(true);
  });

  it("normalizes a transcript-format session when useJson is false", async () => {
    const adapter = new CodexAdapter({
      binPath: FAKE_TRANSCRIPT_BIN,
      useJson: false,
      sessionId: "sess-transcript-0001",
    });
    openAdapters.push(adapter);
    const { events, exited } = collect(adapter);
    await adapter.startSession(sessionInput());

    const code = await exited;
    await waitFor(
      () => events.some((e) => e.type === "command_completed"),
      5000,
      "command_completed from transcript",
    );
    expect(code).toBe(0);
    expect(events.map((e) => e.type)).toEqual([
      "agent_started",
      "command_started",
      "agent_message",
      "agent_message",
      "command_completed",
      "agent_message",
      "agent_failed",
    ]);
    const completed = events.find((e) => e.type === "command_completed");
    expect(completed).toMatchObject({ command: "pnpm test", exitCode: 0 });
  });

  it("keeps delivering events when one subscriber throws", async () => {
    const warnings: string[] = [];
    const adapter = new CodexAdapter({
      binPath: FAKE_BIN,
      warn: (message) => warnings.push(message),
    });
    openAdapters.push(adapter);
    const received: string[] = [];
    adapter.onEvent(() => {
      throw new Error("subscriber boom");
    });
    adapter.onEvent((e) => {
      received.push(e.type);
    });
    await adapter.startSession(sessionInput());
    await waitFor(
      () => received.includes("agent_completed"),
      5000,
      "second subscriber delivery",
    );
    expect(received).toContain("agent_started");
    expect(warnings.some((message) => message.includes("subscriber boom"))).toBe(true);
    await adapter.stop();
  });

  it("resolves sandbox args from options, then JEVCODE_CODEX_SANDBOX_ARGS, then the default", async () => {
    const overridden = new CodexAdapter({ binPath: FAKE_BIN, sandboxArgs: ["--sandbox"] });
    openAdapters.push(overridden);
    await overridden.startSession(sessionInput());
    expect(overridden["sandboxArgs"]).toEqual(["--sandbox"]);
    await overridden.stop();

    process.env.JEVCODE_CODEX_SANDBOX_ARGS = "--workspace-write";
    try {
      const fromEnv = new CodexAdapter({ binPath: FAKE_BIN });
      openAdapters.push(fromEnv);
      await fromEnv.startSession(sessionInput());
      expect(fromEnv["sandboxArgs"]).toEqual(["--workspace-write"]);
      await fromEnv.stop();
    } finally {
      delete process.env.JEVCODE_CODEX_SANDBOX_ARGS;
    }

    const def = new CodexAdapter({ binPath: FAKE_BIN });
    openAdapters.push(def);
    await def.startSession(sessionInput());
    expect(def["sandboxArgs"]).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
    await def.stop();
  });
});
