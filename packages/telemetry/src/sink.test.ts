import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createTelemetryEvent } from "./events.js";
import { InMemoryTelemetrySink } from "./sink.js";

function event(id: string, ts: string) {
  return createTelemetryEvent("sess-test", { type: "diff_opened" }, { id, ts });
}

describe("InMemoryTelemetrySink", () => {
  it("appends events in order and reports count", () => {
    const sink = new InMemoryTelemetrySink();
    const a = event("tel-a", "2026-09-19T00:00:01.000Z");
    const b = event("tel-b", "2026-09-19T00:00:02.000Z");
    sink.append(a);
    sink.append(b);
    expect(sink.count()).toBe(2);
    expect(sink.events().map((e) => e.id)).toEqual(["tel-a", "tel-b"]);
  });

  it("rejects invalid events on append", () => {
    const sink = new InMemoryTelemetrySink();
    expect(() =>
      sink.append({
        id: "tel-1",
        sessionId: "sess-test",
        ts: "2026-09-19T00:00:00.000Z",
        type: "surface_shown",
        specHash: "h",
        confidence: 0.4,
        renderMode: "not-a-mode",
      } as never),
    ).toThrow(z.ZodError);
    expect(sink.count()).toBe(0);
  });

  it("returns a snapshot copy of committed events", () => {
    const sink = new InMemoryTelemetrySink();
    sink.append(event("tel-a", "2026-09-19T00:00:01.000Z"));
    const snapshot = sink.events();
    sink.append(event("tel-b", "2026-09-19T00:00:02.000Z"));
    expect(snapshot.length).toBe(1);
  });

  describe("batching", () => {
    it("holds events in pending until the batch size is reached", () => {
      const sink = new InMemoryTelemetrySink({ batchSize: 3 });
      sink.append(event("tel-a", "2026-09-19T00:00:01.000Z"));
      sink.append(event("tel-b", "2026-09-19T00:00:02.000Z"));
      expect(sink.count()).toBe(0);
      expect(sink.pendingCount()).toBe(2);
      expect(sink.events()).toEqual([]);
    });

    it("auto-flushes when the batch is full", () => {
      const sink = new InMemoryTelemetrySink({ batchSize: 3 });
      sink.append(event("tel-a", "2026-09-19T00:00:01.000Z"));
      sink.append(event("tel-b", "2026-09-19T00:00:02.000Z"));
      sink.append(event("tel-c", "2026-09-19T00:00:03.000Z"));
      expect(sink.count()).toBe(3);
      expect(sink.pendingCount()).toBe(0);
      expect(sink.events().map((e) => e.id)).toEqual([
        "tel-a",
        "tel-b",
        "tel-c",
      ]);
    });

    it("flush drains pending below the threshold and is idempotent", () => {
      const sink = new InMemoryTelemetrySink({ batchSize: 5 });
      sink.append(event("tel-a", "2026-09-19T00:00:01.000Z"));
      sink.append(event("tel-b", "2026-09-19T00:00:02.000Z"));
      sink.flush();
      expect(sink.count()).toBe(2);
      expect(sink.pendingCount()).toBe(0);
      sink.flush();
      expect(sink.count()).toBe(2);
    });

    it("treats non-positive batch sizes as unbuffered", () => {
      const sink = new InMemoryTelemetrySink({ batchSize: -2 });
      sink.append(event("tel-a", "2026-09-19T00:00:01.000Z"));
      expect(sink.count()).toBe(1);
    });
  });
});
