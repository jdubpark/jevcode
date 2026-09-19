import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb } from "@jevcode/storage";
import type { JevcodeDb } from "@jevcode/storage";
import { afterEach, describe, expect, it } from "vitest";

import { IpcError } from "../shared/errors.js";
import { openRepoByPath } from "./repo-service.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "jevcode-desktop-repo-")));
  tempDirs.push(dir);
  return dir;
}

function openTempDb(): JevcodeDb {
  return openDb({ dbPath: path.join(tempDir(), "jevcode.db") });
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

describe("openRepoByPath", () => {
  it("persists the repository and creates a session with the base commit", async () => {
    const dir = tempDir();
    initRepo(dir);
    const db = openTempDb();
    const { repo, session, info } = await openRepoByPath(db, dir);

    expect(repo.path).toBe(dir);
    expect(repo.gitRoot).toBe(dir);
    expect(repo.branch).toBe("main");
    expect(repo.baseCommit).toBe(info.baseCommit);
    expect(session.repoId).toBe(repo.id);
    expect(session.baseCommit).toBe(info.baseCommit);
    expect(session.state).toBe("starting");

    expect(db.getRepository(repo.id)?.baseCommit).toBe(info.baseCommit);
    expect(db.getSession(session.id)?.repoId).toBe(repo.id);
    db.close();
  });

  it("reuses the repository row on reopen but creates a new session", async () => {
    const dir = tempDir();
    initRepo(dir);
    const db = openTempDb();
    const first = await openRepoByPath(db, dir);
    const second = await openRepoByPath(db, dir);

    expect(second.repo.id).toBe(first.repo.id);
    expect(second.session.id).not.toBe(first.session.id);
    expect(db.listSessions(first.repo.id)).toHaveLength(2);
    db.close();
  });

  it("rejects non-repositories with a typed error", async () => {
    const dir = tempDir();
    const db = openTempDb();
    await expect(openRepoByPath(db, dir)).rejects.toMatchObject({
      name: "IpcError",
      code: "NOT_A_GIT_REPO",
    });
    expect(db.listRecentRepositories()).toHaveLength(0);
    db.close();
  });

  it("errors are IpcError instances", async () => {
    const db = openTempDb();
    await expect(openRepoByPath(db, "/definitely/not/here")).rejects.toBeInstanceOf(
      IpcError,
    );
    db.close();
  });
});
