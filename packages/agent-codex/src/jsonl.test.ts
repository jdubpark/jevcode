import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { NormalizedAgentEventSchema } from "@jevcode/contracts";
import { defaultNormalizerContext } from "@jevcode/agent-core";

import { callIdFor, extractCodexThreadId, mapCodexJsonlEvent } from "./jsonl.js";

const fixture = (name: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url)),
    "utf8",
  );

function parseFixture(name: string, sessionId = "s1", turnId?: string) {
  const ctx = {
    ...defaultNormalizerContext(sessionId),
    ...(turnId !== undefined ? { turnId } : {}),
  };
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
    const events = parseFixture("documented-happy-path.jsonl", "s1", "turn_a");
    expect(events).toEqual([
      {
        type: "command_started",
        sessionId: "s1",
        turnId: "turn_a",
        callId: "turn_a:item_1",
        command: "bash -lc ls",
        ts: expect.any(String),
      },
      {
        type: "command_completed",
        sessionId: "s1",
        turnId: "turn_a",
        callId: "turn_a:item_1",
        command: "bash -lc ls",
        exitCode: 0,
        stdout: "docs\nsdk\nsrc",
        stderr: "",
        ts: expect.any(String),
      },
      {
        type: "agent_message",
        sessionId: "s1",
        turnId: "turn_a",
        role: "assistant",
        text: "Repo contains docs, sdk, and examples directories.",
        ts: expect.any(String),
      },
      { type: "agent_completed", sessionId: "s1", turnId: "turn_a", ts: expect.any(String) },
    ]);
  });

  it("omits turnId and uses the bare item id when the context has no turn", () => {
    const events = parseFixture("documented-happy-path.jsonl");
    expect(events.map((event) => "turnId" in event)).toEqual([false, false, false, false]);
    expect(events[0]).toMatchObject({ type: "command_started", callId: "item_1" });
    expect("callId" in events[2]!).toBe(false);
  });

  it("maps the documented tool-rich fixture: tools, files, approvals, todo ignored", () => {
    const events = parseFixture("documented-tool-rich.jsonl");
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "agent_reasoning",
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

  it("pairs each start and completion by callId and keeps reasoning out of messages", () => {
    const events = parseFixture("documented-tool-rich.jsonl", "s1", "turn_b");
    expect(events.every((event) => event.turnId === "turn_b")).toBe(true);
    const calls = events.map((event) => ("callId" in event ? event.callId : undefined));
    expect(calls).toEqual([
      "turn_b:item_2",
      "turn_b:item_5",
      "turn_b:item_5",
      "turn_b:item_6",
      "turn_b:item_6",
      "turn_b:item_8",
      "turn_b:item_8",
      "turn_b:item_10",
      undefined,
      undefined,
    ]);
    expect(events[0]).toMatchObject({
      type: "agent_reasoning",
      text: "Plan: update the rate limiter and add a Redis dependency.",
    });
    const messages = events.filter((event) => event.type === "agent_message");
    expect(messages.map((event) => (event.type === "agent_message" ? event.text : ""))).toEqual([
      "Rate limiter is now backed by Redis with fail-open on connection error.",
    ]);
  });

  it("builds call ids only from a non-empty item id", () => {
    const ctx = { ...defaultNormalizerContext("s1"), turnId: "turn_c" };
    expect(callIdFor(ctx, "item_9")).toBe("turn_c:item_9");
    expect(callIdFor(ctx, undefined)).toBeUndefined();
    expect(callIdFor(ctx, "")).toBeUndefined();
    expect(callIdFor(defaultNormalizerContext("s1"), "item_9")).toBe("item_9");
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
