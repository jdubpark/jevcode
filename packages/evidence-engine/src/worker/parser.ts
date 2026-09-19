import { createRequire } from "node:module";
import path from "node:path";

import type { SymbolInfo } from "@jevcode/contracts";

import { extractSymbols, type ParseNode } from "./tree-sitter.js";

export type ParserLanguage = "typescript" | "tsx" | "javascript" | "json";

const EXTENSION_LANGUAGES: Readonly<Record<string, ParserLanguage>> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".json": "json",
};

export function languageForPath(filePath: string): ParserLanguage | null {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_LANGUAGES[ext] ?? null;
}

const GRAMMAR_FILES: Readonly<Record<ParserLanguage, string>> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  json: "tree-sitter-json.wasm",
};

export interface TreeSitterBackend {
  parse(source: string, language: ParserLanguage): SymbolInfo[];
  dispose(): Promise<void>;
}

interface WebTreeSitterModule {
  init(): Promise<void>;
  Language: { load(wasmPath: string): Promise<unknown> };
  new (): unknown;
}

type AnyWebModule = Record<string, unknown> & { default?: unknown };

function resolveGrammarPath(language: ParserLanguage): string {
  const require = createRequire(import.meta.url);
  const grammarFile = GRAMMAR_FILES[language];
  try {
    return require.resolve(`tree-sitter-wasms/out/${grammarFile}`);
  } catch {
    const packageDir = path.dirname(
      require.resolve("tree-sitter-wasms/package.json"),
    );
    return path.join(packageDir, "out", grammarFile);
  }
}

export async function createTreeSitterBackend(): Promise<TreeSitterBackend> {
  let webError: unknown;
  try {
    return await createWebTreeSitterBackend();
  } catch (error) {
    webError = error;
  }
  try {
    const native = await import("node-tree-sitter");
    return createNativeTreeSitterBackend(native);
  } catch {
    const message =
      webError instanceof Error ? webError.message : String(webError);
    throw new Error(
      `tree-sitter backend initialization failed (web-tree-sitter unavailable: ${message}; node-tree-sitter not installed)`,
    );
  }
}

async function createWebTreeSitterBackend(): Promise<TreeSitterBackend> {
  const module = (await import("web-tree-sitter")) as AnyWebModule;
  const root = (module.default ?? module) as AnyWebModule;
  const Parser = (root.Parser ?? root) as unknown as WebTreeSitterModule;
  if (typeof Parser.init !== "function") {
    throw new Error("web-tree-sitter module surface does not match expectations");
  }
  await Parser.init();
  // Language is attached to the Parser class only after init() resolves
  const Language = (root.Language ??
    Parser.Language) as unknown as WebTreeSitterModule["Language"];
  if (typeof Language?.load !== "function") {
    throw new Error("web-tree-sitter Language loader unavailable after init");
  }
  const languages = new Map<ParserLanguage, unknown>();
  for (const language of Object.keys(GRAMMAR_FILES) as ParserLanguage[]) {
    languages.set(language, await Language.load(resolveGrammarPath(language)));
  }
  return {
    parse(source: string, language: ParserLanguage): SymbolInfo[] {
      const grammarLanguage = languages.get(language);
      if (!grammarLanguage) {
        throw new Error(`grammar not loaded for language: ${language}`);
      }
      const parser = new Parser() as unknown as {
        setLanguage(language: unknown): void;
        parse(source: string): { rootNode: ParseNode };
        delete(): void;
      };
      try {
        parser.setLanguage(grammarLanguage);
        const tree = parser.parse(source);
        return extractSymbols(tree.rootNode, source);
      } finally {
        parser.delete();
      }
    },
    async dispose(): Promise<void> {
      languages.clear();
    },
  };
}

function createNativeTreeSitterBackend(module: unknown): TreeSitterBackend {
  const root = module as AnyWebModule;
  const Parser = root.Parser as unknown as WebTreeSitterModule;
  const Language = root.Language as unknown as WebTreeSitterModule["Language"];
  return {
    parse(source: string, language: ParserLanguage): SymbolInfo[] {
      const require = createRequire(import.meta.url);
      const grammarPackage =
        language === "tsx" ? "tree-sitter-tsx" : `tree-sitter-${language}`;
      const grammarLanguage = Language.load(require.resolve(grammarPackage));
      const parser = new Parser() as unknown as {
        setLanguage(language: unknown): void;
        parse(source: string): { rootNode: ParseNode };
      };
      parser.setLanguage(grammarLanguage);
      return extractSymbols(parser.parse(source).rootNode, source);
    },
    async dispose(): Promise<void> {},
  };
}
