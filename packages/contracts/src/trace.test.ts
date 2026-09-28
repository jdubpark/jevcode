import { describe, expect, it } from "vitest";

import {
  EVENT_TYPES,
  EventStoreTypeSchema,
  TRACE_BUNDLE_FORMAT,
  TRACE_BUNDLE_VERSION,
  TRACE_CLIP_CHARS,
  TRACE_LIST_SESSIONS_DEFAULT,
  TRACE_LIST_SESSIONS_MAX,
  TRACE_LIVE_POLL_MS,
  TRACE_PAYLOADS_MAX,
  TRACE_ROW_TYPES,
  TRACE_ROWS_PAGE_DEFAULT,
  TRACE_ROWS_PAGE_MAX,
  TraceBundleSchema,
  TraceRowSchema,
  TraceRowsPageSchema,
  TraceSessionSummarySchema,
  isTraceRowType,
} from "./trace.js";

const summary = {
  sessionId: "sess_1",
  repoId: "repo_1",
  repoName: "demo",
  prompt: "Add Google sign-in",
  state: "completed",
  startedAt: "2026-09-28T10:00:00.000Z",
  endedAt: "2026-09-28T10:20:00.000Z",
  lastEventSeq: 3,
};

const row = {
  seq: 1,
  type: "agent_event",
  ts: "2026-09-28T10:00:00.000Z",
  payload: { type: "agent_started", sessionId: "sess_1", prompt: "Add Google sign-in", ts: "2026-09-28T10:00:00.000Z" },
};

describe("trace read-path contracts", () => {
  it("lists the fourteen event-log envelope types in storage order", () => {
    expect(EVENT_TYPES).toEqual([
      "agent_event",
      "evidence_fact",
      "change_unit",
      "decision",
      "validation",
      "failure",
      "jev_decision",
      "ui_intent",
      "ui_snapshot",
      "graph_node",
      "graph_edge",
      "command",
      "semantic_event",
      "telemetry",
    ]);
    expect(EventStoreTypeSchema.safeParse("telemetry").success).toBe(true);
    expect(EventStoreTypeSchema.safeParse("future_row").success).toBe(false);
  });

  it("serves exactly the six envelope types the fold consumes", () => {
    expect(TRACE_ROW_TYPES).toEqual([
      "agent_event",
      "evidence_fact",
      "change_unit",
      "decision",
      "validation",
      "jev_decision",
    ]);
    expect(isTraceRowType("agent_event")).toBe(true);
    expect(isTraceRowType("telemetry")).toBe(false);
    expect(isTraceRowType("graph_node")).toBe(false);
  });

  it("pins the R5 limits", () => {
    expect(TRACE_CLIP_CHARS).toBe(16_384);
    expect(TRACE_LIST_SESSIONS_MAX).toBe(500);
    expect(TRACE_ROWS_PAGE_MAX).toBe(5_000);
    expect(TRACE_PAYLOADS_MAX).toBe(50);
    expect(TRACE_LIVE_POLL_MS).toBe(1_000);
    expect(TRACE_LIST_SESSIONS_DEFAULT).toBeLessThanOrEqual(TRACE_LIST_SESSIONS_MAX);
    expect(TRACE_ROWS_PAGE_DEFAULT).toBeLessThanOrEqual(TRACE_ROWS_PAGE_MAX);
  });

  it("accepts a row type from a newer build and keeps clipped and factId", () => {
    const future = { ...row, seq: 7, type: "future_row", clipped: true, factId: "fact_abc" };
    expect(TraceRowSchema.parse(future)).toEqual(future);
  });

  it("rejects a non-positive or fractional seq and an empty type", () => {
    expect(TraceRowSchema.safeParse({ ...row, seq: 0 }).success).toBe(false);
    expect(TraceRowSchema.safeParse({ ...row, seq: 1.5 }).success).toBe(false);
    expect(TraceRowSchema.safeParse({ ...row, type: "" }).success).toBe(false);
  });

  it("parses a session summary with a null endedAt and rejects an unknown state", () => {
    expect(TraceSessionSummarySchema.parse({ ...summary, state: "running", endedAt: null }).endedAt).toBeNull();
    expect(TraceSessionSummarySchema.safeParse({ ...summary, state: "stopped" }).success).toBe(false);
  });

  it("parses a last page (nextAfterSeq null) and a full page", () => {
    const last = { rows: [row], nextAfterSeq: null, lastSeq: 3, state: "running" };
    expect(TraceRowsPageSchema.parse(last)).toEqual(last);
    expect(TraceRowsPageSchema.parse({ ...last, nextAfterSeq: 1 }).nextAfterSeq).toBe(1);
  });

  it("accepts a v1 jevcode.trace bundle and rejects other versions and formats", () => {
    const bundle = {
      format: TRACE_BUNDLE_FORMAT,
      version: TRACE_BUNDLE_VERSION,
      exportedAt: "2026-09-28T11:00:00.000Z",
      redactionCount: 2,
      session: summary,
      rows: [row],
    };
    expect(TraceBundleSchema.parse(bundle)).toEqual(bundle);
    expect(TraceBundleSchema.safeParse({ ...bundle, version: 2 }).success).toBe(false);
    expect(TraceBundleSchema.safeParse({ ...bundle, format: "jevcode.replay" }).success).toBe(false);
  });
});
