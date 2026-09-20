import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
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
  log?: (message: string) => void;
}

export interface EvidenceSession {
  start(): Promise<void>;
  stop(): Promise<void>;
  observeCommand(command: string, exitCode: number): void;
  observeTestOutput(command: string, output: string): void;
  observeReset(files: readonly string[]): void;
  collectGit(): Promise<EvidenceFact[]>;
}

export function isEBADF(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ("code" in error && (error as NodeJS.ErrnoException).code === "EBADF") {
    return true;
  }
  return error.message.includes("spawn EBADF");
}

export function countOpenFds(): number | null {
  if (process.platform !== "darwin") return null;
  try {
    return readdirSync("/dev/fd").filter((entry) => /^\d+$/.test(entry)).length;
  } catch {
    return null;
  }
}

function describeSpawnError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!isEBADF(error)) return message;
  const fds = countOpenFds();
  if (fds === null) return message;
  return `${message} (${fds} open fds; macOS posix_spawn rejects stdio pipes above ~10239, libuv/libuv#5204)`;
}

function createFailureTracker(log: (message: string) => void) {
  let consecutive = 0;
  return {
    success(): void {
      consecutive = 0;
    },
    failure(source: string, error: unknown): void {
      consecutive++;
      if (consecutive !== 1 && consecutive % 10 !== 0) return;
      log(
        `evidence poll: ${source} failed (${consecutive} consecutive): ${describeSpawnError(error)}`,
      );
    },
  };
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
  const log = options.log ?? ((message: string) => console.warn(message));
  const collectTracker = createFailureTracker(log);
  const checkTracker = createFailureTracker(log);
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  return {
    async start(): Promise<void> {
      try {
        const initialFacts = await gitCollector.collect();
        collectTracker.success();
        for (const fact of initialFacts) bridgeSink.push(fact);
      } catch (error) {
        collectTracker.failure("initial git collect", error);
      }
      fileWatcher.start();
      pollTimer = setInterval(() => {
        if (stopped) return;
        void gitCollector
          .collect()
          .then((facts) => {
            collectTracker.success();
            for (const fact of facts) bridgeSink.push(fact);
          })
          .catch((error: unknown) => collectTracker.failure("git collect", error));
        void revertDetector
          .check()
          .then((fact) => {
            checkTracker.success();
            if (fact !== null) bridgeSink.push(fact);
          })
          .catch((error: unknown) => checkTracker.failure("revert check", error));
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
