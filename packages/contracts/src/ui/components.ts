import { z } from "zod";

import { TestFailureSchema } from "../evidence.js";
import {
  ChangeCategorySchema,
  ChangeUnitStatusSchema,
  DecisionOptionSchema,
  SchemaChangeSchema,
  ScopeSchema,
} from "../semantic.js";
import { ActionRefSchema } from "./actions.js";

export const CATALOG_COMPONENT_NAMES = [
  "ChangeOverview",
  "BehaviorDelta",
  "ArchitectureDelta",
  "SchemaDelta",
  "CodeDiff",
  "Decision",
  "TestMatrix",
  "FailureAnalysis",
  "ExecutionTimeline",
  "Terminal",
  "DependencyDelta",
] as const;

export type CatalogComponentName = (typeof CATALOG_COMPONENT_NAMES)[number];

const confidence = () => z.number().min(0).max(1);

export const EvidenceLinkSchema = z.string().min(1);

export type EvidenceLink = z.infer<typeof EvidenceLinkSchema>;

export const FileDiffSchema = z.object({
  file: z.string().min(1),
  diff: z.string(),
});

export type FileDiff = z.infer<typeof FileDiffSchema>;

export const ChangeOverviewPropsSchema = z.object({
  title: z.string(),
  category: ChangeCategorySchema,
  status: ChangeUnitStatusSchema,
  confidence: confidence().optional(),
  scope: ScopeSchema.optional(),
  evidenceLinks: z.array(EvidenceLinkSchema).optional(),
  diffs: z.array(FileDiffSchema).optional(),
});

export type ChangeOverviewProps = z.infer<typeof ChangeOverviewPropsSchema>;

export const BehaviorDeltaPropsSchema = z.object({
  title: z.string(),
  subject: z.string(),
  before: z.string(),
  after: z.string(),
  symbols: z.array(z.string().min(1)),
  files: z.array(z.string().min(1)),
  actions: z.array(ActionRefSchema).optional(),
});

export type BehaviorDeltaProps = z.infer<typeof BehaviorDeltaPropsSchema>;

export const ArchitectureNodeKindSchema = z.enum([
  "module",
  "service",
  "route",
  "middleware",
  "config",
  "table",
  "type",
  "class",
  "function",
  "external",
]);

export type ArchitectureNodeKind = z.infer<typeof ArchitectureNodeKindSchema>;

export const ArchitectureNodeSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  kind: ArchitectureNodeKindSchema,
  path: z.string().optional(),
});

export type ArchitectureNode = z.infer<typeof ArchitectureNodeSchema>;

export const ArchitectureEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.string().optional(),
});

export type ArchitectureEdge = z.infer<typeof ArchitectureEdgeSchema>;

export const ArchitectureDeltaPropsSchema = z.object({
  title: z.string(),
  category: ChangeCategorySchema,
  status: ChangeUnitStatusSchema,
  confidence: confidence().optional(),
  scope: ScopeSchema.optional(),
  evidenceCount: z.number().int().nonnegative().optional(),
  nodes: z.array(ArchitectureNodeSchema).max(50),
  edges: z.array(ArchitectureEdgeSchema).max(50),
  actions: z.array(ActionRefSchema).optional(),
});

export type ArchitectureDeltaProps = z.infer<
  typeof ArchitectureDeltaPropsSchema
>;

export const SchemaDeltaPropsSchema = z.object({
  title: z.string(),
  migration: z.string(),
  changes: z.array(SchemaChangeSchema),
  compatibilityNote: z.string().optional(),
  actions: z.array(ActionRefSchema).optional(),
});

export type SchemaDeltaProps = z.infer<typeof SchemaDeltaPropsSchema>;

export const CodeDiffPropsSchema = z.object({
  file: z.string().min(1),
  diff: z.string(),
});

export type CodeDiffProps = z.infer<typeof CodeDiffPropsSchema>;

export const DecisionPropsSchema = z.object({
  decisionId: z.string().min(1),
  title: z.string(),
  severity: z.enum(["optional", "recommended", "required"]),
  context: z.string(),
  options: z.array(DecisionOptionSchema),
  actions: z.array(ActionRefSchema).optional(),
});

export type DecisionProps = z.infer<typeof DecisionPropsSchema>;

export const MatrixRowStatusSchema = z.enum(["passed", "failed", "skipped"]);

export type MatrixRowStatus = z.infer<typeof MatrixRowStatusSchema>;

export const MatrixRowSchema = z.object({
  name: z.string().min(1),
  status: MatrixRowStatusSchema,
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

export type MatrixRow = z.infer<typeof MatrixRowSchema>;

export const TestMatrixPropsSchema = z.object({
  title: z.string().optional(),
  summary: z.string().optional(),
  rows: z.array(MatrixRowSchema),
  actions: z.array(ActionRefSchema).optional(),
});

export type TestMatrixProps = z.infer<typeof TestMatrixPropsSchema>;

export const FailureAnalysisPropsSchema = z.object({
  title: z.string(),
  command: z.string(),
  runner: z.string(),
  exitCode: z.number().int(),
  failures: z.array(TestFailureSchema),
  linkedChangeUnits: z.array(z.string().min(1)),
  note: z.string().optional(),
  actions: z.array(ActionRefSchema).optional(),
});

export type FailureAnalysisProps = z.infer<typeof FailureAnalysisPropsSchema>;

export const TimelineEventKindSchema = z.enum([
  "agent",
  "change",
  "validation",
  "decision",
  "command",
  "failure",
]);

export type TimelineEventKind = z.infer<typeof TimelineEventKindSchema>;

export const TimelineEventSchema = z.object({
  id: z.string().min(1),
  ts: z.string(),
  label: z.string(),
  kind: TimelineEventKindSchema.optional(),
});

export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

export const ExecutionTimelinePropsSchema = z.object({
  title: z.string().optional(),
  events: z.array(TimelineEventSchema),
});

export type ExecutionTimelineProps = z.infer<
  typeof ExecutionTimelinePropsSchema
>;

export const TerminalPropsSchema = z.object({
  title: z.string().optional(),
  lines: z.array(z.string()).optional(),
});

export type TerminalProps = z.infer<typeof TerminalPropsSchema>;

export const DependencyDeltaItemSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  reason: z.string().optional(),
  usage: z.string().optional(),
});

export type DependencyDeltaItem = z.infer<typeof DependencyDeltaItemSchema>;

export const DependencyDeltaPropsSchema = z.object({
  title: z.string(),
  added: z.array(DependencyDeltaItemSchema),
  removed: z.array(DependencyDeltaItemSchema),
  actions: z.array(ActionRefSchema).optional(),
});

export type DependencyDeltaProps = z.infer<typeof DependencyDeltaPropsSchema>;
