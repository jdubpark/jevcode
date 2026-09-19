import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { NormalizedAgentEventSchema, type NormalizedAgentEvent } from "@jevcode/contracts";

import { CodexAdapter } from "./codex-adapter.js";

const STALL_BIN = fileURLToPath(
  new URL("../test/fixtures/fake-codex-stall.cjs", import.meta.url),
);

// Captured before vi.useFakeTimers() so the poll can yield to real I/O.
const realSetTimeout = setTimeout;

const realTick = (ms: number) =>
  new Promise<void>((resolve) => realSetTimeout(resolve, ms));

let fakeCwd = "";

const openAdapters: CodexAdapter[] = [];

function createAdapter(): CodexAdapter {
  const adapter = new CodexAdapter({ binPath: STALL_BIN });
  openAdapters.push(adapter);
  return adapter;
}

function collect(adapter: CodexAdapter): { events: NormalizedAgentEvent[] } {
  const events: NormalizedAgentEvent[] = [];
  adapter.onEvent((e) => {
    NormalizedAgentEventSchema.parse(e);
    events.push(e);
  });
  return { events };
}

async function waitWithFakeTimers(
  condition: () => boolean,
  maxMs = 10000,
  label = "condition",
): Promise<void> {
  let elapsed = 0;
  while (!condition()) {
    if (elapsed > maxMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await realTick(5);
    await vi.advanceTimersByTimeAsync(10);
    elapsed += 10;
  }
}

async function realWaitFor(
  condition: () => boolean,
  maxIterations = 1000,
  label = "condition",
): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    if (condition()) return;
    await realTick(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const sessionInput = () => ({
  repoPath: fakeCwd,
  cwd: fakeCwd,
  prompt: "add a function",
  env: {},
});

beforeAll(() => {
  fakeCwd = mkdtempSync(join(tmpdir(), "jevcode-codex-stall-test-"));
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.JEVCODE_AGENT_STALL_MS;
  for (const adapter of openAdapters.splice(0)) {
    void adapter.stop();
  }
});

describe("CodexAdapter PTY inactivity watchdog", () => {
  it("emits agent_waiting when the PTY is silent for JEVCODE_AGENT_STALL_MS", async () => {
    vi.useFakeTimers();
    process.env.JEVCODE_AGENT_STALL_MS = "300";
    const adapter = createAdapter();
    const { events } = collect(adapter);
    await adapter.startSession(sessionInput());

    await waitWithFakeTimers(
      () => adapter.getThreadId() === "stall-thread-1",
      5000,
      "thread id",
    );
    expect(events.some((e) => e.type === "agent_waiting")).toBe(false);

    await vi.advanceTimersByTimeAsync(400);
    expect(events.some((e) => e.type === "agent_waiting")).toBe(true);
  });

  it("stays silent when JEVCODE_AGENT_STALL_MS is unset", async () => {
    vi.useFakeTimers();
    const adapter = createAdapter();
    const { events } = collect(adapter);
    await adapter.startSession(sessionInput());

    await waitWithFakeTimers(
      () => adapter.getThreadId() === "stall-thread-1",
      5000,
      "thread id",
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(events.some((e) => e.type === "agent_waiting")).toBe(false);
  });

  it("stays silent when JEVCODE_AGENT_STALL_MS is not a positive integer", async () => {
    vi.useFakeTimers();
    process.env.JEVCODE_AGENT_STALL_MS = "abc";
    const adapter = createAdapter();
    const { events } = collect(adapter);
    await adapter.startSession(sessionInput());

    await waitWithFakeTimers(
      () => adapter.getThreadId() === "stall-thread-1",
      5000,
      "thread id",
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(events.some((e) => e.type === "agent_waiting")).toBe(false);
  });

  it("re-arms after new PTY output and can emit again after another stall", async () => {
    vi.useFakeTimers();
    process.env.JEVCODE_AGENT_STALL_MS = "200";
    const adapter = createAdapter();
    const { events } = collect(adapter);
    await adapter.startSession(sessionInput());

    await waitWithFakeTimers(
      () => adapter.getThreadId() === "stall-thread-1",
      5000,
      "thread id",
    );
    await vi.advanceTimersByTimeAsync(250);
    const waitingEvents = () => events.filter((e) => e.type === "agent_waiting");
    expect(waitingEvents().length).toBe(1);

    await realWaitFor(
      () =>
        events.some(
          (e) => e.type === "agent_message" && e.text === "stall second burst",
        ),
      1000,
      "fixture second burst",
    );
    expect(waitingEvents().length).toBe(1);

    await vi.advanceTimersByTimeAsync(250);
    expect(waitingEvents().length).toBe(2);
  });
});
