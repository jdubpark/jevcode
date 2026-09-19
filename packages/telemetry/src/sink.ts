import { TelemetryEventSchema, type TelemetryEvent } from "./events.js";

export interface TelemetrySink {
  append(event: TelemetryEvent): void;
  flush(): void;
  events(): readonly TelemetryEvent[];
  count(): number;
}

export interface InMemoryTelemetrySinkOptions {
  batchSize?: number;
}

export class InMemoryTelemetrySink implements TelemetrySink {
  private readonly batchSize: number;

  private pending: TelemetryEvent[] = [];

  private committed: TelemetryEvent[] = [];

  constructor(options: InMemoryTelemetrySinkOptions = {}) {
    this.batchSize = Math.max(0, Math.trunc(options.batchSize ?? 0));
  }

  append(event: TelemetryEvent): void {
    const validated = TelemetryEventSchema.parse(event);
    if (this.batchSize === 0) {
      this.committed.push(validated);
      return;
    }
    this.pending.push(validated);
    if (this.pending.length >= this.batchSize) {
      this.flush();
    }
  }

  flush(): void {
    if (this.pending.length === 0) return;
    this.committed.push(...this.pending);
    this.pending = [];
  }

  events(): readonly TelemetryEvent[] {
    return [...this.committed];
  }

  pendingCount(): number {
    return this.pending.length;
  }

  count(): number {
    return this.committed.length;
  }
}
