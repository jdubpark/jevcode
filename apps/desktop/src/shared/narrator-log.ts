import { z } from "zod";

export const NARRATOR_QUESTIONS = ["describeComponents", "overviewNarrative", "sessionStory", "decisionWhy"] as const;

/** One narrator call as shown in Inspect (spec §6.3). Holds counts and codes, never model text. */
export const NarratorCallRecordSchema = z.object({
  id: z.string().min(1),
  ts: z.string(),
  repoRoot: z.string(),
  question: z.enum(NARRATOR_QUESTIONS),
  model: z.string(),
  ms: z.number().int().nonnegative(),
  batchSize: z.number().int().nonnegative(),
  accepted: z.number().int().nonnegative(),
  dropped: z.number().int().nonnegative(),
  discarded: z.boolean(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
  error: z.string().nullable(),
  reasons: z.array(z.string()).max(40),
});

export type NarratorCallRecord = z.infer<typeof NarratorCallRecordSchema>;

export const NARRATOR_AVAILABILITY = ["on", "off_setting", "off_no_key", "off_env"] as const;

export type NarratorAvailability = (typeof NARRATOR_AVAILABILITY)[number];
