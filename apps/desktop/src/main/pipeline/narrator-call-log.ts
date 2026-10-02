import type { NarratorCallRecord } from "../../shared/narrator-log.js";

export const NARRATOR_CALL_LOG_CAPACITY = 200;

export interface NarratorCallLog {
  record(entry: NarratorCallRecord): void;
  /** Newest first. */
  list(limit?: number): NarratorCallRecord[];
}

/** In-memory ring for Inspect (deviation 9); narrator calls are per repo and never trace rows. */
export function createNarratorCallLog(capacity: number = NARRATOR_CALL_LOG_CAPACITY): NarratorCallLog {
  const entries: NarratorCallRecord[] = [];
  return {
    record(entry) {
      entries.push(entry);
      if (entries.length > capacity) entries.splice(0, entries.length - capacity);
    },
    list(limit = 50) {
      if (limit <= 0) return [];
      return entries.slice(-limit).reverse();
    },
  };
}
