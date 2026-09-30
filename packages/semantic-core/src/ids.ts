import { createHash } from "node:crypto";

import { canonicalJson } from "@jevcode/contracts";

export function hashId(prefix: string, ...parts: string[]): string {
  const hash = createHash("sha1")
    .update(parts.join("\u0000"))
    .digest("hex")
    .slice(0, 16);
  return `${prefix}_${hash}`;
}

// Key order must not matter: the coordinator hashes the collector's object
// while storage keeps the zod-reordered copy, and the trace reader recomputes
// the id from the stored row (R3).
export function factContentId(sessionId: string, record: unknown): string {
  return hashId("fact", sessionId, canonicalJson(record));
}
