import type {
  EvidenceFact,
  NormalizedAgentEvent,
  SymbolInfo,
} from "@jevcode/contracts";

import type { SequencedFact } from "./clustering.js";

export const REPO = "repo-test";
export const SESSION = "sess-test";

export function seq(
  entry: { fact: EvidenceFact; factId?: string; seq: number; batchId?: number },
  seqNo?: number,
): SequencedFact {
  return {
    fact: entry.fact,
    factId: entry.factId ?? `fact_${seqNo ?? entry.seq}`,
    seq: entry.seq,
    batchId: entry.batchId ?? 0,
  };
}

export function hunk(
  file: string,
  ts: string,
  opts: Partial<Extract<EvidenceFact, { type: "git_hunk" }>> = {},
): EvidenceFact {
  return {
    type: "git_hunk",
    repoId: REPO,
    sessionId: SESSION,
    file,
    added: 1,
    removed: 0,
    isFormattingOnly: false,
    isConfigOnly: false,
    isLockfile: false,
    ts,
    ...opts,
  };
}

export function fileChanged(
  path: string,
  kind: "added" | "modified" | "deleted",
  ts: string,
): EvidenceFact {
  return { type: "file_changed", repoId: REPO, sessionId: SESSION, path, kind, ts };
}

export function symbolDelta(
  path: string,
  ts: string,
  delta: { added?: SymbolInfo[]; removed?: SymbolInfo[]; modified?: SymbolInfo[] },
): EvidenceFact {
  return {
    type: "symbol_delta",
    repoId: REPO,
    sessionId: SESSION,
    path,
    added: delta.added ?? [],
    removed: delta.removed ?? [],
    modified: delta.modified ?? [],
    ts,
  };
}

export function importSymbol(name: string, specifier: string): SymbolInfo {
  return {
    name,
    kind: "import",
    signature: `import { ${name} } from "${specifier}";`,
    startLine: 1,
    endLine: 1,
  };
}

export function functionSymbol(name: string, signature?: string): SymbolInfo {
  return {
    name,
    kind: "function",
    signature: signature ?? `export function ${name}(): void {`,
    startLine: 2,
    endLine: 4,
  };
}

export function depChange(
  ts: string,
  added: { name: string; version: string }[] = [],
  removed: { name: string; version: string }[] = [],
  manifest = "package.json",
): EvidenceFact {
  return {
    type: "dependency_change",
    repoId: REPO,
    sessionId: SESSION,
    manifest,
    added,
    removed,
    ts,
  };
}

export function testResult(
  ts: string,
  opts: Partial<Extract<EvidenceFact, { type: "test_result" }>> = {},
): Extract<EvidenceFact, { type: "test_result" }> {
  return {
    type: "test_result",
    repoId: REPO,
    sessionId: SESSION,
    runner: "vitest",
    command: "pnpm test",
    passed: 0,
    failed: 0,
    skipped: 0,
    failures: [],
    ts,
    ...opts,
  };
}

export function commandExecuted(ts: string, command = "pnpm test", isDestructive = false): EvidenceFact {
  return {
    type: "command_executed",
    repoId: REPO,
    sessionId: SESSION,
    command,
    exitCode: 0,
    isDestructive,
    ts,
  };
}

export function revertDetected(ts: string, files: string[]): EvidenceFact {
  return { type: "revert_detected", repoId: REPO, sessionId: SESSION, files, ts };
}

export function agentEvent(
  type: NormalizedAgentEvent["type"],
  ts: string,
  extra: Record<string, unknown> = {},
): NormalizedAgentEvent {
  return { type, sessionId: SESSION, ts, ...extra } as NormalizedAgentEvent;
}

export function tsOf(minutes: number, seconds = 0): string {
  return new Date(Date.UTC(2026, 0, 1, 0, minutes, seconds)).toISOString();
}
