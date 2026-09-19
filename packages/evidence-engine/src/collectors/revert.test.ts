import { describe, expect, it } from "vitest";

import type { GitExec } from "./git.js";
import {
  createRevertDetector,
  detectRevertInReflog,
} from "./revert.js";

const REFLOG_WITH_RESET = [
  "abc1234 HEAD@{0}: reset: moving to HEAD~1",
  "def5678 HEAD@{1}: commit: add rate limiter",
  "fed9876 HEAD@{2}: commit (initial): scaffold",
].join("\n");

const REFLOG_WITH_CHECKOUT_SHA = [
  "abc1234 HEAD@{0}: checkout: moving from main to deadbeef",
  "def5678 HEAD@{1}: commit: add rate limiter",
].join("\n");

const REFLOG_WITH_REBASE = [
  "abc1234 HEAD@{0}: rebase (finish): returning to refs/heads/main",
  "def5678 HEAD@{1}: commit: wip",
].join("\n");

const CLEAN_REFLOG = [
  "def5678 HEAD@{0}: commit: add rate limiter",
  "fed9876 HEAD@{1}: commit (initial): scaffold",
  "abc1234 HEAD@{2}: checkout: moving from main to feature/x",
].join("\n");

describe("detectRevertInReflog", () => {
  it("detects git reset entries", () => {
    expect(detectRevertInReflog(REFLOG_WITH_RESET)).toContain("reset: moving to");
  });

  it("detects checkout of a raw commit sha", () => {
    expect(detectRevertInReflog(REFLOG_WITH_CHECKOUT_SHA)).toContain("checkout:");
  });

  it("detects rebase finishes", () => {
    expect(detectRevertInReflog(REFLOG_WITH_REBASE)).toContain("rebase");
  });

  it("ignores ordinary commits and branch checkouts", () => {
    expect(detectRevertInReflog(CLEAN_REFLOG)).toBeNull();
  });
});

describe("createRevertDetector", () => {
  const opts = {
    repoId: "repo-1",
    sessionId: "sess-1",
    now: () => "2026-01-01T00:00:00.000Z",
  };

  function fakeGit(responses: Record<string, string>): GitExec {
    return async (args) => responses[args.join(" ")] ?? "";
  }

  it("emits revert_detected after a reset appears in the reflog", async () => {
    const detector = createRevertDetector("/repo", {
      ...opts,
      execGit: fakeGit({
        "reflog -20": REFLOG_WITH_RESET,
        "diff --name-only HEAD@{1} HEAD": "src/middleware/rate-limiter.ts\nsrc/redis/client.ts\n",
      }),
    });
    const fact = await detector.check();
    expect(fact).toMatchObject({
      type: "revert_detected",
      repoId: "repo-1",
      files: ["src/middleware/rate-limiter.ts", "src/redis/client.ts"],
    });
    expect(detector.facts).toHaveLength(1);
  });

  it("does not emit when the reflog is clean", async () => {
    const detector = createRevertDetector("/repo", {
      ...opts,
      execGit: fakeGit({ "reflog -20": CLEAN_REFLOG }),
    });
    expect(await detector.check()).toBeNull();
    expect(detector.facts).toHaveLength(0);
  });

  it("does not emit when no files changed", async () => {
    const detector = createRevertDetector("/repo", {
      ...opts,
      execGit: fakeGit({
        "reflog -20": REFLOG_WITH_RESET,
        "diff --name-only HEAD@{1} HEAD": "",
      }),
    });
    expect(await detector.check()).toBeNull();
  });

  it("supports direct reset observation", () => {
    const detector = createRevertDetector("/repo", opts);
    const fact = detector.observeReset(["src/a.ts", "src/a.ts", ""]);
    expect(fact).toMatchObject({ files: ["src/a.ts"] });
  });
});
