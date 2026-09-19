import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { symbolIdForPath } from "../symbol-diff.js";
import {
  createTreeSitterBackend,
  languageForPath,
  type TreeSitterBackend,
} from "./parser.js";

const SAMPLE_TS = `export function greet(name: string): string {
  return \`hello \${name}\`;
}

export class Greeter {
  prefix: string = "hi";

  greet(name: string): string {
    return this.prefix + name;
  }
}

export interface Named {
  name: string;
}

export type Id = string | number;

const MAX = 10;

import { z } from "zod";

export { MAX as LIMIT };
`;

describe("languageForPath", () => {
  it.each([
    ["src/a.ts", "typescript"],
    ["src/a.tsx", "tsx"],
    ["src/a.js", "javascript"],
    ["src/a.mjs", "javascript"],
    ["src/a.jsx", "javascript"],
    ["package.json", "json"],
  ])("maps %s to %s", (filePath, language) => {
    expect(languageForPath(filePath)).toBe(language);
  });

  it.each(["src/a.py", "src/a.md", "src/Dockerfile"])(
    "returns null for unsupported %s",
    (filePath) => {
      expect(languageForPath(filePath)).toBeNull();
    },
  );
});

describe("tree-sitter parsing", () => {
  let backend: TreeSitterBackend | null = null;
  let initError: string | null = null;

  beforeAll(async () => {
    try {
      backend = await createTreeSitterBackend();
    } catch (error) {
      initError = error instanceof Error ? error.message : String(error);
      console.warn(`[evidence-engine] tree-sitter backend unavailable: ${initError}`);
    }
  });

  afterAll(async () => {
    await backend?.dispose();
  });

  const requireBackend = (ctx: { skip(): void }): TreeSitterBackend | null => {
    if (!backend) {
      console.warn(
        `[evidence-engine] skipping tree-sitter test: ${initError ?? "backend unavailable"}`,
      );
      ctx.skip();
      return null;
    }
    return backend;
  };

  it("parses a sample TypeScript file", (ctx) => {
    const parser = requireBackend(ctx);
    if (!parser) return;
    const symbols = parser.parse(SAMPLE_TS, "typescript");
    const byName = new Map(symbols.map((s) => [`${s.name}:${s.kind}`, s]));

    expect(byName.get("greet:function")).toMatchObject({
      name: "greet",
      kind: "function",
      signature: "function greet(name: string): string",
      startLine: 1,
      endLine: 3,
    });
    expect(byName.get("Greeter:class")).toMatchObject({
      kind: "class",
      signature: "class Greeter",
    });
    const method = byName.get("greet:method");
    expect(method?.signature).toBe("greet(name: string): string");
    expect(byName.get("Named:interface")).toMatchObject({ kind: "interface" });
    expect(byName.get("Id:type")).toMatchObject({ kind: "type" });
    expect(byName.get("MAX:variable")).toMatchObject({ kind: "variable" });
    expect(byName.get("z:import")).toMatchObject({
      kind: "import",
      signature: expect.stringContaining('"zod"'),
    });
    expect(byName.get("LIMIT:export")).toMatchObject({
      kind: "export",
      signature: expect.stringContaining("MAX as LIMIT"),
    });
  });

  it("records import and export binding names from real parse output", (ctx) => {
    const parser = requireBackend(ctx);
    if (!parser) return;
    const source = `import a from "./default";
import { b, c as cc } from "./named";
import * as ns from "pkg";
import "./side";
export default function run() {}
const x = 1;
export { x as EX };
export * from "./everything";
`;
    const symbols = parser.parse(source, "typescript");
    const byName = new Map(symbols.map((s) => [`${s.name}:${s.kind}`, s]));

    const aImport = byName.get("a:import");
    expect(aImport?.signature).toContain('"./default"');
    const bImport = byName.get("b:import");
    expect(bImport?.signature).toContain('"./named"');
    const ccImport = byName.get("cc:import");
    expect(ccImport?.signature).toContain('"./named"');
    const nsImport = byName.get("ns:import");
    expect(nsImport?.signature).toContain('"pkg"');
    const sideImport = byName.get("./side:import");
    expect(sideImport?.kind).toBe("import");

    expect(byName.get("run:function")).toMatchObject({ kind: "function" });
    expect(byName.get("run:export")).toMatchObject({ kind: "export" });
    expect(byName.get("EX:export")).toMatchObject({
      kind: "export",
      signature: expect.stringContaining("x as EX"),
    });
    expect(byName.get("./everything:export")).toMatchObject({ kind: "export" });
  });

  it("produces stable signatures across parses", (ctx) => {
    const parser = requireBackend(ctx);
    if (!parser) return;
    const first = parser.parse(SAMPLE_TS, "typescript");
    const second = parser.parse(SAMPLE_TS, "typescript");
    expect(first).toEqual(second);
    const ids1 = first.map((s) => symbolIdForPath("src/a.ts", s));
    const ids2 = second.map((s) => symbolIdForPath("src/a.ts", s));
    expect(ids1).toEqual(ids2);
  });

  it("parses TSX", (ctx) => {
    const parser = requireBackend(ctx);
    if (!parser) return;
    const symbols = parser.parse(
      "const App = () => <div>hello</div>;\n",
      "tsx",
    );
    expect(symbols.map((s) => s.name)).toContain("App");
  });

  it("parses JSON without symbols", (ctx) => {
    const parser = requireBackend(ctx);
    if (!parser) return;
    const symbols = parser.parse('{"name": "demo", "version": "1.0.0"}', "json");
    expect(symbols).toEqual([]);
  });
});
