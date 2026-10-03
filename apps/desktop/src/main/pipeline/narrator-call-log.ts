import { narratorCostUsd } from "@jevcode/jev-router";
import type { NarratorUsage } from "@jevcode/jev-router";

import { NARRATOR_RECORD_TEXT_MAX, NarratorCallRecordSchema } from "../../shared/narrator-log.js";
import type { NarratorCallRecord } from "../../shared/narrator-log.js";

export const NARRATOR_CALL_LOG_CAPACITY = 200;
/** NarratorCallRecordSchema's cap on `reasons`. */
export const NARRATOR_RECORD_REASONS_MAX = 40;

export interface NarratorCallLog {
  /** Stores only records that pass NarratorCallRecordSchema; anything else is dropped. */
  record(entry: NarratorCallRecord): void;
  /** Newest first. */
  list(limit?: number): NarratorCallRecord[];
}

/** What a narrator caller knows about one call (lane 05's overview calls, lane 07's session calls). */
export interface NarratorCallFacts {
  id: string;
  /** When the call settled, epoch ms. */
  at: number;
  repoRoot: string;
  question: NarratorCallRecord["question"];
  /** The provider's model name (provider-controlled, capped here). */
  model: string;
  ms: number;
  batchSize: number;
  accepted: number;
  dropped: number;
  discarded: boolean;
  usage: NarratorUsage | null;
  error: string | null;
  reasons: readonly string[];
}

/**
 * One call record for Inspect (spec §6.3). Provider-controlled text is capped first (`model` and
 * `error` to NARRATOR_RECORD_TEXT_MAX, `reasons` to 40); a record that still fails the schema is
 * dropped (null), so one bad record can never break the Narrator tab.
 */
export function buildNarratorCallRecord(facts: NarratorCallFacts): NarratorCallRecord | null {
  const settledAt = new Date(facts.at);
  if (Number.isNaN(settledAt.getTime())) return null;
  const parsed = NarratorCallRecordSchema.safeParse({
    id: facts.id,
    ts: settledAt.toISOString(),
    repoRoot: facts.repoRoot,
    question: facts.question,
    model: facts.model.slice(0, NARRATOR_RECORD_TEXT_MAX),
    ms: Math.max(0, Math.round(facts.ms)),
    batchSize: facts.batchSize,
    accepted: facts.accepted,
    dropped: facts.dropped,
    discarded: facts.discarded,
    inputTokens: facts.usage?.inputTokens ?? null,
    outputTokens: facts.usage?.outputTokens ?? null,
    costUsd: facts.usage === null ? null : narratorCostUsd(facts.usage),
    error: facts.error === null ? null : facts.error.slice(0, NARRATOR_RECORD_TEXT_MAX),
    reasons: facts.reasons.slice(0, NARRATOR_RECORD_REASONS_MAX),
  });
  return parsed.success ? parsed.data : null;
}

/** In-memory ring for Inspect (deviation 9); narrator calls are per repo and never trace rows. */
export function createNarratorCallLog(capacity: number = NARRATOR_CALL_LOG_CAPACITY): NarratorCallLog {
  const entries: NarratorCallRecord[] = [];
  return {
    record(entry) {
      const parsed = NarratorCallRecordSchema.safeParse(entry);
      if (!parsed.success) return;
      entries.push(parsed.data);
      if (entries.length > capacity) entries.splice(0, entries.length - capacity);
    },
    list(limit = 50) {
      if (limit <= 0) return [];
      return entries.slice(-limit).reverse();
    },
  };
}
