import { z } from "zod";

import { newId, nowIso } from "@jevcode/contracts";

const eventBase = {
  id: z.string().min(1),
  sessionId: z.string().min(1),
  ts: z.string(),
};

const renderModes = z.enum([
  "autonomous",
  "conservative",
  "generic",
  "suppressed",
]);

// Unknown-key policy (unified across the telemetry package and storage):
// input validation is NON-STRICT everywhere. Extra keys on an input are
// stripped by zod (never rejected), so callers can pass richer records and
// older schemas can still read newer rows; `TelemetryEventSchema` (merged
// output) applies the same stripping, and `packages/storage` persists the
// already-validated record as-is without its own type filter. The only
// hard failures are wrong `type` discriminator values and malformed
// required fields.
const eventVariants = {
  surface_shown: z.object({
    type: z.literal("surface_shown"),
    specHash: z.string().min(1),
    confidence: z.number().min(0).max(1),
    renderMode: renderModes,
  }),
  view_switched: z.object({
    type: z.literal("view_switched"),
    from: z.string().min(1),
    to: z.string().min(1),
  }),
  evidence_expanded: z.object({
    type: z.literal("evidence_expanded"),
  }),
  diff_opened: z.object({
    type: z.literal("diff_opened"),
  }),
  terminal_opened: z.object({
    type: z.literal("terminal_opened"),
  }),
  decision_answered: z.object({
    type: z.literal("decision_answered"),
  }),
  decision_overridden: z.object({
    type: z.literal("decision_overridden"),
  }),
  decision_delegated: z.object({
    type: z.literal("decision_delegated"),
  }),
  surface_dismissed: z.object({
    type: z.literal("surface_dismissed"),
  }),
  surface_pinned: z.object({
    type: z.literal("surface_pinned"),
  }),
  agent_event_count: z.object({
    type: z.literal("agent_event_count"),
  }),
  fact_count: z.object({
    type: z.literal("fact_count"),
  }),
  redaction: z.object({
    type: z.literal("redaction"),
    count: z.number().int().nonnegative(),
  }),
  model_selected: z.object({
    type: z.literal("model_selected"),
    modelId: z.string().min(1),
    reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]),
    tier: z.enum(["economy", "standard", "premium"]),
    auto: z.boolean(),
    confidence: z.number().min(0).max(1),
    rationale: z.string(),
    contextTokensEstimate: z.number().int().nonnegative(),
  }),
} as const;

const v = eventVariants;

export const TelemetryEventInputSchema = z.discriminatedUnion("type", [
  v.surface_shown,
  v.view_switched,
  v.evidence_expanded,
  v.diff_opened,
  v.terminal_opened,
  v.decision_answered,
  v.decision_overridden,
  v.decision_delegated,
  v.surface_dismissed,
  v.surface_pinned,
  v.agent_event_count,
  v.fact_count,
  v.redaction,
  v.model_selected,
]);

export const TelemetryEventSchema = z.discriminatedUnion("type", [
  z.object(eventBase).merge(v.surface_shown),
  z.object(eventBase).merge(v.view_switched),
  z.object(eventBase).merge(v.evidence_expanded),
  z.object(eventBase).merge(v.diff_opened),
  z.object(eventBase).merge(v.terminal_opened),
  z.object(eventBase).merge(v.decision_answered),
  z.object(eventBase).merge(v.decision_overridden),
  z.object(eventBase).merge(v.decision_delegated),
  z.object(eventBase).merge(v.surface_dismissed),
  z.object(eventBase).merge(v.surface_pinned),
  z.object(eventBase).merge(v.agent_event_count),
  z.object(eventBase).merge(v.fact_count),
  z.object(eventBase).merge(v.redaction),
  z.object(eventBase).merge(v.model_selected),
]);

export type TelemetryEventInput = z.infer<typeof TelemetryEventInputSchema>;

export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;

export type TelemetryEventType = TelemetryEvent["type"];

export const TELEMETRY_EVENT_TYPES: readonly TelemetryEventType[] = [
  "surface_shown",
  "view_switched",
  "evidence_expanded",
  "diff_opened",
  "terminal_opened",
  "decision_answered",
  "decision_overridden",
  "decision_delegated",
  "surface_dismissed",
  "surface_pinned",
  "agent_event_count",
  "fact_count",
  "redaction",
];

export function parseTelemetryEvent(input: unknown): TelemetryEvent {
  return TelemetryEventSchema.parse(input);
}

export function createTelemetryEvent(
  sessionId: string,
  input: TelemetryEventInput,
  options: { id?: string; ts?: string } = {},
): TelemetryEvent {
  const parsed = TelemetryEventInputSchema.parse(input);
  const event: TelemetryEvent = TelemetryEventSchema.parse({
    id: options.id ?? newId("tel"),
    sessionId,
    ts: options.ts ?? nowIso(),
    ...parsed,
  });
  return event;
}
