import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { EvidenceFact } from "@jevcode/contracts";
import {
  createCommandCollector,
  createFileWatcher,
  createGitCollector,
  createRevertDetector,
  createTestCollector,
  type FactSink,
} from "@jevcode/evidence-engine";

const execFileAsync = promisify(execFile);

export interface EvidenceSessionOptions {
  repoId: string;
  sessionId: string;
  repoPath: string;
  baseCommit?: string;
  sink: FactSink;
  onFact?: (fact: EvidenceFact) => void;
  pollGitMs?: number;
}

export interface EvidenceSession {
  start(): Promise<void>;
  stop(): Promise<void>;
  observeCommand(command: string, exitCode: number): void;
  observeTestOutput(command: string, output: string): void;
  observeReset(files: readonly string[]): void;
  collectGit(): Promise<EvidenceFact[]>;
}

export function createEvidenceSession(
  options: EvidenceSessionOptions,
): EvidenceSession {
  const bridgeSink: FactSink = {
    push(fact: EvidenceFact): void {
      options.sink.push(fact);
      options.onFact?.(fact);
    },
  };
  const collectorOptions = {
    repoId: options.repoId,
    sessionId: options.sessionId,
    sink: bridgeSink,
  };
  const gitCollector = createGitCollector(options.repoPath, options.baseCommit, collectorOptions);
  const fileWatcher = createFileWatcher(options.repoPath, collectorOptions);
  const commandCollector = createCommandCollector(options.repoPath, collectorOptions);
  const revertDetector = createRevertDetector(options.repoPath, collectorOptions);
  // Hoisted per evidence session: one collector parses every test command
  // completion instead of constructing a fresh collector (and its config)
  // on each observeTestOutput call.
  const testCollector = createTestCollector(options.repoPath, collectorOptions);
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  return {
    async start(): Promise<void> {
      const initialFacts = await gitCollector.collect();
      for (const fact of initialFacts) bridgeSink.push(fact);
      fileWatcher.start();
      pollTimer = setInterval(() => {
        if (stopped) return;
        void gitCollector.collect().then((facts) => {
          for (const fact of facts) bridgeSink.push(fact);
        });
        void revertDetector.check().then((fact) => {
          if (fact !== null) bridgeSink.push(fact);
        });
      }, options.pollGitMs ?? 5000);
    },
    async stop(): Promise<void> {
      stopped = true;
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      await fileWatcher.stop();
    },
    observeCommand(command: string, exitCode: number): void {
      commandCollector.observe(command, exitCode);
    },
    observeTestOutput(command: string, output: string): void {
      testCollector.collect(output, command);
    },
    observeReset(files: readonly string[]): void {
      revertDetector.observeReset(files);
    },
    collectGit(): Promise<EvidenceFact[]> {
      return gitCollector.collect();
    },
  };
}

export async function gitDiffFiles(
  repoPath: string,
  files: readonly string[],
  baseCommit?: string,
): Promise<string> {
  const rev = baseCommit && baseCommit.length > 0 ? baseCommit : "HEAD";
  const chunks: string[] = [];
  for (const file of files) {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["diff", rev, "--", file],
        { cwd: repoPath, maxBuffer: 16 * 1024 * 1024 },
      );
      chunks.push(stdout);
    } catch {
      chunks.push(`# diff unavailable for ${file}`);
    }
  }
  return chunks.join("");
}
