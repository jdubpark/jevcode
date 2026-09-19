import { z } from "zod";

export const JsonRenderElementSchema = z.object({
  type: z.string().min(1),
  props: z.record(z.string(), z.unknown()).optional(),
  children: z.array(z.string()).optional(),
});

export type JsonRenderElement = z.infer<typeof JsonRenderElementSchema>;

export const JsonRenderSpecSchema = z.object({
  root: z.string().min(1),
  elements: z.record(z.string(), JsonRenderElementSchema),
});

export type JsonRenderSpec = z.infer<typeof JsonRenderSpecSchema>;

export const JsonRenderSpecPatchSchema = z.object({
  root: z.string().optional(),
  elements: z.record(z.string(), JsonRenderElementSchema),
});

export type JsonRenderSpecPatch = z.infer<typeof JsonRenderSpecPatchSchema>;
