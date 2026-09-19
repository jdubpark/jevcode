import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createTelemetryEvent,
  parseTelemetryEvent,
  TELEMETRY_EVENT_TYPES,
  TelemetryEventInputSchema,
  TelemetryEventSchema,
  type TelemetryEventInput,
} from "./events.js";

const validInputs: Record<string, TelemetryEventInput> = {
  surface_shown: {
    type: "surface_shown",
    specHash: "abc123",
    confidence: 0.9,
    renderMode: "autonomous",
  },
  view_switched: { type: "view_switched", from: "summary", to: "diff" },
  evidence_expanded: { type: "evidence_expanded" },
  diff_opened: { type: "diff_opened" },
  terminal_opened: { type: "terminal_opened" },
  decision_answered: { type: "decision_answered" },
  decision_overridden: { type: "decision_overridden" },
  decision_delegated: { type: "decision_delegated" },
  surface_dismissed: { type: "surface_dismissed" },
  surface_pinned: { type: "surface_pinned" },
  agent_event_count: { type: "agent_event_count" },
  fact_count: { type: "fact_count" },
  redaction: { type: "redaction", count: 1 },
};

describe("TelemetryEventSchema", () => {
  it("accepts every event type with its payload", () => {
    for (const type of TELEMETRY_EVENT_TYPES) {
      const input = validInputs[type];
      expect(input).toBeDefined();
      const event = parseTelemetryEvent({
        id: "tel-test",
        sessionId: "sess-test",
        ts: "2026-09-19T00:00:00.000Z",
        ...input,
      });
      expect(event.type).toBe(type);
    }
  });

  it("requires id, sessionId, and ts on every event", () => {
    for (const type of TELEMETRY_EVENT_TYPES) {
      const input = validInputs[type];
      const withoutId = { sessionId: "sess-test", ts: "2026-09-19T00:00:00.000Z", ...input };
      expect(TelemetryEventSchema.safeParse(withoutId).success).toBe(false);
      const withoutSession = { id: "tel-1", ts: "2026-09-19T00:00:00.000Z", ...input };
      expect(TelemetryEventSchema.safeParse(withoutSession).success).toBe(false);
    }
  });

  it("rejects surface_shown with invalid renderMode or out-of-range confidence", () => {
    const base = {
      id: "tel-1",
      sessionId: "sess-test",
      ts: "2026-09-19T00:00:00.000Z",
    };
    expect(
      TelemetryEventSchema.safeParse({
        ...base,
        type: "surface_shown",
        specHash: "h",
        confidence: 0.5,
        renderMode: "fancy",
      }).success,
    ).toBe(false);
    expect(
      TelemetryEventSchema.safeParse({
        ...base,
        type: "surface_shown",
        specHash: "h",
        confidence: 1.5,
        renderMode: "generic",
      }).success,
    ).toBe(false);
    expect(
      TelemetryEventSchema.safeParse({
        ...base,
        type: "surface_shown",
        specHash: "h",
        confidence: -0.1,
        renderMode: "generic",
      }).success,
    ).toBe(false);
  });

  it("rejects surface_shown without specHash and view_switched without to", () => {
    expect(
      TelemetryEventSchema.safeParse({
        id: "tel-1",
        sessionId: "sess-test",
        ts: "2026-09-19T00:00:00.000Z",
        type: "surface_shown",
        confidence: 0.5,
        renderMode: "generic",
      }).success,
    ).toBe(false);
    expect(
      TelemetryEventSchema.safeParse({
        id: "tel-1",
        sessionId: "sess-test",
        ts: "2026-09-19T00:00:00.000Z",
        type: "view_switched",
        from: "summary",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown event types", () => {
    expect(
      TelemetryEventSchema.safeParse({
        id: "tel-1",
        sessionId: "sess-test",
        ts: "2026-09-19T00:00:00.000Z",
        type: "not_an_event",
      }).success,
    ).toBe(false);
  });

  it("strips unknown payload fields on payload-less events (non-strict input)", () => {
    const parsed = TelemetryEventInputSchema.safeParse({
      type: "terminal_opened",
      extra: true,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({ type: "terminal_opened" });
    }
  });
});

describe("createTelemetryEvent", () => {
  it("fills id and ts with defaults", () => {
    const event = createTelemetryEvent("sess-test", { type: "diff_opened" });
    expect(event.id.startsWith("tel_")).toBe(true);
    expect(Number.isNaN(Date.parse(event.ts))).toBe(false);
    expect(event.sessionId).toBe("sess-test");
  });

  it("respects explicit id and ts", () => {
    const event = createTelemetryEvent(
      "sess-test",
      { type: "surface_pinned" },
      { id: "tel-custom", ts: "2026-09-19T10:00:00.000Z" },
    );
    expect(event.id).toBe("tel-custom");
    expect(event.ts).toBe("2026-09-19T10:00:00.000Z");
  });

  it("throws on invalid input", () => {
    expect(() =>
      createTelemetryEvent("sess-test", {
        type: "surface_shown",
        specHash: "h",
        confidence: 2,
        renderMode: "generic",
      }),
    ).toThrow(z.ZodError);
  });
});
