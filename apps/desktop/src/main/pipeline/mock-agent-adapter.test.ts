import { describe, expect, it } from "vitest";

import type { NormalizedAgentEvent } from "@jevcode/contracts";

import { MockAgentAdapter } from "./mock-agent-adapter.js";

const TS = "2026-09-19T00:00:00.000Z";

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

describe("MockAgentAdapter", () => {
  it("survives a throwing hook and keeps the run loop alive", async () => {
    const seen: string[] = [];
    const adapter = new MockAgentAdapter(
      {
        sessionId: "sess-scripted",
        repoPath: "/tmp",
        cwd: "/tmp",
        prompt: "demo",
        entries: [
          {
            kind: "record",
            record: {
              type: "file_changed",
              repoId: "repo-x",
              sessionId: "sess-scripted",
              path: "src/a.ts",
              kind: "modified",
              ts: TS,
            },
          },
          {
            kind: "agent",
            event: {
              type: "agent_message",
              sessionId: "sess-scripted",
              role: "assistant",
              text: "still alive",
              ts: TS,
            },
          },
        ],
      },
      {
        entryDelayMs: 0,
        hooks: {
          onRecord: () => {
            throw new Error("hook boom");
          },
        },
      },
    );
    adapter.onEvent((event: NormalizedAgentEvent) => {
      seen.push(event.type);
    });
    await adapter.startSession({
      repoPath: "/tmp",
      cwd: "/tmp",
      prompt: "demo",
      env: {},
    });
    try {
      await waitFor(
        () => seen.includes("agent_message"),
        5000,
        "message after throwing hook",
      );
      expect(seen).toEqual(["agent_started", "agent_message"]);
    } finally {
      await adapter.stop();
    }
  });

  it("reports the configured exit code on stop", async () => {
    const codes: number[] = [];
    const adapter = new MockAgentAdapter(
      {
        sessionId: "sess-exit",
        repoPath: "/tmp",
        cwd: "/tmp",
        prompt: "demo",
        entries: [],
        exitCode: 3,
      },
      { entryDelayMs: 0 },
    );
    adapter.onExit((code) => codes.push(code));
    await adapter.startSession({
      repoPath: "/tmp",
      cwd: "/tmp",
      prompt: "demo",
      env: {},
    });
    await adapter.stop();
    expect(codes).toEqual([3]);
  });

  it("exits without a terminal event after the configured entry count", async () => {
    const events: string[] = [];
    const codes: number[] = [];
    const adapter = new MockAgentAdapter(
      {
        sessionId: "sess-crash",
        repoPath: "/tmp",
        cwd: "/tmp",
        prompt: "demo",
        entries: [
          {
            kind: "agent",
            event: {
              type: "agent_message",
              sessionId: "sess-crash",
              role: "assistant",
              text: "one",
              ts: TS,
            },
          },
          {
            kind: "agent",
            event: {
              type: "agent_message",
              sessionId: "sess-crash",
              role: "assistant",
              text: "two",
              ts: TS,
            },
          },
        ],
        exitAfterEntries: 1,
        exitCode: 9,
      },
      { entryDelayMs: 0 },
    );
    adapter.onEvent((event) => events.push(event.type));
    adapter.onExit((code) => codes.push(code));
    await adapter.startSession({
      repoPath: "/tmp",
      cwd: "/tmp",
      prompt: "demo",
      env: {},
    });
    await waitFor(() => codes.length === 1, 5000, "auto exit");
    expect(codes).toEqual([9]);
    expect(events).toEqual(["agent_started", "agent_message"]);
    await adapter.stop();
  });
});
