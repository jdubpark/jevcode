import type { EvidenceFact, SymbolInfo } from "@jevcode/contracts";
import { describe, expect, it } from "vitest";

import type { ParseService } from "../worker/parse-service.js";
import { createSymbolCollector } from "./symbols.js";

type SymbolDeltaFact = Extract<EvidenceFact, { type: "symbol_delta" }>;

function asSymbolDelta(fact: EvidenceFact | null | undefined): SymbolDeltaFact {
  expect(fact?.type).toBe("symbol_delta");
  return fact as SymbolDeltaFact;
}

function fakeParseService(): ParseService {
  return {
    async parseFile(_filePath: string, source: string): Promise<SymbolInfo[]> {
      const symbols: SymbolInfo[] = [];
      const lines = source.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const match = /^(?:export\s+)?function\s+(\w+)\(([^)]*)\)/.exec(
          lines[i] ?? "",
        );
        if (!match) continue;
        symbols.push({
          name: match[1] ?? "",
          kind: "function",
          signature: `function ${match[1]}(${match[2] ?? ""})`,
          startLine: i + 1,
          endLine: i + 1,
        });
      }
      return symbols;
    },
    async dispose(): Promise<void> {},
  };
}

const BASE_SOURCE = [
  "export function greet(name) {",
  "  return `hi ${name}`;",
  "}",
  "export function oldFn() {}",
].join("\n");

const CURRENT_SOURCE = [
  "export function greet(name: string): string {",
  "  return `hello ${name}`;",
  "}",
  "export function newFn() {}",
].join("\n");

describe("createSymbolCollector", () => {
  const baseOpts = {
    repoId: "repo-1",
    sessionId: "sess-1",
    now: () => "2026-01-01T00:00:00.000Z",
  };

  it("emits symbol_delta with added/removed/modified classification", async () => {
    const collector = createSymbolCollector("/repo", {
      ...baseOpts,
      parseService: fakeParseService(),
      readFile: async () => CURRENT_SOURCE,
    });
    const fact = asSymbolDelta(
      await collector.collectFile(
        "src/a.ts",
        new Map([["src/a.ts", BASE_SOURCE]]),
      ),
    );
    expect(fact.type).toBe("symbol_delta");
    expect(fact.path).toBe("src/a.ts");
    expect(fact.added.map((s) => s.name)).toEqual(["newFn"]);
    expect(fact.removed.map((s) => s.name)).toEqual(["oldFn"]);
    expect(fact.modified.map((s) => s.name)).toEqual(["greet"]);
    expect(collector.facts).toHaveLength(1);
  });

  it("treats a file with no base snapshot as fully added", async () => {
    const collector = createSymbolCollector("/repo", {
      ...baseOpts,
      parseService: fakeParseService(),
      readFile: async () => CURRENT_SOURCE,
    });
    const fact = asSymbolDelta(await collector.collectFile("src/a.ts"));
    expect(fact.added.map((s) => s.name)).toEqual(["greet", "newFn"]);
    expect(fact.removed).toEqual([]);
    expect(fact.modified).toEqual([]);
  });

  it("emits nothing when the file is unchanged", async () => {
    const collector = createSymbolCollector("/repo", {
      ...baseOpts,
      parseService: fakeParseService(),
      readFile: async () => BASE_SOURCE,
    });
    const fact = await collector.collectFile(
      "src/a.ts",
      new Map([["src/a.ts", BASE_SOURCE]]),
    );
    expect(fact).toBeNull();
    expect(collector.facts).toHaveLength(0);
  });

  it("collects multiple files with a shared snapshot", async () => {
    const collector = createSymbolCollector("/repo", {
      ...baseOpts,
      parseService: fakeParseService(),
      readFile: async (absPath: string) =>
        absPath.endsWith("b.ts") ? CURRENT_SOURCE : BASE_SOURCE,
    });
    const facts = await collector.collectFiles(
      ["src/a.ts", "src/b.ts"],
      new Map([
        ["src/a.ts", BASE_SOURCE],
        ["src/b.ts", BASE_SOURCE],
      ]),
    );
    expect(facts).toHaveLength(1);
    expect(asSymbolDelta(facts[0]).path).toBe("src/b.ts");
  });

  it("emits facts that validate against the contracts schema", async () => {
    const collector = createSymbolCollector("/repo", {
      ...baseOpts,
      parseService: fakeParseService(),
      readFile: async () => CURRENT_SOURCE,
    });
    await collector.collectFile(
      "src/a.ts",
      new Map([["src/a.ts", BASE_SOURCE]]),
    );
    const fact = asSymbolDelta(collector.facts[0]);
    for (const symbol of [...fact.added, ...fact.removed, ...fact.modified]) {
      expect(symbol).toMatchObject({
        name: expect.any(String),
        kind: expect.any(String),
        signature: expect.any(String),
        startLine: expect.any(Number),
        endLine: expect.any(Number),
      });
    }
  });
});
