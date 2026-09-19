import {
  JsonRenderSpecSchema,
  RepoOpenedPayloadSchema,
  SessionStatePayloadSchema,
  UiSpecPatchPayloadSchema,
  UiSpecPayloadSchema,
} from "@jevcode/contracts";
import type { z } from "zod";

export type RepoOpenedPayload = z.infer<typeof RepoOpenedPayloadSchema>;

export type SessionStatePayload = z.infer<typeof SessionStatePayloadSchema>;

export type UiSpecPayload = z.infer<typeof UiSpecPayloadSchema>;

export type UiSpecPatchPayload = z.infer<typeof UiSpecPatchPayloadSchema>;

export type JsonRenderSpec = z.infer<typeof JsonRenderSpecSchema>;
