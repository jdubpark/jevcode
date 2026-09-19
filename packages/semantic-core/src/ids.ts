import { createHash } from "node:crypto";

export function hashId(prefix: string, ...parts: string[]): string {
  const hash = createHash("sha1")
    .update(parts.join("\u0000"))
    .digest("hex")
    .slice(0, 16);
  return `${prefix}_${hash}`;
}

export function factContentId(sessionId: string, record: unknown): string {
  return hashId("fact", sessionId, JSON.stringify(record));
}
