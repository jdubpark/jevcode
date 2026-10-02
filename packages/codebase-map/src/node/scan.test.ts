import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { OVERVIEW_SNAPSHOT_MAX_BYTES, OverviewSnapshotSchema } from "@jevcode/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { componentize } from "../core/componentize.js";
import { utf8ByteLength } from "../core/sha1.js";
import { assembleSnapshot } from "../core/snapshot.js";
import type { ScannedFile } from "../core/types.js";
import { ScanError, scanPaths, scanRepo } from "./scan.js";
import {
  PNPM_WORKSPACE_KEPT,
  PNPM_WORKSPACE_REPO,
  PYTHON_REPO,
  generatedRepoFiles,
  makeRepo,
  type FixtureRepo,
} from "./test-support/fixture-repos.js";

const repos: FixtureRepo[] = [];
function repo(...args: Parameters<typeof makeRepo>): FixtureRepo {
  const made = makeRepo(...args);
  repos.push(made);
  return made;
}
afterEach(() => {
  while (repos.length > 0) repos.pop()?.cleanup();
});

const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");

function snapshotOf(root: string, scan: Awaited<ReturnType<typeof scanRepo>>) {
  return assembleSnapshot({
    sessionId: "sess_scan",
    repoRoot: root,
    scanId: "scan_test",
    partial: scan.partial,
    drafts: componentize(scan.files, scan.manifest),
    totalFiles: scan.totalFiles,
    edges: [],
    externals: [],
    text: new Map(),
    narrative: null,
    generatedAt: "2026-10-02T00:00:00.000Z",
  });
}

