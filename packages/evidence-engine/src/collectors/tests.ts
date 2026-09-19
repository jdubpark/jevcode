import type { EvidenceFact, TestFailure } from "@jevcode/contracts";

import {
  resolveCollectorConfig,
  sinkFacts,
  type CollectorContext,
  type CollectorOptions,
  type FactSink,
} from "../sink.js";

export type TestRunnerName = "vitest" | "jest" | "pytest";

export interface ParsedTestOutput {
  runner: TestRunnerName;
  passed: number;
  failed: number;
  skipped: number;
  failures: TestFailure[];
}

const VITEST_SUMMARY = /^\s*Tests\s+(.+?)\s*$/m;
const JEST_SUMMARY = /^\s*Tests:\s+(.+?)\s*$/m;

export function detectTestRunner(text: string): TestRunnerName | null {
  if (parsePytestSummaryLine(text) !== null || /short test summary info/.test(text)) {
    return "pytest";
  }
  if (JEST_SUMMARY.test(text)) return "jest";
  if (VITEST_SUMMARY.test(text) || /Test Files\s/.test(text)) return "vitest";
  return null;
}

function countOccurrence(summary: string, word: string): number {
  const match = new RegExp(`(\\d+)\\s+${word}\\b`).exec(summary);
  return match ? Number.parseInt(match[1] ?? "0", 10) : 0;
}

function parseVitestOutput(text: string): ParsedTestOutput {
  const summaryMatch = VITEST_SUMMARY.exec(text);
  const summary = summaryMatch?.[1] ?? "";
  const failed = countOccurrence(summary, "failed");
  const passed = countOccurrence(summary, "passed");
  let skipped = countOccurrence(summary, "skipped");
  if (skipped === 0 && summary) {
    const totalMatch = /\((\d+)\)/.exec(summary);
    if (totalMatch) {
      const total = Number.parseInt(totalMatch[1] ?? "0", 10);
      skipped = Math.max(0, total - failed - passed);
    }
  }
  return { runner: "vitest", passed, failed, skipped, failures: parseVitestFailures(text) };
}

function parseVitestFailures(text: string): TestFailure[] {
  const failures: TestFailure[] = [];
  const failMarker = /^[ \t]*FAIL\s+(.+?)\s+>\s+(.+?)\s*$/gm;
  let match: RegExpExecArray | null;
  const lines = text.split(/\r?\n/);
  while ((match = failMarker.exec(text)) !== null) {
    const file = match[1] ?? "";
    const testName = match[2] ?? "";
    const startLine = lineIndexAt(lines, match.index);
    const message = collectMessageLines(lines, startLine + 1, "FAIL");
    failures.push({ file, testName, message });
  }
  return failures;
}

function lineIndexAt(lines: string[], charIndex: number): number {
  let position = 0;
  for (let i = 0; i < lines.length; i++) {
    position += lines[i]!.length + 1;
    if (position > charIndex) return i;
  }
  return lines.length - 1;
}

function collectMessageLines(
  lines: string[],
  start: number,
  stopMarkerPrefix: string,
): string {
  const message: string[] = [];
  for (let i = start; i < lines.length && message.length < 12; i++) {
    const line = lines[i] ?? "";
    if (!line.trim()) break;
    if (line.startsWith(stopMarkerPrefix)) break;
    if (/^(Test Files|Tests|⎯|Snapshots|Time:)/.test(line.trim())) break;
    message.push(line.trim());
  }
  return message.join("\n");
}

function parseJestOutput(text: string): ParsedTestOutput {
  const summaryMatch = JEST_SUMMARY.exec(text);
  const summary = summaryMatch?.[1] ?? "";
  const failed = countOccurrence(summary, "failed");
  const passed = countOccurrence(summary, "passed");
  const skipped = countOccurrence(summary, "skipped");
  return { runner: "jest", passed, failed, skipped, failures: parseJestFailures(text) };
}

