import { execFile } from "node:child_process";

import type { EvidenceFact } from "@jevcode/contracts";

import {
  isConfigPath,
  isFormattingOnlyDiff,
  isLockfilePath,
  parseNumstat,
} from "../hunks.js";
import {
  resolveCollectorConfig,
  sinkFacts,
  type CollectorContext,
  type CollectorOptions,
  type FactSink,
} from "../sink.js";

export interface GitExecOptions {
  cwd?: string;
  allowFailure?: boolean;
}

export type GitExec = (args: string[], opts?: GitExecOptions) => Promise<string>;

export function defaultGitExec(): GitExec {
  return (args, opts) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        args,
        { cwd: opts?.cwd, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout) => {
          if (error && !opts?.allowFailure) {
            reject(error);
            return;
          }
          resolve(stdout);
        },
      );
    });
}

export interface PorcelainChange {
  indexStatus: string;
  worktreeStatus: string;
}

export function parsePorcelain(output: string): Map<string, PorcelainChange> {
  const changes = new Map<string, PorcelainChange>();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.length < 4) continue;
    const indexStatus = line.charAt(0);
    const worktreeStatus = line.charAt(1);
    let entry = line.slice(3);
    if (entry.startsWith('"')) {
      entry = unquoteGitPath(entry);
    }
    const renameIndex = entry.indexOf(" -> ");
    if (renameIndex !== -1) {
      entry = entry.slice(renameIndex + 4);
    }
    if (!entry || !isSafeRelativePath(entry)) continue;
    changes.set(entry, { indexStatus, worktreeStatus });
  }
  return changes;
}

function unquoteGitPath(quoted: string): string {
  let out = "";
  let i = quoted.startsWith('"') ? 1 : 0;
  while (i < quoted.length) {
    const ch = quoted.charAt(i);
    if (ch === '"') break;
    if (ch !== "\\") {
      out += ch;
      i++;
      continue;
    }
    i++;
    const esc = quoted.charAt(i);
    if (esc === "t") out += "\t";
    else if (esc === "n") out += "\n";
    else if (esc === "r") out += "\r";
    else if (esc === '"') out += '"';
    else if (esc === "\\") out += "\\";
    else {
      if (/[0-7]/.test(esc)) {
        let octal = esc;
        for (let k = 0; k < 2 && /[0-7]/.test(quoted.charAt(i + 1)); k++) {
          i++;
          octal += quoted.charAt(i);
        }
        out += String.fromCharCode(Number.parseInt(octal, 8));
      } else {
        out += esc;
      }
    }
    i++;
  }
  return out;
}

export function isSafeRelativePath(filePath: string): boolean {
  if (filePath.startsWith("/") || /^[a-zA-Z]:/.test(filePath)) return false;
  const segments = filePath.replace(/\\/g, "/").split("/");
  return !segments.includes("..") && filePath.length > 0;
}

export interface GitCollectorOptions extends CollectorOptions {
  execGit?: GitExec;
  readFile?: (absPath: string) => Promise<string>;
}

export interface GitCollector {
  readonly repoPath: string;
  readonly baseCommit: string | undefined;
  readonly sink: FactSink;
  readonly facts: readonly EvidenceFact[];
  collect(): Promise<EvidenceFact[]>;
}

export function createGitCollector(
  repoPath: string,
  baseCommit?: string,
  opts: GitCollectorOptions = {},
): GitCollector {
  const cfg = resolveCollectorConfig(repoPath, opts);
  const ctx: CollectorContext = cfg.ctx;
  const execGit = opts.execGit ?? defaultGitExec();
  const readFile =
    opts.readFile ??
    ((absPath: string) =>
      import("node:fs/promises").then((fs) => fs.readFile(absPath, "utf8")));

  const git = (args: string[], allowFailure = false): Promise<string> =>
    execGit(args, { cwd: repoPath, allowFailure });

  async function diffFor(
    file: string,
    status: PorcelainChange,
  ): Promise<{ added: number; removed: number; diffText: string } | null> {
    const untracked = status.indexStatus === "?" && status.worktreeStatus === "?";
    if (untracked) {
      const diffText = await git(
        ["diff", "--no-index", "--", "/dev/null", file],
        true,
      );
      const numstat = parseNumstat(
        await git(["diff", "--no-index", "--numstat", "--", "/dev/null", file], true),
      );
      const counts = numstat.get(file);
      const added = counts?.added ?? 0;
      if (added === 0) {
        const { resolve } = await import("node:path");
        const content = await readFile(resolve(repoPath, file));
        return {
          added: content.split(/\r?\n/).filter((line) => line.length > 0).length,
          removed: 0,
          diffText,
        };
      }
      return { added, removed: counts?.removed ?? 0, diffText };
    }
    const rev = baseCommit && baseCommit.length > 0 ? baseCommit : "HEAD";
    const diffText = await git(["diff", rev, "--", file], true);
    const numstat = parseNumstat(await git(["diff", "--numstat", rev, "--", file], true));
    const counts = numstat.get(file);
    if (!counts && !diffText.trim()) return null;
    return {
      added: counts?.added ?? 0,
      removed: counts?.removed ?? 0,
      diffText,
    };
  }

  return {
    repoPath,
    baseCommit,
    sink: cfg.sink,
    get facts(): readonly EvidenceFact[] {
      return sinkFacts(cfg.sink);
    },
    async collect(): Promise<EvidenceFact[]> {
      const statusOutput = await git(["status", "--porcelain"]);
      const changes = parsePorcelain(statusOutput);
      const emitted: EvidenceFact[] = [];
      for (const [file, status] of changes) {
        if (file.endsWith("/")) continue;
        const diff = await diffFor(file, status);
        if (!diff) continue;
        const fact: EvidenceFact = {
          type: "git_hunk",
          repoId: ctx.repoId,
          sessionId: ctx.sessionId,
          file,
          added: diff.added,
          removed: diff.removed,
          isFormattingOnly: isFormattingOnlyDiff(diff.diffText),
          isConfigOnly: isConfigPath(file),
          isLockfile: isLockfilePath(file),
          ts: cfg.now(),
        };
        cfg.sink.push(fact);
        emitted.push(fact);
      }
      return emitted;
    },
  };
}
