import { TelemetryEventSchema, type TelemetryEvent } from "./events.js";
import type { TelemetrySink } from "./sink.js";

export function exportTelemetryJsonl(
  events: readonly TelemetryEvent[],
): string {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

export function exportSinkJsonl(sink: TelemetrySink): string {
  return exportTelemetryJsonl(sink.events());
}

export function parseTelemetryJsonl(text: string): TelemetryEvent[] {
  if (text.length === 0) return [];
  return text.split("\n").map((line, index) => {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`invalid JSON on line ${index + 1}`);
    }
    const result = TelemetryEventSchema.safeParse(raw);
    if (!result.success) {
      throw new Error(
        `invalid telemetry event on line ${index + 1}: ${result.error.message}`,
      );
    }
    return result.data;
  });
}