function parseJestFailures(text: string): TestFailure[] {
  const failures: TestFailure[] = [];
  const lines = text.split(/\r?\n/);
  let currentFile: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const failFile = /^[ \t]*FAIL\s+(.+?)\s*$/.exec(line);
    if (failFile) {
      currentFile = failFile[1] ?? "";
      continue;
    }
    const bullet = /^\s*●\s+(.+)$/.exec(line);
    if (!bullet) continue;
    const testName = (bullet[1] ?? "").trim();
    const message = collectJestMessage(lines, i + 1);
    failures.push({ file: currentFile ?? "", testName, message });
  }
  return failures;
}

function collectJestMessage(lines: string[], start: number): string {
  const parts: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      if (parts.length > 0) parts.push("");
      continue;
    }
    if (trimmed.startsWith("●")) break;
    if (/^(PASS|FAIL|Test Suites|Tests:|Snapshots:|Time:)\b/.test(trimmed)) break;
    const indent = /^[ \t]*/.exec(line)?.[0].length ?? 0;
    if (indent < 4) break;
    parts.push(trimmed);
    if (parts.length > 30) break;
  }
  while (parts.length > 0 && parts.at(-1) === "") parts.pop();
  return parts.join("\n");
}

function parsePytestSummaryLine(text: string): string | null {
  let summary: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (
      /^=+\s*\d/.test(line) &&
      /=+\s*$/.test(line.trim()) &&
      /\bpassed\b/.test(line)
    ) {
      summary = line.trim();
    }
  }
  return summary;
}

function parsePytestOutput(text: string): ParsedTestOutput {
  const summary = parsePytestSummaryLine(text);
  const passed = summary ? countOccurrence(summary, "passed") : 0;
  const failed = summary ? countOccurrence(summary, "failed") : 0;
  const skipped = summary ? countOccurrence(summary, "skipped") : 0;
  return { runner: "pytest", passed, failed, skipped, failures: parsePytestFailures(text) };
}

function parsePytestFailures(text: string): TestFailure[] {
  const failures: TestFailure[] = [];
  const marker = /^[ \t]*FAILED\s+(\S+)::(\S+)(?:\s+-\s+(.+))?\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(text)) !== null) {
    failures.push({
      file: match[1] ?? "",
      testName: match[2] ?? "",
      message: match[3] ?? "",
    });
  }
  return failures;
}

export function parseTestOutput(
  text: string,
  forcedRunner?: TestRunnerName,
): ParsedTestOutput | null {
  const runner = forcedRunner ?? detectTestRunner(text);
  switch (runner) {
    case "vitest":
      return parseVitestOutput(text);
    case "jest":
      return parseJestOutput(text);
    case "pytest":
      return parsePytestOutput(text);
    default:
      return null;
  }
}

export interface TestCollectorOptions extends CollectorOptions {}

export interface TestCollector {
  readonly sink: FactSink;
  readonly facts: readonly EvidenceFact[];
  collect(text: string, command: string, runner?: TestRunnerName): EvidenceFact | null;
}

export function createTestCollector(
  repoPath: string,
  opts: TestCollectorOptions = {},
): TestCollector {
  const cfg = resolveCollectorConfig(repoPath, opts);
  const ctx: CollectorContext = cfg.ctx;
  return {
    sink: cfg.sink,
    get facts(): readonly EvidenceFact[] {
      return sinkFacts(cfg.sink);
    },
    collect(text: string, command: string, runner?: TestRunnerName): EvidenceFact | null {
      const parsed = parseTestOutput(text, runner);
      if (!parsed) return null;
      const fact: EvidenceFact = {
        type: "test_result",
        repoId: ctx.repoId,
        sessionId: ctx.sessionId,
        runner: parsed.runner,
        command,
        passed: parsed.passed,
        failed: parsed.failed,
        skipped: parsed.skipped,
        failures: parsed.failures,
        ts: cfg.now(),
      };
      cfg.sink.push(fact);
      return fact;
    },
  };
}
