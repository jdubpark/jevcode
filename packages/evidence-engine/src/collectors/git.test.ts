import type { EvidenceFact } from "@jevcode/contracts";
import { describe, expect, it, vi } from "vitest";

import { diffHash, notCapturedDiff } from "../diff.js";
import {
  createGitCollector,
  isSafeRelativePath,
  parsePorcelain,
  type GitExec,
} from "./git.js";

// The real diffHash wrapped in a spy, so a test can count the collector's hashes.
// Calls made inside diff.ts itself (notCapturedDiff) reach the unwrapped function.
vi.mock("../diff.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../diff.js")>();
  return { ...actual, diffHash: vi.fn(actual.diffHash) };
});

type GitHunkFact = Extract<EvidenceFact, { type: "git_hunk" }>;

function fakeGit(responses: Record<string, string>): GitExec {
  return async (args) => {
    const key = args.join(" ");
    return responses[key] ?? "";
  };
}

const STATUS_OUTPUT = [
  " M src/foo.ts",
  "?? src/new.ts",
  " D src/gone.ts",
  " M tsconfig.json",
  " M pnpm-lock.yaml",
  "R  old.ts -> src/renamed.ts",
  '?? "new file.ts"',
].join("\n");

const RESPONSES: Record<string, string> = {
  "status --porcelain": STATUS_OUTPUT,

  "diff HEAD -- src/foo.ts": `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,2 @@
-  const a=1;
+const a = 1;
-  const b=2;
+const b = 2;
`,
  "diff --numstat HEAD -- src/foo.ts": "1\t1\tsrc/foo.ts",

  "diff --no-index -- /dev/null src/new.ts": `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+const x = 1;
+const y = 2;
+const z = 3;
`,
  "diff --no-index --numstat -- /dev/null src/new.ts": "3\t0\tsrc/new.ts",

  "diff HEAD -- src/gone.ts": `diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
--- a/src/gone.ts
+++ /dev/null
@@ -1,5 +0,0 @@
-const a = 1;
-const b = 2;
-const c = 3;
-const d = 4;
-const e = 5;
`,
  "diff --numstat HEAD -- src/gone.ts": "0\t5\tsrc/gone.ts",

  "diff HEAD -- tsconfig.json": `diff --git a/tsconfig.json b/tsconfig.json
--- a/tsconfig.json
+++ b/tsconfig.json
@@ -1,2 +1,3 @@
 {
-  "target": "ES2022"
+  "target": "ES2022",
+  "strict": true
 }
`,
  "diff --numstat HEAD -- tsconfig.json": "1\t1\ttsconfig.json",

  "diff HEAD -- pnpm-lock.yaml": `diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -1,1 +1,1 @@
-lockfileVersion: '9.0'
+lockfileVersion: '9.1'
`,
  "diff --numstat HEAD -- pnpm-lock.yaml": "1\t1\tpnpm-lock.yaml",

  "diff HEAD -- src/renamed.ts": `diff --git a/src/renamed.ts b/src/renamed.ts
new file mode 100644
--- /dev/null
+++ b/src/renamed.ts
@@ -0,0 +1,2 @@
+const a = 1;
+const b = 2;
`,
  "diff --numstat HEAD -- src/renamed.ts": "2\t0\tsrc/renamed.ts",

  "diff --no-index -- /dev/null new file.ts": `diff --git a/new file.ts b/new file.ts
new file mode 100644
--- /dev/null
+++ b/new file.ts
@@ -0,0 +1,1 @@
+const w = 1;
`,
  "diff --no-index --numstat -- /dev/null new file.ts": "1\t0\tnew file.ts",
};

describe("parsePorcelain", () => {
  it("parses status entries", () => {
    const changes = parsePorcelain(STATUS_OUTPUT);
    expect(changes.get("src/foo.ts")).toEqual({
      indexStatus: " ",
      worktreeStatus: "M",
    });
    expect(changes.get("src/new.ts")).toEqual({
      indexStatus: "?",
      worktreeStatus: "?",
    });
    expect(changes.get("src/gone.ts")).toEqual({
      indexStatus: " ",
      worktreeStatus: "D",
    });
  });

  it("resolves renames to the new path", () => {
    const changes = parsePorcelain("R  old.ts -> src/renamed.ts\n");
    expect(changes.has("src/renamed.ts")).toBe(true);
    expect(changes.has("old.ts")).toBe(false);
  });

  it("unquotes quoted paths", () => {
    const changes = parsePorcelain('?? "new file.ts"\n');
    expect(changes.has("new file.ts")).toBe(true);
  });

  it("drops unsafe paths", () => {
    const changes = parsePorcelain("?? ../outside.ts\n?? /etc/passwd\n");
    expect(changes.size).toBe(0);
  });
});

describe("isSafeRelativePath", () => {
  it("rejects absolute and traversal paths", () => {
    expect(isSafeRelativePath("/etc/passwd")).toBe(false);
    expect(isSafeRelativePath("a/../b.ts")).toBe(false);
    expect(isSafeRelativePath("C:\\x.ts")).toBe(false);
    expect(isSafeRelativePath("src/a.ts")).toBe(true);
  });
});

