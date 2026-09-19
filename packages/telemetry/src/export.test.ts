import { describe, expect, it } from "vitest";

import { createTelemetryEvent, type TelemetryEvent } from "./events.js";
import {
  exportSinkJsonl,
  exportTelemetryJsonl,
  parseTelemetryJsonl,
} from "./export.js";
import { InMemoryTelemetrySink } from "./sink.js";

const inputs = [
  {
    type: "surface_shown",
    specHash: "spec-1",
    confidence: 0.93,
    renderMode: "autonomous",
  },
  { type: "view_switched", from: "summary", to: "diff" },
  { type: "evidence_expanded" },
  { type: "diff_opened" },
  { type: "terminal_opened" },
  { type: "decision_answered" },
  { type: "decision_overridden" },
  { type: "decision_delegated" },
  { type: "surface_dismissed" },
  { type: "surface_pinned" },
  { type: "agent_event_count" },
  { type: "fact_count" },
] as const;

function sampleEvents(): TelemetryEvent[] {
  return inputs.map((input, index) =>
    createTelemetryEvent("sess-test", input, {
      id: `tel-${index}`,
      ts: "2026-09-19T00:00:00.000Z",
    }),
  );
}

describe("telemetry JSON export", () => {
  it("exports newline-delimited JSON with one event per line", () => {
    const events = sampleEvents();
    const jsonl = exportTelemetryJsonl(events);
    const lines = jsonl.split("\n");
    expect(lines.length).toBe(events.length);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { id: string };
      expect(parsed.id.startsWith("tel-")).toBe(true);
    }
  });

  it("round-trips every event type", () => {
    const events = sampleEvents();
    const parsed = parseTelemetryJsonl(exportTelemetryJsonl(events));
    expect(parsed).toEqual(events);
  });

  it("exports a sink snapshot", () => {
    const sink = new InMemoryTelemetrySink();
    sink.append(sampleEvents()[0]!);
    sink.append(sampleEvents()[1]!);
    expect(parseTelemetryJsonl(exportSinkJsonl(sink))).toHaveLength(2);
  });

  it("handles empty input", () => {
    expect(exportTelemetryJsonl([])).toBe("");
    expect(parseTelemetryJsonl("")).toEqual([]);
  });

  it("rejects malformed JSON with a line number", () => {
    const valid = JSON.stringify(sampleEvents()[0]);
    expect(() => parseTelemetryJsonl(`${valid}\nnot json`)).toThrow(/line 2/);
  });

  it("rejects schema-invalid events with a line number", () => {
    const invalid = JSON.stringify({
      id: "tel-1",
      sessionId: "sess-test",
      ts: "2026-09-19T00:00:00.000Z",
      type: "surface_shown",
      specHash: "h",
      confidence: 0.9,
      renderMode: "bananas",
    });
    expect(() => parseTelemetryJsonl(invalid)).toThrow(/line 1/);
  });
});
