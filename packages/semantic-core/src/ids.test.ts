import { describe, expect, it } from "vitest";

import { EvidenceFactSchema, type EvidenceFact } from "@jevcode/contracts";

import { factContentId, hashId } from "./ids.js";

describe("factContentId", () => {
  it("gives a collector-order fact and its zod-parsed copy one id", () => {
    // Collectors put ts last; EvidenceFactSchema moves it to fourth.
    const collected: EvidenceFact = {
      type: "git_hunk",
      repoId: "repo-1",
      sessionId: "sess-1",
      file: "src/app.ts",
      added: 3,
      removed: 1,
      isFormattingOnly: false,
      isConfigOnly: false,
      isLockfile: false,
      ts: "2026-09-28T10:00:00.000Z",
    };
    const stored = EvidenceFactSchema.parse(collected);
    expect(JSON.stringify(stored)).not.toBe(JSON.stringify(collected));
    expect(factContentId("sess-1", stored)).toBe(factContentId("sess-1", collected));
  });

  it("hashes the canonical JSON of the record", () => {
    expect(factContentId("sess-1", { b: 1, a: { d: 2, c: 3 } })).toBe(
      hashId("fact", "sess-1", '{"a":{"c":3,"d":2},"b":1}'),
    );
  });
});
