import { readFile as fsReadFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { EvidenceFact } from "@jevcode/contracts";

import {
  resolveCollectorConfig,
  sinkFacts,
  type CollectorContext,
  type CollectorOptions,
  type FactSink,
} from "../sink.js";
import { diffSymbols, hasDelta, type SymbolDeltaParts } from "../symbol-diff.js";
import {
  createInlineParseService,
  type ParseService,
} from "../worker/parse-service.js";

export type BaseSnapshot = ReadonlyMap<string, string>;

export interface SymbolCollectorOptions extends CollectorOptions {
  parseService?: ParseService;
  readFile?: (absPath: string) => Promise<string>;
}

export interface SymbolCollector {
  readonly repoPath: string;
  readonly sink: FactSink;
  readonly facts: readonly EvidenceFact[];
  diff(relPath: string, baseSource: string | null, currentSource: string): Promise<SymbolDeltaParts | null>;
  collectFile(relPath: string, snapshot?: BaseSnapshot): Promise<EvidenceFact | null>;
  collectFiles(relPaths: readonly string[], snapshot?: BaseSnapshot): Promise<EvidenceFact[]>;
  dispose(): Promise<void>;
}

export function createSymbolCollector(
  repoPath: string,
  opts: SymbolCollectorOptions = {},
): SymbolCollector {
  const cfg = resolveCollectorConfig(repoPath, opts);
  const ctx: CollectorContext = cfg.ctx;
  const parseService = opts.parseService ?? createInlineParseService();
  const readFile = opts.readFile ?? ((absPath: string) => fsReadFile(absPath, "utf8"));
  const ownsParseService = opts.parseService === undefined;

  return {
    repoPath,
    sink: cfg.sink,
    get facts(): readonly EvidenceFact[] {
      return sinkFacts(cfg.sink);
    },
    async diff(
      relPath: string,
      baseSource: string | null,
      currentSource: string,
    ): Promise<SymbolDeltaParts | null> {
      const currentSymbols = await parseService.parseFile(relPath, currentSource);
      if (baseSource === null) {
        return {
          added: currentSymbols,
          removed: [],
          modified: [],
        };
      }
      const baseSymbols = await parseService.parseFile(relPath, baseSource);
      return diffSymbols(baseSymbols, currentSymbols, relPath);
    },
    async collectFile(relPath: string, snapshot?: BaseSnapshot): Promise<EvidenceFact | null> {
      const currentSource = await readFile(resolve(repoPath, relPath));
      const baseSource = snapshot?.get(relPath) ?? null;
      const delta = await this.diff(relPath, baseSource, currentSource);
      if (!delta || !hasDelta(delta)) return null;
      const fact: EvidenceFact = {
        type: "symbol_delta",
        repoId: ctx.repoId,
        sessionId: ctx.sessionId,
        path: relPath,
        added: delta.added,
        removed: delta.removed,
        modified: delta.modified,
        ts: cfg.now(),
      };
      cfg.sink.push(fact);
      return fact;
    },
    async collectFiles(
      relPaths: readonly string[],
      snapshot?: BaseSnapshot,
    ): Promise<EvidenceFact[]> {
      const facts: EvidenceFact[] = [];
      for (const relPath of relPaths) {
        const fact = await this.collectFile(relPath, snapshot);
        if (fact) facts.push(fact);
      }
      return facts;
    },
    async dispose(): Promise<void> {
      if (ownsParseService) {
        await parseService.dispose();
      }
    },
  };
}
