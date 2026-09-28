import { z } from "zod";

export const SymbolKindSchema = z.enum([
  "function",
  "class",
  "method",
  "interface",
  "type",
  "variable",
  "import",
  "export",
]);

export type SymbolKind = z.infer<typeof SymbolKindSchema>;

export const SymbolInfoSchema = z.object({
  name: z.string().min(1),
  kind: SymbolKindSchema,
  signature: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
});

export type SymbolInfo = z.infer<typeof SymbolInfoSchema>;

export const TestFailureSchema = z.object({
  file: z.string().min(1),
  testName: z.string().min(1),
  message: z.string(),
});

export type TestFailure = z.infer<typeof TestFailureSchema>;

export const DiffWithheldReasonSchema = z.enum(["secret_path", "not_captured"]);

export type DiffWithheldReason = z.infer<typeof DiffWithheldReasonSchema>;

export const GitHunkDiffSchema = z
  .object({
    // First 16 hex chars of sha256 over the raw (pre-redaction) diff; the change key.
    hash: z.string().regex(/^[0-9a-f]{16}$/),
    // UTF-8 byte length of the raw diff, so "showing 32 KB of 410 KB" is truthful.
    bytes: z.number().int().nonnegative(),
    // Redacted, capped unified diff against baseCommit. Absent when withheld.
    text: z.string().optional(),
    // True when text was cut at the last "@@" hunk boundary under 32 KiB.
    truncated: z.boolean(),
    // Number of redactions applied to text.
    redactions: z.number().int().nonnegative(),
    withheld: DiffWithheldReasonSchema.optional(),
  })
  .refine((diff) => diff.withheld === undefined || diff.text === undefined, {
    message: "a withheld diff carries no text",
  });

export type GitHunkDiff = z.infer<typeof GitHunkDiffSchema>;

const factBase = {
  repoId: z.string().min(1),
  sessionId: z.string().min(1),
  ts: z.string(),
};

export const EvidenceFactSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("git_hunk"),
    ...factBase,
    file: z.string().min(1),
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    isFormattingOnly: z.boolean(),
    isConfigOnly: z.boolean(),
    isLockfile: z.boolean(),
    diff: GitHunkDiffSchema.optional(),
  }),
  z.object({
    type: z.literal("file_changed"),
    ...factBase,
    path: z.string().min(1),
    kind: z.enum(["added", "modified", "deleted"]),
  }),
  z.object({
    type: z.literal("symbol_delta"),
    ...factBase,
    path: z.string().min(1),
    added: z.array(SymbolInfoSchema),
    removed: z.array(SymbolInfoSchema),
    modified: z.array(SymbolInfoSchema),
  }),
  z.object({
    type: z.literal("dependency_change"),
    ...factBase,
    manifest: z.string().min(1),
    added: z.array(
      z.object({ name: z.string().min(1), version: z.string().min(1) }),
    ),
    removed: z.array(
      z.object({ name: z.string().min(1), version: z.string().min(1) }),
    ),
  }),
  z.object({
    type: z.literal("test_result"),
    ...factBase,
    runner: z.string().min(1),
    command: z.string().min(1),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    failures: z.array(TestFailureSchema),
    sourceCallId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("command_executed"),
    ...factBase,
    command: z.string().min(1),
    exitCode: z.number().int(),
    isDestructive: z.boolean(),
    sourceCallId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("revert_detected"),
    ...factBase,
    files: z.array(z.string().min(1)),
  }),
]);

export type EvidenceFact = z.infer<typeof EvidenceFactSchema>;

export type EvidenceFactType = EvidenceFact["type"];