describe("createGitCollector", () => {
  it("emits git_hunk facts with classifications", async () => {
    const collector = createGitCollector("/repo", "HEAD", {
      repoId: "repo-1",
      sessionId: "sess-1",
      execGit: fakeGit(RESPONSES),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const facts = (await collector.collect()) as GitHunkFact[];
    expect(facts).toHaveLength(7);

    const byFile = new Map(facts.map((fact) => [fact.file, fact]));
    expect(byFile.get("src/foo.ts")).toMatchObject({
      type: "git_hunk",
      added: 1,
      removed: 1,
      isFormattingOnly: true,
      isConfigOnly: false,
      isLockfile: false,
    });
    expect(byFile.get("src/new.ts")).toMatchObject({
      added: 3,
      removed: 0,
      isFormattingOnly: false,
    });
    expect(byFile.get("src/gone.ts")).toMatchObject({
      added: 0,
      removed: 5,
      isFormattingOnly: false,
    });
    expect(byFile.get("tsconfig.json")).toMatchObject({
      isConfigOnly: true,
      isFormattingOnly: false,
    });
    expect(byFile.get("pnpm-lock.yaml")).toMatchObject({
      isLockfile: true,
      isConfigOnly: false,
    });
    expect(byFile.get("src/renamed.ts")).toMatchObject({ added: 2, removed: 0 });
    expect(byFile.get("new file.ts")).toMatchObject({ added: 1, removed: 0 });
    // Without an injected prepareDiff no diff text is ever stored.
    for (const fact of facts) {
      expect(fact.diff).toMatchObject({ withheld: "not_captured", truncated: false, redactions: 0 });
      expect(fact.diff?.text).toBeUndefined();
      expect(fact.diff?.hash).toMatch(/^[0-9a-f]{16}$/);
    }

    expect(collector.facts).toHaveLength(7);
  });

  it("emits a file only when its diff changes", async () => {
    const responses: Record<string, string> = { ...RESPONSES };
    const collector = createGitCollector("/repo", "HEAD", {
      repoId: "repo-1",
      sessionId: "sess-1",
      execGit: fakeGit(responses),
    });
    expect(await collector.collect()).toHaveLength(7);

    // An unchanged re-poll emits nothing.
    expect(await collector.collect()).toEqual([]);

    // An edit to one file emits exactly that file.
    responses["diff HEAD -- src/foo.ts"] = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,3 @@
-  const a=1;
+const a = 1;
-  const b=2;
+const b = 2;
+const c = 3;
`;
    responses["diff --numstat HEAD -- src/foo.ts"] = "2\t1\tsrc/foo.ts";
    const afterEdit = (await collector.collect()) as GitHunkFact[];
    expect(afterEdit.map((fact) => fact.file)).toEqual(["src/foo.ts"]);
    expect(afterEdit[0]).toMatchObject({ added: 2, removed: 1 });
    expect(collector.facts).toHaveLength(8);
  });

  it("emits again for a file that left git status and came back unchanged", async () => {
    const responses: Record<string, string> = {
      ...RESPONSES,
      "status --porcelain": "?? src/new.ts\n",
    };
    const collector = createGitCollector("/repo", "HEAD", {
      repoId: "repo-1",
      sessionId: "sess-1",
      execGit: fakeGit(responses),
    });
    expect(await collector.collect()).toHaveLength(1);

    responses["status --porcelain"] = "";
    expect(await collector.collect()).toEqual([]);

    responses["status --porcelain"] = "?? src/new.ts\n";
    const returned = (await collector.collect()) as GitHunkFact[];
    expect(returned.map((fact) => fact.file)).toEqual(["src/new.ts"]);
  });

  it("passes each file and its raw diff to an injected prepareDiff", async () => {
    const seen: [string, string][] = [];
    const collector = createGitCollector("/repo", "HEAD", {
      repoId: "repo-1",
      sessionId: "sess-1",
      execGit: fakeGit({ ...RESPONSES, "status --porcelain": " M src/foo.ts\n" }),
      prepareDiff: (file, rawDiff) => {
        seen.push([file, rawDiff]);
        return {
          hash: "0123456789abcdef",
          bytes: rawDiff.length,
          text: "prepared",
          truncated: false,
          redactions: 0,
        };
      },
    });
    const facts = (await collector.collect()) as GitHunkFact[];
    expect(seen).toEqual([["src/foo.ts", RESPONSES["diff HEAD -- src/foo.ts"]]]);
    expect(facts[0]?.diff).toMatchObject({ text: "prepared", hash: "0123456789abcdef" });
  });

  it("hashes an unchanged diff once per poll and never prepares it again", async () => {
    const hash = vi.mocked(diffHash);
    const prepareDiff = vi.fn(notCapturedDiff);
    const collector = createGitCollector("/repo", "HEAD", {
      repoId: "repo-1",
      sessionId: "sess-1",
      execGit: fakeGit({ ...RESPONSES, "status --porcelain": " M src/foo.ts\n" }),
      prepareDiff,
    });
    hash.mockClear();
    expect(await collector.collect()).toHaveLength(1);
    expect(hash).toHaveBeenCalledTimes(1);
    expect(prepareDiff).toHaveBeenCalledTimes(1);

    // Spec §12 M1b exit: an unchanged diff costs one hash and no prepareDiff call.
    hash.mockClear();
    prepareDiff.mockClear();
    expect(await collector.collect()).toEqual([]);
    expect(hash.mock.calls).toEqual([[RESPONSES["diff HEAD -- src/foo.ts"]]]);
    expect(prepareDiff).not.toHaveBeenCalled();
  });

  it("emits package.json hunks as config-only", async () => {
    const responses: Record<string, string> = {
      ...RESPONSES,
      "status --porcelain": " M package.json\n",
      "diff HEAD -- package.json": `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -1,2 +1,3 @@
 {
-  "name": "x"
+  "name": "x",
+  "version": "1.0.0"
 }
`,
      "diff --numstat HEAD -- package.json": "1\t1\tpackage.json",
    };
    const collector = createGitCollector("/repo", undefined, {
      repoId: "repo-1",
      sessionId: "sess-1",
      execGit: fakeGit(responses),
    });
    const facts = (await collector.collect()) as GitHunkFact[];
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ file: "package.json", isConfigOnly: true });
  });
});
