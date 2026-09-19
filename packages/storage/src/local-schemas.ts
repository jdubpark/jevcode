import { z } from "zod";

import {
  JsonRenderSpecSchema,
  SemanticEventSchema,
  UIIntentSchema,
} from "@jevcode/contracts";

export const FailureRecordSchema = z.object({
  id: z.string().min(1).optional(),
  validationId: z.string().min(1),
  sessionId: z.string().min(1),
  file: z.string().min(1),
  testName: z.string().min(1),
  message: z.string(),
  ts: z.string(),
});

export type FailureRecord = z.infer<typeof FailureRecordSchema>;

export const UiIntentRecordSchema = z.object({
  id: z.string().min(1).optional(),
  sessionId: z.string().min(1),
  changeUnitId: z.string().min(1),
  intent: UIIntentSchema,
  ts: z.string(),
});

export type UiIntentRecord = z.infer<typeof UiIntentRecordSchema>;

export const UiSnapshotSchema = z.object({
  id: z.string().min(1).optional(),
  sessionId: z.string().min(1),
  surfaceId: z.string().min(1),
  changeUnitId: z.string().min(1).optional(),
  semanticEventId: z.string().min(1).optional(),
  intent: UIIntentSchema.optional(),
  spec: JsonRenderSpecSchema,
  ts: z.string(),
});

export type UiSnapshot = z.infer<typeof UiSnapshotSchema>;

export const GraphNodeRecordSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  nodeType: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  ts: z.string(),
});

export type GraphNodeRecord = z.infer<typeof GraphNodeRecordSchema>;

export const GraphEdgeRecordSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  fromId: z.string().min(1),
  toId: z.string().min(1),
  edgeType: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional(),
  ts: z.string(),
});

export type GraphEdgeRecord = z.infer<typeof GraphEdgeRecordSchema>;

export const CommandRecordSchema = z.object({
  id: z.string().min(1).optional(),
  sessionId: z.string().min(1),
  command: z.string().min(1),
  exitCode: z.number().int().optional(),
  isDestructive: z.boolean(),
  ts: z.string(),
});

export type CommandRecord = z.infer<typeof CommandRecordSchema>;

export const SemanticEventRecordSchema = SemanticEventSchema;

export type SemanticEventRecord = z.infer<typeof SemanticEventRecordSchema>;

export const TelemetryEventSchema = z.object({
  id: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  ts: z.string(),
});

export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;

export const PreferenceRecordSchema = z.object({
  key: z.string().min(1),
  value: z.unknown(),
  updatedAt: z.string(),
});

export type PreferenceRecord = z.infer<typeof PreferenceRecordSchema>;
