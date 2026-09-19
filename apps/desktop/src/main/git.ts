import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { IpcError } from "../shared/errors.js";

const execFileAsync = promisify(execFile);

export interface GitRepoInfo {
  gitRoot: string;
  branch: string;
  baseCommit: string;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      timeout: 10_000,
    });
    return stdout.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new IpcError("NOT_A_GIT_REPO", `git failed in ${cwd}: ${message}`);
  }
}

export async function probeGitRepo(candidatePath: string): Promise<GitRepoInfo> {
  const inside = await runGit(candidatePath, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") {
    throw new IpcError(
      "NOT_A_GIT_REPO",
      `${candidatePath} is not inside a git work tree`,
    );
  }
  const gitRoot = await runGit(candidatePath, ["rev-parse", "--show-toplevel"]);
  const branch = await runGit(candidatePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const baseCommit = await runGit(candidatePath, ["rev-parse", "HEAD"]);
  return { gitRoot, branch, baseCommit };
}
