import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { IpcError } from "../shared/errors.js";
import { probeGitRepo } from "./git.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "jevcode-desktop-git-")));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function initRepo(dir: string): void {
  execFileSync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: dir });
  writeFileSync(path.join(dir, "README.md"), "# seed\n");
  execFileSync(
    "git",
    ["-c", "user.email=test@jevcode.local", "-c", "user.name=test", "add", "-A"],
    { cwd: dir },
  );
  execFileSync(
    "git",
    ["-c", "user.email=test@jevcode.local", "-c", "user.name=test", "commit", "-m", "seed"],
    { cwd: dir },
  );
}

describe("probeGitRepo", () => {
  it("resolves git root, branch, and base commit for a real repository", async () => {
    const dir = tempDir();
    initRepo(dir);
    const info = await probeGitRepo(dir);
    expect(info.gitRoot).toBe(dir);
    expect(info.branch).toBe("main");
    expect(info.baseCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("resolves the repo when probed from a subdirectory", async () => {
    const dir = tempDir();
    initRepo(dir);
    const sub = path.join(dir, "src", "nested");
    execFileSync("mkdir", ["-p", sub]);
    const info = await probeGitRepo(sub);
    expect(info.gitRoot).toBe(dir);
  });

  it("rejects non-repositories with a typed error", async () => {
    const dir = tempDir();
    await expect(probeGitRepo(dir)).rejects.toMatchObject({
      name: "IpcError",
      code: "NOT_A_GIT_REPO",
    });
  });

  it("rejects missing directories with a typed error", async () => {
    const missing = path.join(os.tmpdir(), "jevcode-definitely-missing");
    await expect(probeGitRepo(missing)).rejects.toBeInstanceOf(IpcError);
  });
});
