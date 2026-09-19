import { z } from "zod";

import { ChangeCategorySchema } from "../semantic.js";

export const SkeletonInputSchema = z.object({
  surfaceId: z.string().min(1),
  title: z.string().min(1),
  category: ChangeCategorySchema.optional(),
  evidenceCount: z.number().int().nonnegative().optional(),
});

export type SkeletonInput = z.infer<typeof SkeletonInputSchema>;
