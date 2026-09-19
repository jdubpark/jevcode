import type { EvidenceFact } from "@jevcode/contracts";

import { classifyDestructive } from "../destructive.js";
import {
  resolveCollectorConfig,
  sinkFacts,
  type CollectorContext,
  type CollectorOptions,
  type FactSink,
} from "../sink.js";

const DEFAULT_PROMPT_PATTERN = /^\s*[$>]\s+(?:\S+\s+)?\S/;

export function extractCommandLines(
  text: string,
  promptPattern: RegExp = DEFAULT_PROMPT_PATTERN,
): string[] {
  const commands: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (promptPattern.test(line)) {
      const command = line.replace(/^\s*[$>]\s+/, "").trim();
      if (command) commands.push(command);
    }
  }
  return commands;
}

export interface CommandCollectorOptions extends CollectorOptions {}

export interface CommandCollector {
  readonly sink: FactSink;
  readonly facts: readonly EvidenceFact[];
  observe(command: string, exitCode: number): EvidenceFact | null;
  observeAll(observations: readonly { command: string; exitCode: number }[]): EvidenceFact[];
}

export function createCommandCollector(
  repoPath: string,
  opts: CommandCollectorOptions = {},
): CommandCollector {
  const cfg = resolveCollectorConfig(repoPath, opts);
  const ctx: CollectorContext = cfg.ctx;

  return {
    sink: cfg.sink,
    get facts(): readonly EvidenceFact[] {
      return sinkFacts(cfg.sink);
    },
    observe(command: string, exitCode: number): EvidenceFact | null {
      const trimmed = command.trim();
      if (!trimmed) return null;
      const fact: EvidenceFact = {
        type: "command_executed",
        repoId: ctx.repoId,
        sessionId: ctx.sessionId,
        command: trimmed,
        exitCode,
        isDestructive: classifyDestructive(trimmed),
        ts: cfg.now(),
      };
      cfg.sink.push(fact);
      return fact;
    },
    observeAll(
      observations: readonly { command: string; exitCode: number }[],
    ): EvidenceFact[] {
      const facts: EvidenceFact[] = [];
      for (const observation of observations) {
        const fact = this.observe(observation.command, observation.exitCode);
        if (fact) facts.push(fact);
      }
      return facts;
    },
  };
}
