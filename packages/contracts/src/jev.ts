import { z } from "zod";

import {
  ScopeSchema,
  SemanticEventKindSchema,
} from "./semantic.js";

export const AttentionDecisionSchema = z.object({
  shouldSurface: z.boolean(),
  importance: z.number().min(0).max(1),
  relevance: z.number().min(0).max(1),
  interruption: z.number().min(0).max(1),
  mentalModelChange: z.number().min(0).max(1),
  semanticCategory: SemanticEventKindSchema,
  scope: ScopeSchema,
  humanDecision: z.enum(["none", "optional", "recommended", "required"]),
  needsSystem2: z.boolean(),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
});

export type AttentionDecision = z.infer<typeof AttentionDecisionSchema>;

export const UIIntentSchema = z.object({
  attention: z.enum(["background", "surface", "highlight", "interrupt"]),
  subject: z.enum([
    "behavior",
    "architecture",
    "code",
    "schema",
    "api",
    "dependency",
    "tests",
    "decision",
    "security",
    "performance",
  ]),
  representation: z.enum([
    "summary",
    "before_after",
    "diff",
    "diagram",
    "table",
    "graph",
    "decision",
    "failure",
    "timeline",
  ]),
  density: z.enum(["compact", "normal", "detailed", "expert"]),
  confidence: z.number().min(0).max(1),
  showEvidence: z.boolean(),
  showCode: z.boolean(),
  secondaryViews: z.array(z.string()),
  renderMode: z.enum(["autonomous", "conservative", "generic", "suppressed"]),
});

export type UIIntent = z.infer<typeof UIIntentSchema>;

export const JevClientKindSchema = z.enum([
  "typesafe",
  "degrade",
  "playback",
]);

export type JevClientKind = z.infer<typeof JevClientKindSchema>;

export const JevResultSchema = z.object({
  value: z.unknown(),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number().min(0).max(1)).optional(),
  clientKind: JevClientKindSchema.optional(),
  heuristic: z.boolean().optional(),
});

export interface JevResult<T> {
  value: T;
  confidence: number;
  probabilities?: Record<string, number>;
  clientKind?: JevClientKind;
  heuristic?: boolean;
}

export const JevDecisionLogSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  changeUnitId: z.string().optional(),
  inputHash: z.string().min(1),
  output: z.unknown(),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number().min(0).max(1)).optional(),
  latencyMs: z.number().int().nonnegative(),
  clientKind: JevClientKindSchema,
  clamps: z.array(z.string()),
  ts: z.string(),
});

export type JevDecisionLog = z.infer<typeof JevDecisionLogSchema>;
