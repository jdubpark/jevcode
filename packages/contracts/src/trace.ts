import { z } from "zod";

import { AgentStateSchema } from "./agent.js";

/** Every envelope type in the events log. Moved from packages/storage/src/db.ts:53-68. */
export const EVENT_TYPES = [
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
  "overview_snapshot",
  "explainer",
] as const;

export type EventStoreType = (typeof EVENT_TYPES)[number];

export const EventStoreTypeSchema = z.enum(EVENT_TYPES);

/** The envelope types the trace fold consumes. trace:rows and trace.json carry only these. */
export const TRACE_ROW_TYPES = [
  "agent_event",
  "evidence_fact",
  "change_unit",
  "decision",
  "validation",
  "jev_decision",
  "overview_snapshot",
  "explainer",
] as const satisfies readonly EventStoreType[];

export type TraceRowType = (typeof TRACE_ROW_TYPES)[number];

export function isTraceRowType(value: string): value is TraceRowType {
  return (TRACE_ROW_TYPES as readonly string[]).includes(value);
}

/** Strings longer than this many UTF-8 bytes are clipped to head + tail (spec §5.3). */
export const TRACE_CLIP_CHARS = 16_384;
export const TRACE_LIST_SESSIONS_DEFAULT = 100;
export const TRACE_LIST_SESSIONS_MAX = 500;
export const TRACE_ROWS_PAGE_DEFAULT = 2_000;
export const TRACE_ROWS_PAGE_MAX = 5_000;
export const TRACE_PAYLOADS_MAX = 50;
export const TRACE_LIVE_POLL_MS = 1_000;

export const TraceRowSchema = z.object({
  seq: z.number().int().positive(),
  // A string, not EventStoreTypeSchema: a bundle from a newer build may carry a
  // type this build does not know. The fold records it as an unknown_row_type gap.
  type: z.string().min(1),
  // Row append time (events.ts). Payloads carry their own source time.
  ts: z.string(),
  payload: z.unknown(),
  // True when at least one string in payload was clipped (TRACE_CLIP_CHARS).
  clipped: z.boolean().optional(),
  // evidence_fact rows only: factContentId(sessionId, payload), computed in main
  // before clipping and before bundle redaction.
  factId: z.string().min(1).optional(),
});

export type TraceRow = z.infer<typeof TraceRowSchema>;

export const TraceSessionSummarySchema = z.object({
  sessionId: z.string().min(1),
  repoId: z.string().min(1),
  repoName: z.string(),
  prompt: z.string(),
  state: AgentStateSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  lastEventSeq: z.number().int().nonnegative(),
});

export type TraceSessionSummary = z.infer<typeof TraceSessionSummarySchema>;

export const TraceRowsPageSchema = z.object({
  rows: z.array(TraceRowSchema),
  // seq of the last returned row when the page is full, else null.
  nextAfterSeq: z.number().int().nonnegative().nullable(),
  // sessions.lastEventSeq, read in the same transaction as rows.
  lastSeq: z.number().int().nonnegative(),
  state: AgentStateSchema,
});

export type TraceRowsPage = z.infer<typeof TraceRowsPageSchema>;

export const TRACE_BUNDLE_FORMAT = "jevcode.trace";
/** Written by export. v2 adds overview_snapshot and explainer rows; v1 bundles have none. */
export const TRACE_BUNDLE_VERSION = 2;
/** Versions the parser reads (console-explainer spec §7). */
export const TRACE_BUNDLE_VERSIONS_SUPPORTED = [1, 2] as const;

export const TraceBundleSchema = z.object({
  format: z.literal(TRACE_BUNDLE_FORMAT),
  version: z.union([z.literal(1), z.literal(2)]),
  exportedAt: z.string(),
  redactionCount: z.number().int().nonnegative(),
  session: TraceSessionSummarySchema,
  rows: z.array(TraceRowSchema),
});

export type TraceBundle = z.infer<typeof TraceBundleSchema>;
