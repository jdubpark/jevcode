import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The @jevcode/contracts barrel ships to browser bundles (renderer, trace viewer).
// Walk the runtime import graph from src/index.ts and report every Node built-in it reaches.
const SRC = path.dirname(fileURLToPath(import.meta.url));
const NODE_BUILTINS = new Set(builtinModules);
// import/export statements with a module specifier; group 1 marks type-only statements,
// which verbatimModuleSyntax erases, so they add nothing to the runtime graph.
const STATEMENT = /\b(?:import|export)\s+(type\s+)?(?:[\w*{}\s,]+?\s+from\s+)?["']([^"']+)["']/g;

interface Graph {
  visited: string[];
  nodeImports: string[];
}

function walk(entry: string): Graph {
  const visited = new Set<string>();
  const nodeImports: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (visited.has(file)) continue;
    visited.add(file);
    const text = readFileSync(path.join(SRC, file), "utf8");
    for (const match of text.matchAll(STATEMENT)) {
      const typeOnly = match[1] !== undefined;
      const specifier = match[2] as string;
      if (typeOnly) continue;
      if (specifier.startsWith(".")) {
        const target = path.posix.join(path.posix.dirname(file), specifier).replace(/\.js$/, ".ts");
        queue.push(target);
      } else if (specifier.startsWith("node:") || NODE_BUILTINS.has(specifier.split("/")[0] as string)) {
        nodeImports.push(`${file} -> ${specifier}`);
      }
    }
  }
  return { visited: [...visited].sort(), nodeImports: nodeImports.sort() };
}

describe("contracts barrel browser safety", () => {
  const graph = walk("index.ts");

  it("reaches the whole barrel", () => {
    expect(graph.visited).toEqual(
      expect.arrayContaining(["agent-events.ts", "evidence.ts", "id.ts", "overview.ts", "semantic.ts", "ui/components.ts"]),
    );
  });

  it("imports no Node built-in at runtime", () => {
    expect(graph.nodeImports).toEqual([]);
  });

  it("keeps node.ts out of the barrel", () => {
    expect(graph.visited).not.toContain("node.ts");
  });
});
