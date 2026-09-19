import { describe, expect, it } from "vitest";

import {
  EvidenceFactSchema,
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
