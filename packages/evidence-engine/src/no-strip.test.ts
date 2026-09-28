import { describe, expect, it } from "vitest";

import { canonicalJson, EvidenceFactSchema, type EvidenceFact } from "@jevcode/contracts";

import { createCommandCollector } from "./collectors/commands.js";
import { createGitCollector, type GitExec } from "./collectors/git.js";
import { createRevertDetector } from "./collectors/revert.js";
import { createTestCollector } from "./collectors/tests.js";

const opts = {
  repoId: "repo-1",
  sessionId: "sess-1",
  now: () => "2026-09-28T10:00:00.000Z",
};

// Storage and the coordinator parse facts with EvidenceFactSchema, which drops
// undeclared keys without an error. Every collector field must be declared.
function expectNoStrip(fact: EvidenceFact | null): void {
  expect(fact).not.toBeNull();
  expect(canonicalJson(EvidenceFactSchema.parse(fact))).toBe(canonicalJson(fact));
}

const GIT_RESPONSES: Record<string, string> = {
  "status --porcelain": " M src/app.ts\n",
  "diff HEAD -- src/app.ts": [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1 +1 @@",
    "-export const port = 3000;",
    "+export const port = 8080;",
    "",
  ].join("\n"),
  "diff --numstat HEAD -- src/app.ts": "1\t1\tsrc/app.ts",
};

const fakeGit: GitExec = async (args) => GIT_RESPONSES[args.join(" ")] ?? "";

describe("collector facts survive EvidenceFactSchema.parse unchanged", () => {
  it("detects a field the schema does not declare (control)", () => {
    const collector = createCommandCollector("/repo", opts);
    const fact = { ...collector.observe("pnpm test", 0)!, undeclared: "x" };
    expect(canonicalJson(EvidenceFactSchema.parse(fact))).not.toBe(canonicalJson(fact));
  });

  it("command_executed, with and without sourceCallId", () => {
    const collector = createCommandCollector("/repo", opts);
    expectNoStrip(collector.observe("pnpm test", 1, "turn_a:item_7"));
    expectNoStrip(collector.observe("rm -rf dist", 0));
  });

  it("test_result with sourceCallId", () => {
    const collector = createTestCollector("/repo", opts);
    expectNoStrip(
      collector.collect(
        "Test Files  1 failed (1)\n      Tests  1 failed | 2 passed (3)\n",
        "pnpm test",
        undefined,
        "turn_a:item_7",
      ),
    );
  });

  it("git_hunk", async () => {
    const collector = createGitCollector("/repo", "HEAD", { ...opts, execGit: fakeGit });
    const facts = await collector.collect();
    expect(facts).toHaveLength(1);
    for (const fact of facts) expectNoStrip(fact);
  });

  it("revert_detected", () => {
    const detector = createRevertDetector("/repo", opts);
    expectNoStrip(detector.observeReset(["src/app.ts"]));
  });
});
