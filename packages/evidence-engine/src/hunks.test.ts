import { describe, expect, it } from "vitest";

import {
  isConfigPath,
  isFormattingOnlyDiff,
  isLockfilePath,
  parseNumstat,
} from "./hunks.js";

const FORMATTING_ONLY_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
-  const x=1;
+const x = 1;
-  const y = 2;
+const y=2;
-const z = 3;
+const   z   =   3;
`;

const REAL_CHANGE_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
-function add(a: number) { return a; }
+function add(a: number, b: number) { return a + b; }
`;

const MIXED_HUNKS_DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
-function real(a) { return a; }
+function real(a, b) { return a + b; }
@@ -10,2 +10,2 @@
-  const a=1;
+const a = 1;
-  const b=2;
+const b = 2;
`;

const NEW_FILE_DIFF = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+const a = 1;
+const b = 2;
`;

const BINARY_DIFF = `diff --git a/assets/logo.png b/assets/logo.png
index 1111111..2222222 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
`;

describe("parseNumstat", () => {
  it("parses added/removed per file", () => {
    const counts = parseNumstat("5\t3\tsrc/foo.ts\n0\t10\tsrc/deleted.ts\n");
    expect(counts.get("src/foo.ts")).toEqual({ added: 5, removed: 3 });
    expect(counts.get("src/deleted.ts")).toEqual({ added: 0, removed: 10 });
  });

  it("treats binary rows as zero counts", () => {
    const counts = parseNumstat("-\t-\tassets/logo.png\n");
    expect(counts.get("assets/logo.png")).toEqual({ added: 0, removed: 0 });
  });

  it("handles paths with tabs and spaces", () => {
    const counts = parseNumstat("1\t1\tdir/with space/file.ts\n");
    expect(counts.get("dir/with space/file.ts")).toEqual({ added: 1, removed: 1 });
  });
});

describe("isFormattingOnlyDiff", () => {
  it("detects whitespace-only changes", () => {
    expect(isFormattingOnlyDiff(FORMATTING_ONLY_DIFF)).toBe(true);
  });

  it("rejects real content changes", () => {
    expect(isFormattingOnlyDiff(REAL_CHANGE_DIFF)).toBe(false);
  });

  it("rejects when any hunk has a real change", () => {
    expect(isFormattingOnlyDiff(MIXED_HUNKS_DIFF)).toBe(false);
  });

  it("rejects new files", () => {
    expect(isFormattingOnlyDiff(NEW_FILE_DIFF)).toBe(false);
  });

  it("rejects binary diffs", () => {
    expect(isFormattingOnlyDiff(BINARY_DIFF)).toBe(false);
  });

  it("rejects empty input", () => {
    expect(isFormattingOnlyDiff("")).toBe(false);
  });

  it("detects indentation-only changes", () => {
    const diff = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
-const x = 1;
-  const y = 2;
+  const x = 1;
+const y = 2;
`;
    expect(isFormattingOnlyDiff(diff)).toBe(true);
  });

  it("rejects line additions without removals", () => {
    const diff = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
`;
    expect(isFormattingOnlyDiff(diff)).toBe(false);
  });
});

describe("isConfigPath", () => {
  it.each([
    "tsconfig.json",
    "tsconfig.base.json",
    "tsconfig.build.json",
    ".prettierrc",
    ".prettierrc.json",
    ".prettierrc.yaml",
    ".editorconfig",
    ".eslintrc",
    ".eslintrc.cjs",
    ".eslintrc.json",
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.ts",
    "vite.config.ts",
    "jest.config.js",
    "next.config.mjs",
    "package.json",
  ])("flags %s as config", (path) => {
    expect(isConfigPath(path)).toBe(true);
  });

  it.each([
    "src/config.ts",
    "src/app.config.generated.ts",
    "tsconfig.md",
    "prettierrc",
    "src/vite.config.txt",
    "config.py",
  ])("does not flag %s", (path) => {
    expect(isConfigPath(path)).toBe(false);
  });
});

describe("isLockfilePath", () => {
  it.each([
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "Cargo.lock",
    "poetry.lock",
    "Gemfile.lock",
  ])("flags %s as lockfile", (path) => {
    expect(isLockfilePath(path)).toBe(true);
  });

  it.each(["src/index.ts", "lock.json", "unlock.ts"])("does not flag %s", (path) => {
    expect(isLockfilePath(path)).toBe(false);
  });
});
