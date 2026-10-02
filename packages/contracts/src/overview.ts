import { z } from "zod";

// Codebase overview and session explainer contracts (console-explainer spec §5, §6.5, §7).
// Browser-safe: no Node built-ins. Text fields are untrusted data; renderers apply displayUntrusted.

/** Spec §5.4. "external" is used only for dependency chips and is not a Role. */
export const ROLES = ["ui", "api", "agent", "domain", "storage", "tests", "tooling", "config"] as const;
export type Role = (typeof ROLES)[number];
export const RoleSchema = z.enum(ROLES);

export const CitationSchema = z.object({
  kind: z.enum(["component", "file", "decision", "fact", "step"]),
  id: z.string().min(1).max(512),
});
export type Citation = z.infer<typeof CitationSchema>;

export const NarrativeSentenceSchema = z.object({
  text: z.string().min(1).max(220),
  citations: z.array(CitationSchema).min(1).max(6),
});
export type NarrativeSentence = z.infer<typeof NarrativeSentenceSchema>;

const ComponentIdSchema = z.string().regex(/^cmp_[0-9a-f]{12}$/);

export const ComponentSchema = z.object({
  id: ComponentIdSchema,
  /** Repo-relative, "/" separators, no trailing slash; "." for a flat repo. */
  rootPath: z.string().min(1).max(1024),
  name: z.string().min(1).max(120),
  fileCount: z.number().int().nonnegative(),
  /** Repo-relative, sorted; capped (fileCount carries the true count). */
  files: z.array(z.string().min(1).max(1024)).max(400),
  /** Main language by file count, e.g. "TypeScript". */
  language: z.string().max(40).nullable(),
  roleGuess: RoleSchema,
  role: RoleSchema,
  purpose: z.string().max(140).nullable(),
  provenance: z.enum(["rule", "model"]),
  contentHash: z.string().regex(/^[0-9a-f]{40}$/),
  externalDeps: z.array(z.object({ name: z.string().min(1).max(214), count: z.number().int().positive() })).max(8),
  entryPoints: z.array(z.string().min(1).max(1024)).max(8),
  /** False when no member file has a supported grammar (spec E14). */
  importsAnalyzed: z.boolean(),
});
export type Component = z.infer<typeof ComponentSchema>;

export const ComponentEdgeSchema = z.object({
  /** Component ids. */
  from: ComponentIdSchema,
  to: ComponentIdSchema,
  count: z.number().int().positive(),
  /** "a/b.ts → c/d.ts" */
  examples: z.array(z.string().max(300)).max(3),
});
export type ComponentEdge = z.infer<typeof ComponentEdgeSchema>;

export const ExternalDepSchema = z.object({
  name: z.string().min(1).max(214),
  usedBy: z.array(z.object({ componentId: ComponentIdSchema, count: z.number().int().positive() })).max(40),
});
export type ExternalDep = z.infer<typeof ExternalDepSchema>;

/** Orchestrator ruling R3. Lane 04 writes scan state; lane 05 writes narrator state; lane 06 renders. */
export const OVERVIEW_SCAN_STATES = ["running", "done", "failed"] as const;
/**
 * off = setting off; unavailable = no API key, or in failure backoff; pending = descriptions
 * being written; ready = narration for this snapshot finished (some purposes may still be null).
 */
export const NARRATOR_STATES = ["off", "unavailable", "pending", "ready"] as const;
export type NarratorState = (typeof NARRATOR_STATES)[number];

/**
 * Strict at both levels: a status carries only these fields. `error` is a short, untrusted
 * message (rendered through displayUntrusted).
 */
export const OverviewStatusSchema = z
  .object({
    scan: z
      .object({
        state: z.enum(OVERVIEW_SCAN_STATES),
        scanned: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        error: z.string().max(200).optional(),
      })
      .strict(),
    narrator: z.enum(NARRATOR_STATES),
  })
  .strict();
export type OverviewStatus = z.infer<typeof OverviewStatusSchema>;

export const OverviewSnapshotSchema = z.object({
  /** The session the row belongs to; storage requires it to match the event's session. */
  sessionId: z.string().max(256),
  repoRoot: z.string().min(1).max(1024),
  scanId: z.string().min(1).max(128),
  /** True when the 20,000-file scan cap was hit. */
  partial: z.boolean(),
  counts: z.object({
    files: z.number().int().nonnegative(),
    /** Repo files before the 20,000-file cap (ruling R3); absent on rows written before it. */
    totalFiles: z.number().int().nonnegative().optional(),
    components: z.number().int().nonnegative(),
    edges: z.number().int().nonnegative(),
    languages: z.array(z.string().max(40)).max(20),
  }),
  /**
   * Ruling R3. Absent on rows written before the field: read as scan "done", and narrator
   * "pending" if any component purpose is null, else "ready".
   */
  status: OverviewStatusSchema.optional(),
  components: z.array(ComponentSchema).max(200),
  edges: z.array(ComponentEdgeSchema).max(1000),
  externals: z.array(ExternalDepSchema).max(120),
  narrative: z
    .object({ sentences: z.array(NarrativeSentenceSchema).max(8), provenance: z.literal("model") })
    .nullable(),
  /** ISO time. */
  generatedAt: z.string().max(64),
});
export type OverviewSnapshot = z.infer<typeof OverviewSnapshotSchema>;

export const ExplainerRecordSchema = z.discriminatedUnion("kind", [
  z.object({
    sessionId: z.string().min(1).max(128),
    kind: z.literal("story"),
    sentences: z.array(NarrativeSentenceSchema).min(1).max(6),
    basisSeq: z.number().int().nonnegative(),
    // Who wrote the story; absent reads as "model" (ruling R3, lane 07 S-4 shows a rule-based story differently).
    provenance: z.enum(["rule", "model"]).optional(),
  }),
  z.object({
    sessionId: z.string().min(1).max(128),
    kind: z.literal("decision_why"),
    decisionId: z.string().min(1).max(128),
    sentence: NarrativeSentenceSchema,
  }),
  z.object({
    sessionId: z.string().min(1).max(128),
    kind: z.literal("highlights"),
    basisSeq: z.number().int().nonnegative(),
    components: z
      .array(
        z.object({
          id: ComponentIdSchema,
          state: z.enum(["new", "changed", "decision", "failing"]),
          unitIds: z.array(z.string().min(1).max(128)).max(50),
        }),
      )
      .max(200),
  }),
]);
export type ExplainerRecord = z.infer<typeof ExplainerRecordSchema>;

/** Spec §5.5: an overview_snapshot row's payload, as UTF-8 bytes of its stored JSON, never exceeds this. */
export const OVERVIEW_SNAPSHOT_MAX_BYTES = 512 * 1024;
