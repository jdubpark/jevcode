import { describe, expect, it } from "vitest";

import {
  EvidenceFactSchema,
  GitHunkDiffSchema,
  SymbolInfoSchema,
  TestFailureSchema,
  type EvidenceFact,
} from "./evidence.js";

const repoId = "repo_1";
const sessionId = "sess_abc";
const ts = "2026-01-15T10:30:00.000Z";

const symbolInfo = {
  name: "createSession",
  kind: "method" as const,
  signature: "createSession(userId: string): Promise<Session>",
  startLine: 12,
  endLine: 20,
};

const testFailure = {
  file: "test/oauth.test.ts",
  testName: "links google account",
  message: "expected 200, got 500",
};

const facts: EvidenceFact[] = [
  {
    type: "git_hunk",
    repoId,
    sessionId,
    file: "src/format.ts",
    added: 40,
    removed: 40,
    isFormattingOnly: true,
    isConfigOnly: false,
    isLockfile: false,
    ts,
  },
  {
    type: "file_changed",
    repoId,
    sessionId,
    path: "src/rate-limit.ts",
    kind: "added",
    ts,
  },
  {
    type: "symbol_delta",
    repoId,
    sessionId,
    path: "src/session.ts",
    added: [symbolInfo],
    removed: [],
    modified: [],
    ts,
  },
  {
    type: "dependency_change",
    repoId,
    sessionId,
    manifest: "package.json",
    added: [{ name: "ioredis", version: "5.4.1" }],
    removed: [{ name: "node-redis", version: "4.6.13" }],
    ts,
  },
  {
    type: "test_result",
    repoId,
    sessionId,
    runner: "vitest",
    command: "vitest run",
    passed: 12,
    failed: 1,
    skipped: 0,
    failures: [testFailure],
    ts,
  },
  {
    type: "command_executed",
    repoId,
    sessionId,
    command: "git reset --hard HEAD~1",
    exitCode: 0,
    isDestructive: true,
    ts,
  },
  {
    type: "revert_detected",
    repoId,
    sessionId,
    files: ["src/auth.ts"],
    ts,
  },
];

describe("EvidenceFactSchema", () => {
  it("parses every SPEC section 4.2 variant", () => {
    for (const fact of facts) {
      const result = EvidenceFactSchema.safeParse(fact);
      expect(result.success, JSON.stringify(fact)).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe(fact.type);
      }
    }
  });

  it("parses SymbolInfo with all kinds", () => {
    const kinds = [
      "function",
      "class",
      "method",
      "interface",
      "type",
      "variable",
      "import",
      "export",
    ] as const;
    for (const kind of kinds) {
      const result = SymbolInfoSchema.safeParse({
        name: "x",
        kind,
        signature: "x",
        startLine: 1,
        endLine: 2,
      });
      expect(result.success).toBe(true);
    }
  });

  it("parses TestFailure", () => {
    const result = TestFailureSchema.safeParse(testFailure);
    expect(result.success).toBe(true);
  });

  it("rejects an invalid symbol kind", () => {
    const result = SymbolInfoSchema.safeParse({ ...symbolInfo, kind: "enum" });
    expect(result.success).toBe(false);
  });

  it("rejects negative line counts", () => {
    const result = EvidenceFactSchema.safeParse({
      type: "git_hunk",
      repoId,
      sessionId,
      file: "a.ts",
      added: -1,
      removed: 0,
      isFormattingOnly: false,
      isConfigOnly: false,
      isLockfile: false,
      ts,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown fact type", () => {
    const result = EvidenceFactSchema.safeParse({ type: "build_result", repoId, sessionId, ts });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid file_changed kind", () => {
    const result = EvidenceFactSchema.safeParse({
      type: "file_changed",
      repoId,
      sessionId,
      path: "a.ts",
      kind: "moved",
      ts,
    });
    expect(result.success).toBe(false);
  });
});

describe("trace fields on evidence facts", () => {
  const gitHunk = {
    type: "git_hunk",
    repoId,
    sessionId,
    file: "src/a.ts",
    added: 1,
    removed: 1,
    isFormattingOnly: false,
    isConfigOnly: false,
    isLockfile: false,
    ts,
  };
  const diff = {
    hash: "0123456789abcdef",
    bytes: 58,
    text: "@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n",
    truncated: false,
    redactions: 0,
  };

  it("keeps git_hunk.diff through a parse", () => {
    expect(EvidenceFactSchema.parse({ ...gitHunk, diff })).toEqual({ ...gitHunk, diff });
  });

  it("accepts a withheld diff without text", () => {
    const withheld = { hash: "fedcba9876543210", bytes: 120, truncated: false, redactions: 0, withheld: "secret_path" };
    expect(GitHunkDiffSchema.parse(withheld)).toEqual(withheld);
    expect(GitHunkDiffSchema.parse({ ...withheld, withheld: "not_captured" }).withheld).toBe("not_captured");
  });

  it("rejects a withheld diff that carries text", () => {
    expect(GitHunkDiffSchema.safeParse({ ...diff, withheld: "secret_path" }).success).toBe(false);
  });

  it("rejects a hash that is not 16 lowercase hex characters", () => {
    expect(GitHunkDiffSchema.safeParse({ ...diff, hash: "0123456789abcde" }).success).toBe(false);
    expect(GitHunkDiffSchema.safeParse({ ...diff, hash: "0123456789ABCDEF" }).success).toBe(false);
  });

  it("rejects an unknown withheld reason", () => {
    const result = GitHunkDiffSchema.safeParse({ hash: diff.hash, bytes: 1, truncated: false, redactions: 0, withheld: "too_big" });
    expect(result.success).toBe(false);
  });

  it("keeps sourceCallId on test_result and command_executed", () => {
    const sourceCallId = "turn_1:item_4";
    for (const fact of facts.filter((f) => f.type === "test_result" || f.type === "command_executed")) {
      expect(EvidenceFactSchema.parse({ ...fact, sourceCallId })).toEqual({ ...fact, sourceCallId });
    }
  });
});
