import { z } from "zod";

import type { Brush, Playhead } from "../../layout/trace-index.js";
import { LEVELS, StableIdSchema } from "../../model/index.js";

const seq = z.number().int().positive();

export const PlayheadSchema: z.ZodType<Playhead> = z.union([
  z.object({ kind: z.literal("selection") }),
  z.object({ kind: z.literal("live") }),
  z.object({ kind: z.literal("free"), seq }),
]);

export const BrushSchema: z.ZodType<Brush> = z.union([
  z.object({ kind: z.literal("session") }),
  z.object({ kind: z.literal("chapter"), anchorSeq: seq }),
  z.object({ kind: z.literal("range"), fromSeq: seq, toSeq: z.union([seq, z.literal("live")]) }),
]);

export const ViewerLocationSchema = z.object({
  v: z.literal(1),
  sessionId: z.string().min(1),
  view: z.enum(["canvas", "hybrid"]).default("hybrid"),
  level: z.enum(LEVELS).default("chapter"),
  selected: StableIdSchema.optional(),
  playhead: PlayheadSchema.optional(),
  brush: BrushSchema.default({ kind: "session" }),
});
export type ViewerLocation = z.infer<typeof ViewerLocationSchema>;

/** Never throws; any failure or a different sessionId yields the defaults for sessionId. */
export function decodeLocation(raw: unknown, sessionId: string): ViewerLocation {
  const parsed = ViewerLocationSchema.safeParse(raw);
  if (parsed.success && parsed.data.sessionId === sessionId) return parsed.data;
  return ViewerLocationSchema.parse({ v: 1, sessionId: sessionId.length > 0 ? sessionId : "unknown" });
}

/** "#" + encodeURIComponent(JSON.stringify(location)). */
export function locationToHash(location: ViewerLocation): string {
  return `#${encodeURIComponent(JSON.stringify(location))}`;
}

export function locationFromHash(hash: string, sessionId: string): ViewerLocation {
  const body = hash.startsWith("#") ? hash.slice(1) : hash;
  try {
    return decodeLocation(JSON.parse(decodeURIComponent(body)), sessionId);
  } catch {
    return decodeLocation(null, sessionId);
  }
}
