import { createHash } from "node:crypto";

import type { GitHunkDiff } from "@jevcode/contracts";

/**
 * Turns one file's raw unified diff into the `git_hunk.diff` payload. The
 * desktop app injects a redacting, capping implementation; collectors default
 * to `notCapturedDiff` so tests and the CLI never store unredacted text.
 */
export type PrepareDiff = (file: string, rawDiff: string) => GitHunkDiff;

/** First 16 hex chars of sha256 over the raw (pre-redaction) diff: the change key. */
export function diffHash(rawDiff: string): string {
  return createHash("sha256").update(rawDiff, "utf8").digest("hex").slice(0, 16);
}

/** UTF-8 byte length of the raw diff. */
export function diffBytes(rawDiff: string): number {
  return Buffer.byteLength(rawDiff, "utf8");
}

export const notCapturedDiff: PrepareDiff = (_file, rawDiff) => ({
  hash: diffHash(rawDiff),
  bytes: diffBytes(rawDiff),
  truncated: false,
  redactions: 0,
  withheld: "not_captured",
});
