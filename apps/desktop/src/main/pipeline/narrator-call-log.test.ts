import { describe, expect, it } from "vitest";

import type { NarratorCallRecord } from "../../shared/narrator-log.js";
import { createNarratorCallLog } from "./narrator-call-log.js";

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

describe("createNarratorCallLog", () => {
  it("keeps the newest entries up to the capacity and lists newest first", () => {
    const log = createNarratorCallLog(3);
    for (let index = 1; index <= 5; index += 1) log.record(entry(index));
    expect(log.list(10).map((item) => item.id)).toEqual(["narr_5", "narr_4", "narr_3"]);
    expect(log.list(2).map((item) => item.id)).toEqual(["narr_5", "narr_4"]);
    expect(log.list(0)).toEqual([]);
  });
});
