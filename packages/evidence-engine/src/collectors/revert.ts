import type { EvidenceFact } from "@jevcode/contracts";

import {
  resolveCollectorConfig,
  sinkFacts,
  type CollectorContext,
  type CollectorOptions,
  type FactSink,
} from "../sink.js";
import { defaultGitExec, type GitExec } from "./git.js";

export function detectRevertInReflog(reflogText: string): string | null {
  for (const line of reflogText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/reset: moving to\s/.test(line)) return line;
    if (/checkout: moving from\s+.+?\s+to\s+[0-9a-f]{7,40}\s*$/.test(line)) {
      return line;
    }
    if (/\brebase\b.*\b(finish|abort)\b/.test(line)) return line;
  }
  return null;
}

export interface RevertDetectorOptions extends CollectorOptions {
  execGit?: GitExec;
  reflogLines?: number;
}

export interface RevertDetector {
  readonly sink: FactSink;
  readonly facts: readonly EvidenceFact[];
  check(): Promise<EvidenceFact | null>;
  observeReset(files: readonly string[]): EvidenceFact | null;
}

export function createRevertDetector(
  repoPath: string,
  opts: RevertDetectorOptions = {},
): RevertDetector {
  const cfg = resolveCollectorConfig(repoPath, opts);
  const ctx: CollectorContext = cfg.ctx;
  const execGit = opts.execGit ?? defaultGitExec();
  const reflogLines = opts.reflogLines ?? 20;

  const emit = (files: readonly string[]): EvidenceFact | null => {
    const unique = [...new Set(files)].filter((file) => file.length > 0);
    if (unique.length === 0) return null;
    const fact: EvidenceFact = {
      type: "revert_detected",
      repoId: ctx.repoId,
      sessionId: ctx.sessionId,
      files: unique,
      ts: cfg.now(),
    };
    cfg.sink.push(fact);
    return fact;
  };

  return {
    sink: cfg.sink,
    get facts(): readonly EvidenceFact[] {
      return sinkFacts(cfg.sink);
    },
    async check(): Promise<EvidenceFact | null> {
      const reflog = await execGit(["reflog", `-${reflogLines}`], {
        cwd: repoPath,
        allowFailure: true,
      });
      if (!detectRevertInReflog(reflog)) return null;
      const filesOutput = await execGit(
        ["diff", "--name-only", "HEAD@{1}", "HEAD"],
        { cwd: repoPath, allowFailure: true },
      );
      const files = filesOutput
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      return emit(files);
    },
    observeReset(files: readonly string[]): EvidenceFact | null {
      return emit(files);
    },
  };
}