describe("scanRepo (spec §5.1, §10)", () => {
  it("lists tracked and untracked files, skips ignored, generated, binary, LFS, oversized and secret files", async () => {
    const fixture = repo(PNPM_WORKSPACE_REPO, { symlinks: { "linked/outside.ts": "/etc/hosts" } });
    const scan = await scanRepo(fixture.root);
    expect(scan.files.map((f) => f.path)).toEqual(PNPM_WORKSPACE_KEPT);
    expect(scan.partial).toBe(false);
    expect(scan.totalFiles).toBe(PNPM_WORKSPACE_KEPT.length);
    const user = scan.files.find((f) => f.path === "packages/core/src/user.ts");
    expect(user).toEqual({
      path: "packages/core/src/user.ts",
      hash: sha1(PNPM_WORKSPACE_REPO["packages/core/src/user.ts"] as string),
      size: (PNPM_WORKSPACE_REPO["packages/core/src/user.ts"] as string).length,
      language: "TypeScript",
    });
  });

  it("reads the workspace manifest and root tsconfig paths", async () => {
    const scan = await scanRepo(repo(PNPM_WORKSPACE_REPO).root);
    expect(scan.manifest).toEqual({
      packageDirs: ["packages/core", "packages/db"],
      appDirs: ["apps/web"],
      packageNames: { ".": "fixture-root", "packages/core": "@fx/core", "packages/db": "@fx/db", "apps/web": "@fx/web" },
      descriptions: { "packages/core": "Domain model." },
      entryPoints: {
        "packages/core": ["packages/core/src/index.ts"],
        "packages/db": ["packages/db/src/index.ts"],
        "apps/web": ["apps/web/src/main.tsx"],
      },
    });
    expect(scan.tsconfig).toEqual({ paths: { "@app/*": ["apps/web/src/*"] }, baseUrl: "." });
    expect(componentize(scan.files, scan.manifest).map((d) => [d.rootPath, d.name])).toEqual([
      [".", "config"],
      ["apps/web", "@fx/web"],
      ["docs", "docs"],
      ["packages/core", "@fx/core"],
      ["packages/db", "@fx/db"],
      ["scripts", "scripts"],
    ]);
  });

  it("hands every kept file's text to visit and reports progress up to the total", async () => {
    const seen: string[] = [];
    const progress: [number, number][] = [];
    const scan = await scanRepo(repo(PNPM_WORKSPACE_REPO).root, {
      visit: (file, source) => {
        seen.push(file.path);
        expect(sha1(source)).toBe(file.hash);
      },
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(seen.sort()).toEqual(scan.files.map((f) => f.path).sort());
    expect(progress[0]?.[0]).toBe(0);
    const last = progress[progress.length - 1];
    expect(last?.[0]).toBe(last?.[1]);
  });

  it("bounds in-flight visit calls to the read pool, far below the extractor queue limit of 256", async () => {
    let inFlight = 0;
    let peak = 0;
    let visited = 0;
    await scanRepo(repo(generatedRepoFiles(10, 60)).root, {
      visit: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        visited += 1;
      },
    });
    expect(visited).toBe(600);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(32);
  });

  it("rejects a non-git directory with a typed error that hides the command line", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jevcode-nogit-"));
    try {
      const error = await scanRepo(dir).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ScanError);
      expect((error as ScanError).code).toBe("not-a-repo");
      expect((error as ScanError).message).not.toMatch(/ls-files|fatal/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an empty repo root with a git-failed ScanError", async () => {
    await expect(scanRepo("")).rejects.toMatchObject({ name: "ScanError", code: "git-failed" });
  });

  it("stops reading after visit throws", async () => {
    let calls = 0;
    await expect(
      scanRepo(repo(generatedRepoFiles(10, 60)).root, {
        visit: async () => {
          calls += 1;
          await new Promise((resolve) => setImmediate(resolve));
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
    expect(calls).toBeLessThanOrEqual(32);
  });

  it("stops with an AbortError when the signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(scanRepo(repo(PNPM_WORKSPACE_REPO).root, { signal: controller.signal })).rejects.toThrow(/abort/i);
  });

  it("skips a path over 1,024 characters before reading and does not count it", async () => {
    const fixture = repo({ "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 1;\n", "src/c.ts": "export const c = 1;\n" });
    // macOS cannot create a file this deep (PATH_MAX), so the path enters the git index only, as git
    // lists it on any platform; where it can exist on disk it would be read and mapped.
    const long = `src/${"deep/".repeat(205)}x.ts`;
    expect(long.length).toBeGreaterThan(1_024);
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: fixture.root, input: "export const x = 1;\n" })
      .toString()
      .trim();
    execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},${long}`], { cwd: fixture.root });
    const scan = await scanRepo(fixture.root, { maxFiles: 2 });
    expect(scan.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect([scan.partial, scan.totalFiles]).toEqual([true, 3]);
  });

  it("maps a Python repo to components with imports not analyzed (Review Focus 1)", async () => {
    const fixture = repo(PYTHON_REPO);
    const scan = await scanRepo(fixture.root);
    const snapshot = snapshotOf(fixture.root, scan);
    expect(OverviewSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.components.map((c) => [c.rootPath, c.language, c.roleGuess, c.importsAnalyzed])).toEqual([
      [".", "Markdown", "config", false],
      ["app", "Python", "domain", false],
      ["scripts", "Python", "tooling", false],
      ["tests", "Python", "tests", false],
    ]);
    expect(snapshot.edges).toEqual([]);
    expect(snapshot.partial).toBe(false);
    expect(snapshot.counts).toMatchObject({ files: 7, components: 4, edges: 0 });
  });

  it(
    "flags a 25,200-file repo as partial and maps exactly 20,000 files into 200 components (Review Focus 1)",
    async () => {
      const fixture = repo(generatedRepoFiles(300, 84));
      const scan = await scanRepo(fixture.root);
      expect(scan.partial).toBe(true);
      expect(scan.files).toHaveLength(20_000);
      expect(scan.totalFiles).toBe(25_200);
      expect(scan.files[scan.files.length - 1]?.path).toBe("src/mod-238/file-007.ts");
      const snapshot = snapshotOf(fixture.root, scan);
      expect(OverviewSnapshotSchema.safeParse(snapshot).success).toBe(true);
      expect(snapshot.partial).toBe(true);
      expect(snapshot.counts).toMatchObject({ files: 20_000, components: 239, totalFiles: 25_200 });
      expect(snapshot.components).toHaveLength(200);
      expect(snapshot.components.find((c) => c.name === "other")?.fileCount).toBe(40 * 84 - 76);
      expect(utf8ByteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(OVERVIEW_SNAPSHOT_MAX_BYTES);
    },
    120_000,
  );
});

describe("scanPaths (spec §5.1 incremental updates)", () => {
  it("re-reads changed files and reports deleted, ignored, skipped and escaping paths as gone", async () => {
    const fixture = repo(PNPM_WORKSPACE_REPO);
    writeFileSync(path.join(fixture.root, "packages/core/src/user.ts"), "export const changed = 1;\n");
    writeFileSync(path.join(fixture.root, "packages/core/src/new.ts"), "export const added = 1;\n");
    rmSync(path.join(fixture.root, "docs/guide.md"));
    const visited: string[] = [];
    const result = await scanPaths(
      fixture.root,
      [
        "packages/core/src/user.ts",
        "./packages/core/src/new.ts",
        "docs/guide.md",
        "build.log",
        ".env",
        "../outside.ts",
        "/etc/hosts",
      ],
      { visit: (file) => void visited.push(file.path) },
    );
    expect(result.files.map((f: ScannedFile) => [f.path, f.hash])).toEqual([
      ["packages/core/src/new.ts", sha1("export const added = 1;\n")],
      ["packages/core/src/user.ts", sha1("export const changed = 1;\n")],
    ]);
    expect(result.gone).toEqual([".env", "build.log", "docs/guide.md"]);
    expect(visited.sort()).toEqual(["packages/core/src/new.ts", "packages/core/src/user.ts"]);
  });
});
