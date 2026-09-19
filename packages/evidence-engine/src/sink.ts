import { basename, resolve } from "node:path";

import { EvidenceFactSchema, type EvidenceFact } from "@jevcode/contracts";

export interface FactSink {
  push(fact: EvidenceFact): void;
}

export class InMemorySink implements FactSink {
  readonly facts: EvidenceFact[] = [];
  private readonly validate: boolean;

  constructor(validate = true) {
    this.validate = validate;
  }

  push(fact: EvidenceFact): void {
    if (this.validate) {
      EvidenceFactSchema.parse(fact);
    }
    this.facts.push(fact);
  }

  clear(): void {
    this.facts.length = 0;
  }
}

export interface CollectorContext {
  repoId: string;
  sessionId: string;
}

export interface CollectorOptions {
  repoId?: string;
  sessionId?: string;
  sink?: FactSink;
  now?: () => string;
}

export interface ResolvedCollectorConfig {
  ctx: CollectorContext;
  sink: FactSink;
  now: () => string;
}

export function resolveCollectorConfig(
  repoPath: string,
  opts: CollectorOptions = {},
): ResolvedCollectorConfig {
  return {
    ctx: {
      repoId: opts.repoId ?? basename(resolve(repoPath)),
      sessionId: opts.sessionId ?? "default",
    },
    sink: opts.sink ?? new InMemorySink(),
    now: opts.now ?? (() => new Date().toISOString()),
  };
}

export function sinkFacts(sink: FactSink): readonly EvidenceFact[] {
  return sink instanceof InMemorySink ? sink.facts : [];
}
