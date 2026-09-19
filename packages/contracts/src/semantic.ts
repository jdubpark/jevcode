import { z } from "zod";

import { SymbolKindSchema } from "./evidence.js";

export const SemanticEventKindSchema = z.enum([
  "behavior_change",
  "architecture_change",
  "api_change",
  "schema_change",
  "dependency_change",
  "security_change",
  "test_result",
  "failure",
  "decision_candidate",
  "implementation_change",
]);

export type SemanticEventKind = z.infer<typeof SemanticEventKindSchema>;

export const EvidenceRefTypeSchema = z.enum([
  "git_hunk",
  "file",
  "symbol",
  "test_output",
  "diagnostic",
  "command",
  "agent_event",
  "runtime_output",
]);

export type EvidenceRefType = z.infer<typeof EvidenceRefTypeSchema>;

export const EvidenceRefSchema = z.object({
  id: z.string().min(1),
  type: EvidenceRefTypeSchema,
  sourceId: z.string().min(1),
  description: z.string().optional(),
});

export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const SymbolRefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  kind: SymbolKindSchema,
});

export type SymbolRef = z.infer<typeof SymbolRefSchema>;

export const SemanticEventSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  kind: SemanticEventKindSchema,
  summary: z.string(),
  changeUnitId: z.string().optional(),
  evidence: z.array(EvidenceRefSchema),
  files: z.array(z.string().min(1)),
  symbols: z.array(z.string().min(1)),
  createdAt: z.string(),
});

export type SemanticEvent = z.infer<typeof SemanticEventSchema>;

export const ChangeCategorySchema = z.enum([
  "behavior",
  "architecture",
  "api",
  "schema",
  "dependency",
  "security",
  "configuration",
  "performance",
  "implementation",
  "tests",
  "documentation",
]);

export type ChangeCategory = z.infer<typeof ChangeCategorySchema>;

export const ChangeUnitStatusSchema = z.enum([
  "detected",
  "in_progress",
  "validated",
  "failed",
  "reverted",
  "superseded",
]);

export type ChangeUnitStatus = z.infer<typeof ChangeUnitStatusSchema>;

export const ScopeSchema = z.enum([
  "local",
  "module",
  "subsystem",
  "repository",
]);

export type Scope = z.infer<typeof ScopeSchema>;

export const InterfaceChangeSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  change: z.enum(["added", "modified", "removed"]),
  before: z.string().optional(),
  after: z.string().optional(),
});

export type InterfaceChange = z.infer<typeof InterfaceChangeSchema>;

export const SchemaChangeSchema = z.object({
  entity: z.string().min(1),
  entityType: z.enum([
    "table",
    "column",
    "type",
    "model",
    "field",
    "index",
    "constraint",
  ]),
  change: z.enum(["added", "modified", "removed"]),
  before: z.string().optional(),
  after: z.string().optional(),
  migration: z.string().optional(),
});

export type SchemaChange = z.infer<typeof SchemaChangeSchema>;

export const DependencyChangeSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  change: z.enum(["added", "removed", "upgraded", "downgraded"]),
  from: z.string().optional(),
  to: z.string().optional(),
  manifest: z.string().optional(),
});

export type DependencyChange = z.infer<typeof DependencyChangeSchema>;

export const BlastRadiusSchema = z.object({
  affectedFiles: z.number().int().nonnegative(),
  affectedSymbols: z.number().int().nonnegative(),
  affectedTests: z.number().int().nonnegative(),
  scope: ScopeSchema,
});

export type BlastRadius = z.infer<typeof BlastRadiusSchema>;

export const ValidationResultSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["test", "typecheck", "lint", "build"]),
  command: z.string().min(1),
  status: z.enum(["passed", "failed", "skipped"]),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  ts: z.string(),
});

export type ValidationResult = z.infer<typeof ValidationResultSchema>;

const score = () => z.number().min(0).max(1);

export const ChangeUnitSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  title: z.string(),
  intent: z.string().optional(),
  category: ChangeCategorySchema,
  status: ChangeUnitStatusSchema,
  behaviorBefore: z.string().optional(),
  behaviorAfter: z.string().optional(),
  files: z.array(z.string().min(1)),
  symbols: z.array(SymbolRefSchema),
  interfacesChanged: z.array(InterfaceChangeSchema),
  schemaChanges: z.array(SchemaChangeSchema),
  dependencyChanges: z.array(DependencyChangeSchema),
  relatedDecisions: z.array(z.string().min(1)),
  validationResults: z.array(z.string().min(1)),
  blastRadius: BlastRadiusSchema.optional(),
  importance: score().optional(),
  relevance: score().optional(),
  interruption: score().optional(),
  uncertainty: score().optional(),
  mentalModelChange: score().optional(),
  evidence: z.array(z.string().min(1)),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ChangeUnit = z.infer<typeof ChangeUnitSchema>;

export const DecisionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string(),
  tradeoffs: z
    .array(z.object({ dimension: z.string(), consequence: z.string() }))
    .optional(),
});

export type DecisionOption = z.infer<typeof DecisionOptionSchema>;

export const StructuredDecisionSchema = z.object({
  decisionId: z.string().min(1),
  decision: z.record(z.string(), z.string()),
  evidence: z.array(z.string().min(1)),
  instruction: z.string().optional(),
});

export type StructuredDecision = z.infer<typeof StructuredDecisionSchema>;

export const DecisionSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  title: z.string(),
  context: z.string(),
  severity: z.enum(["optional", "recommended", "required"]),
  options: z.array(DecisionOptionSchema),
  affectedChangeUnits: z.array(z.string().min(1)),
  evidence: z.array(z.string().min(1)),
  status: z.enum(["open", "answered", "delegated", "expired"]),
  answer: StructuredDecisionSchema.optional(),
});

export type Decision = z.infer<typeof DecisionSchema>;
