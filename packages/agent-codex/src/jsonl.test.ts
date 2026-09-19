import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { NormalizedAgentEventSchema } from "@jevcode/contracts";
import { defaultNormalizerContext } from "@jevcode/agent-core";

import { extractCodexThreadId, mapCodexJsonlEvent } from "./jsonl.js";

const fixture = (name: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url)),
    "utf8",
  );

function parseFixture(name: string, sessionId = "s1") {
  const ctx = defaultNormalizerContext(sessionId);
  const events = fixture(name)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => mapCodexJsonlEvent(JSON.parse(line), ctx));
  for (const event of events) {
    NormalizedAgentEventSchema.parse(event);
  }
  return events;
}

describe("codex JSONL parser against recorded spike fixtures", () => {
  it("maps the recorded out-of-credits run to agent_failed events", () => {
    const events = parseFixture("recorded-credits-error.jsonl");
    expect(events.length).toBe(2);
    expect(events.every((e) => e.type === "agent_failed")).toBe(true);
    for (const event of events) {
      if (event.type !== "agent_failed") continue;
      expect(event.error).toBe("codex workspace is out of credits");
    }
  });

  it("maps the recorded 401 unauthorized run to agent_failed", () => {
    const events = parseFixture("recorded-unauthorized.jsonl");
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e) => e.type === "agent_failed")).toBe(true);
    for (const event of events) {
      if (event.type !== "agent_failed") continue;
      expect(event.error).toBe("codex authentication failed (401 Unauthorized)");
    }
  });

  it("maps the documented happy path exactly", () => {
    const events = parseFixture("documented-happy-path.jsonl");
    expect(events).toEqual([
      {
        type: "command_started",
        sessionId: "s1",
        command: "bash -lc ls",
        ts: expect.any(String),
      },
      {
        type: "command_completed",
        sessionId: "s1",
        command: "bash -lc ls",
        exitCode: 0,
        stdout: "docs\nsdk\nsrc",
        stderr: "",
        ts: expect.any(String),
      },
      {
        type: "agent_message",
        sessionId: "s1",
        role: "assistant",
        text: "Repo contains docs, sdk, and examples directories.",
        ts: expect.any(String),
      },
      { type: "agent_completed", sessionId: "s1", ts: expect.any(String) },
    ]);
  });

  it("maps the documented tool-rich fixture: tools, files, approvals, todo ignored", () => {
    const events = parseFixture("documented-tool-rich.jsonl");
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "agent_message",
      "tool_started",
      "tool_completed",
      "command_started",
      "command_completed",
      "file_changed",
      "file_changed",
      "approval_requested",
      "agent_message",
      "agent_completed",
    ]);

    const toolStarted = events[1];
    expect(toolStarted).toMatchObject({
      type: "tool_started",
      tool: "github.search_code",
      input: '{"query":"rate limit"}',
    });

    const approval = events[7];
    expect(approval).toMatchObject({
      type: "approval_requested",
      command: "bash -lc rm -rf node_modules",
      rationale: "declined by approval policy",
    });

    const fileChanges = events.slice(5, 7);
    expect(fileChanges.map((e) => (e.type === "file_changed" ? e.path : null))).toEqual([
      "src/rate-limit.ts",
      "package.json",
    ]);
  });

  it("ignores unknown event types without failing", () => {
    const ctx = defaultNormalizerContext("s1");
    const events = mapCodexJsonlEvent({ type: "future.event", x: 1 }, ctx);
    expect(events).toEqual([]);
  });

  it("tolerates malformed non-JSON lines at the parser boundary", () => {
    expect(() => JSON.parse("not json")).toThrow();
    const ctx = defaultNormalizerContext("s1");
    expect(mapCodexJsonlEvent(null, ctx)).toEqual([]);
    expect(mapCodexJsonlEvent("string", ctx)).toEqual([]);
  });

  it("extracts the thread id from thread.started events only", () => {
    expect(extractCodexThreadId({ type: "thread.started", thread_id: "th-1" })).toBe("th-1");
    expect(extractCodexThreadId({ type: "thread.started", thread_id: "" })).toBeNull();
    expect(extractCodexThreadId({ type: "thread.started" })).toBeNull();
    expect(extractCodexThreadId({ type: "turn.started", thread_id: "th-1" })).toBeNull();
    expect(extractCodexThreadId("not an object")).toBeNull();
  });
});
