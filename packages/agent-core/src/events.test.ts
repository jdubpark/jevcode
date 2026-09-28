import { describe, expect, it } from "vitest";

import { NormalizedAgentEventSchema } from "@jevcode/contracts";

import {
  applyMappers,
  defaultNormalizerContext,
  validateNormalizedAgentEvent,
  type AgentEventMapper,
} from "./events.js";

const messageMapper: AgentEventMapper = (raw, ctx) => {
  if (typeof raw !== "object" || raw === null) return [];
  const candidate = raw as { text?: unknown };
  if (typeof candidate.text !== "string") return [];
  return [
    {
      type: "agent_message",
      sessionId: ctx.sessionId,
      role: "assistant",
      text: candidate.text,
      ts: ctx.now(),
    },
  ];
};

describe("event normalizer contract", () => {
  it("applies mappers in order and concatenates results", () => {
    const ctx = defaultNormalizerContext("s1");
    const events = applyMappers({ text: "hello" }, ctx, [
      messageMapper,
      messageMapper,
    ]);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.sessionId === "s1")).toBe(true);
  });

  it("drops unknown raw shapes", () => {
    const ctx = defaultNormalizerContext("s1");
    expect(applyMappers(42, ctx, [messageMapper])).toEqual([]);
    expect(applyMappers({ other: true }, ctx, [messageMapper])).toEqual([]);
  });

  it("carries the adapter turn id from the context into mapped events", () => {
    const turnMapper: AgentEventMapper = (_raw, ctx) => [
      {
        type: "agent_completed",
        sessionId: ctx.sessionId,
        ts: ctx.now(),
        ...(ctx.turnId !== undefined ? { turnId: ctx.turnId } : {}),
      },
    ];
    const ctx = { ...defaultNormalizerContext("s1"), turnId: "turn_1" };
    const [event] = applyMappers({}, ctx, [turnMapper]);
    expect(validateNormalizedAgentEvent(event!)).toMatchObject({
      type: "agent_completed",
      turnId: "turn_1",
    });
    expect(defaultNormalizerContext("s1").turnId).toBeUndefined();
  });

  it("validates emitted events against the contracts schema", () => {
    const ctx = defaultNormalizerContext("s1");
    const [event] = applyMappers({ text: "hello" }, ctx, [messageMapper]);
    expect(() => validateNormalizedAgentEvent(event!)).not.toThrow();
    expect(NormalizedAgentEventSchema.safeParse({ type: "bogus" }).success).toBe(
      false,
    );
  });
});
