import { describe, expect, it } from "vitest";

import {
  addCaptureFields,
  fixtureLines,
  FIXTURE_NAMES,
  loadFixtureTrace,
  stripCaptureFields,
} from "../test-support/fixture-rows.js";
import { rowsFromPipelineRecords } from "./rows.js";

describe("rowsFromPipelineRecords", () => {
  it("classifies each record and numbers rows from firstSeq", () => {
    const fact = { type: "file_changed", repoId: "r", sessionId: "s", ts: "2026-09-18T09:00:01.000Z", path: "a.ts", kind: "added" };
    const claim = { type: "file_changed", sessionId: "s", ts: "2026-09-18T09:00:02.000Z", path: "a.ts" };
    const decision = {
      id: "dec-1",
      sessionId: "s",
      title: "t",
      context: "",
      severity: "optional",
      options: [],
      affectedChangeUnits: [],
      evidence: [],
      status: "open",
    };
    const rows = rowsFromPipelineRecords([fact, claim, decision], { firstSeq: 10, factId: () => "fact_x" });
    expect(rows.map((row) => [row.seq, row.type, row.ts, row.factId])).toEqual([
      [10, "evidence_fact", "2026-09-18T09:00:01.000Z", "fact_x"],
      [11, "agent_event", "2026-09-18T09:00:02.000Z", undefined],
      [12, "decision", "2026-09-18T09:00:02.000Z", undefined],
    ]);
    expect(rows[0]?.payload).toBe(fact);
  });

  it("throws a TypeError on a record that matches no schema", () => {
    expect(() => rowsFromPipelineRecords([{ hello: "world" }])).toThrow(TypeError);
  });

  it("yields one row per oauth fixture line, seq 1..N in line order", () => {
    const lines = fixtureLines("oauth");
    const rows = rowsFromPipelineRecords(lines.map((line) => JSON.parse(line) as unknown));
    expect(rows).toHaveLength(lines.length);
    expect(rows.map((row) => row.seq)).toEqual(lines.map((_, index) => index + 1));
    expect(rows.every((row) => row.ts !== "")).toBe(true);
  });
});

describe("fixture harness", () => {
  it.each(FIXTURE_NAMES)("loads %s with record rows first, then change_unit and validation rows", (name) => {
    const trace = loadFixtureTrace(name);
    const lines = fixtureLines(name);
    const derived = trace.rows.slice(lines.length);
    expect(trace.rows.slice(0, lines.length).every((row) => row.type !== "change_unit" && row.type !== "validation")).toBe(true);
    expect(derived.length).toBeGreaterThan(0);
    expect(derived.every((row) => row.type === "change_unit" || row.type === "validation")).toBe(true);
    expect(trace.rows.map((row) => row.seq)).toEqual(trace.rows.map((_, index) => index + 1));
    expect(trace.meta).toMatchObject({ state: "completed", lastEventSeq: trace.rows.length });
    const facts = trace.rows.filter((row) => row.type === "evidence_fact");
    expect(facts.every((row) => row.factId?.startsWith("fact_"))).toBe(true);
  });

  it("strips and adds the M1 capture fields", () => {
    const trace = loadFixtureTrace("oauth");
    const legacy = stripCaptureFields(trace.rows);
    expect(legacy.some((row) => row.factId !== undefined)).toBe(false);
    expect(legacy.some((row) => JSON.stringify(row.payload).includes("callId"))).toBe(false);
    const captured = addCaptureFields(legacy);
    const started = captured.find((row) => (row.payload as Record<string, unknown>)["type"] === "command_started");
    const completed = captured.find((row) => (row.payload as Record<string, unknown>)["type"] === "command_completed");
    const callId = (started?.payload as Record<string, unknown>)["callId"];
    expect(typeof callId).toBe("string");
    expect((completed?.payload as Record<string, unknown>)["callId"]).toBe(callId);
    const executed = captured.find((row) => (row.payload as Record<string, unknown>)["type"] === "command_executed");
    expect((executed?.payload as Record<string, unknown>)["sourceCallId"]).toBe(callId);
  });
});
