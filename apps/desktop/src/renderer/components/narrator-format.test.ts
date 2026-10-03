import { describe, expect, it } from "vitest";

import type { NarratorCallRecord } from "../../shared/narrator-log.js";
import { narratorAvailabilityLabel, narratorCallRow, narratorSettingNote } from "./narrator-format.js";

const base: NarratorCallRecord = {
  id: "narr_1",
  ts: "2026-10-02T09:00:00.000Z",
  repoRoot: "/r",
  question: "describeComponents",
  model: "claude-haiku-4-5-20251001",
  ms: 840,
  batchSize: 20,
  accepted: 18,
  dropped: 2,
  discarded: false,
  inputTokens: 2000,
  outputTokens: 400,
  costUsd: 0.004,
  error: null,
  reasons: ["3:markup", "7:uncited"],
};

describe("narrator-format", () => {
  it.each([
    ["on", "Sends to Claude Haiku: file paths, component and symbol names, dependency names, import edges and counts, package descriptions and the first README paragraph (redacted). File contents are never sent."],
    ["off_setting", "Rule-based labels only. Nothing leaves this machine."],
    ["off_no_key", "ANTHROPIC_API_KEY is not set, so labels stay rule-based. Nothing leaves this machine."],
    ["off_env", "JEVCODE_NARRATOR=off, so labels stay rule-based. Nothing leaves this machine."],
  ] as const)("says what leaves the machine only when the narrator is on (availability %s)", (availability, note) => {
    expect(narratorSettingNote(availability)).toBe(note);
  });

  it.each([
    ["on", "Narrator on · claude-haiku-4-5"],
    ["off_setting", "Off in Agent settings"],
    ["off_no_key", "Off · ANTHROPIC_API_KEY is not set"],
    ["off_env", "Off · JEVCODE_NARRATOR=off"],
  ] as const)("labels availability %s", (availability, label) => {
    expect(narratorAvailabilityLabel(availability)).toBe(label);
  });

  it.each([
    [{}, { question: "describe ×20", status: "partial", counts: "18/20", latency: "840 ms", cost: "$0.0040" }],
    [{ dropped: 0, accepted: 20 }, { status: "ok", counts: "20/20" }],
    [{ discarded: true, accepted: 0, dropped: 20 }, { status: "discarded", counts: "0/20" }],
    [{ error: "offline", costUsd: null, ms: 10_000 }, { status: "offline", cost: "—", latency: "10.0 s" }],
    [{ question: "overviewNarrative" as const, batchSize: 6 }, { question: "overview" }],
  ])("formats %j", (patch, expected) => {
    expect(narratorCallRow({ ...base, ...patch })).toMatchObject(expected);
  });
});
