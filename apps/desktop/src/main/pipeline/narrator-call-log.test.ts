import { NARRATOR_MODEL } from "@jevcode/jev-router";
import { describe, expect, it } from "vitest";

import { NARRATOR_RECORD_TEXT_MAX, NarratorCallRecordSchema } from "../../shared/narrator-log.js";
import type { NarratorCallRecord } from "../../shared/narrator-log.js";
import { buildNarratorCallRecord, createNarratorCallLog } from "./narrator-call-log.js";
import type { NarratorCallFacts } from "./narrator-call-log.js";

const entry = (index: number): NarratorCallRecord => ({
  id: `narr_${index}`,
  ts: "2026-10-02T09:00:00.000Z",
  repoRoot: "/r",
  question: "describeComponents",
  model: "claude-haiku-4-5-20251001",
  ms: index,
  batchSize: 20,
  accepted: 20,
  dropped: 0,
  discarded: false,
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  error: null,
  reasons: [],
});

const facts = (overrides: Partial<NarratorCallFacts> = {}): NarratorCallFacts => ({
  id: "narr_x",
  at: Date.parse("2026-10-02T09:00:00.000Z"),
  repoRoot: "/r",
  question: "describeComponents",
  model: NARRATOR_MODEL,
  ms: 840.4,
  batchSize: 2,
  accepted: 2,
  dropped: 0,
  discarded: false,
  usage: { inputTokens: 2000, outputTokens: 400 },
  error: null,
  reasons: [],
  ...overrides,
});

describe("createNarratorCallLog", () => {
  it("keeps the newest entries up to the capacity and lists newest first", () => {
    const log = createNarratorCallLog(3);
    for (let index = 1; index <= 5; index += 1) log.record(entry(index));
    expect(log.list(10).map((item) => item.id)).toEqual(["narr_5", "narr_4", "narr_3"]);
    expect(log.list(2).map((item) => item.id)).toEqual(["narr_5", "narr_4"]);
    expect(log.list(0)).toEqual([]);
  });

  it("drops an entry that fails NarratorCallRecordSchema, so Inspect never receives one, and logs the first drop once", () => {
    const logged: string[] = [];
    const log = createNarratorCallLog(10, { log: (message) => logged.push(message) });
    log.record({ ...entry(1), model: "m".repeat(NARRATOR_RECORD_TEXT_MAX + 1) });
    log.record({ ...entry(2), reasons: Array.from({ length: 41 }, () => "r") });
    log.record(entry(3));
    expect(log.list().map((item) => item.id)).toEqual(["narr_3"]);
    expect(logged).toEqual([
      "narrator_record_dropped: the narrator call log left out a call record that fails NarratorCallRecordSchema (model: too_big)",
    ]);
  });
});

describe("buildNarratorCallRecord (shared by every narrator caller)", () => {
  it("caps provider-controlled text and the reasons list, rounds the latency and prices the usage", () => {
    const record = buildNarratorCallRecord(
      facts({
        model: `claude-${"x".repeat(200)}`,
        error: "e".repeat(200),
        reasons: Array.from({ length: 60 }, (_, index) => `${index}:markup`),
      }),
    );
    expect(record).not.toBeNull();
    expect(record!.model).toHaveLength(NARRATOR_RECORD_TEXT_MAX);
    expect(record!.error).toHaveLength(NARRATOR_RECORD_TEXT_MAX);
    expect(record!.reasons).toHaveLength(40);
    expect(record).toMatchObject({ ts: "2026-10-02T09:00:00.000Z", ms: 840, costUsd: 0.004, inputTokens: 2000, outputTokens: 400 });
    expect(NarratorCallRecordSchema.safeParse(record).success).toBe(true);
  });

  it.each([
    ["a time that is not a date", { at: Number.NaN }],
    ["negative token counts", { usage: { inputTokens: -1, outputTokens: 4 } }],
    ["a fractional batch size", { batchSize: 1.5 }],
    ["an empty id", { id: "" }],
  ])("returns null for %s instead of a record Inspect would reject", (_label, overrides) => {
    expect(buildNarratorCallRecord(facts(overrides as Partial<NarratorCallFacts>))).toBeNull();
  });
});
