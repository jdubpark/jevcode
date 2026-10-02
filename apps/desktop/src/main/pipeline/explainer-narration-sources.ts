import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import type { Component, SymbolInfo } from "@jevcode/contracts";
import { languageForPath } from "@jevcode/evidence-engine";
import type { ParseService } from "@jevcode/evidence-engine";
import { clipChars } from "@jevcode/jev-router";

import type { BriefSources } from "./explainer-narration.js";
import { redactText } from "./redactor.js";

export const README_BLURB_MAX_CHARS = 600;
export const SOURCE_READ_MAX_BYTES = 256 * 1024;
export const README_HEAD_BYTES = 64 * 1024;
export const EXPORT_FILES_PER_COMPONENT = 3;
export const EXPORTS_PER_COMPONENT = 15;

const README_NAMES = ["README.md", "readme.md", "Readme.md", "README.markdown", "README.txt", "README"];
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const RULE_LINE = /^[-=*_]{3,}$/;
const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s/;
const INDEX_FILE = /(^|\/)index\.[cm]?[jt]sx?$/;

/** First prose paragraph: skips front matter, headings, badges, HTML, comments, fences, quotes, lists, tables and rules. */
export function firstReadmeParagraph(markdown: string): string | null {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const paragraph: string[] = [];
  let inFence = false;
  let inComment = false;
  let inFrontMatter = false;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? "").trim();
    if (index === 0 && trimmed === "---") {
      inFrontMatter = true;
      continue;
    }
    if (inFrontMatter) {
      if (trimmed === "---") inFrontMatter = false;
      continue;
    }
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      if (paragraph.length > 0) break;
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (inComment) {
      if (trimmed.includes("-->")) inComment = false;
      continue;
    }
    if (trimmed.startsWith("<!--")) {
      if (!trimmed.includes("-->")) inComment = true;
      continue;
    }
    if (trimmed === "") {
      if (paragraph.length > 0) break;
      continue;
    }
    const skippable =
      trimmed.startsWith("#") ||
      trimmed.startsWith("![") ||
      trimmed.startsWith("[![") ||
      trimmed.startsWith("<") ||
      trimmed.startsWith(">") ||
      trimmed.startsWith("|") ||
      RULE_LINE.test(trimmed) ||
      LIST_ITEM.test(trimmed);
    if (skippable) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(trimmed);
  }
  const text = paragraph.join(" ").replace(/\s+/g, " ").trim();
  return text === "" ? null : text;
}

/** A1 redaction first, then the 600-character clip (spec §6.2), so a secret cut by the clip is still caught. */
export function blurbFrom(text: string): string | null {
  const redacted = redactText(text.replace(/\s+/g, " ").trim()).text;
  return redacted === "" ? null : clipChars(redacted, README_BLURB_MAX_CHARS);
}

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/** Reads a regular file inside the repo; null for symlinks, escapes, missing or oversized files. */
async function readInside(
  repoRoot: string,
  relative: string,
  maxBytes: number,
  mode: "skip" | "head",
): Promise<string | null> {
  try {
    const root = await realpath(repoRoot);
    const absolute = path.resolve(root, relative);
    if (!within(root, absolute)) return null;
    const info = await lstat(absolute);
    if (!info.isFile()) return null;
    const real = await realpath(absolute);
    if (!within(root, real)) return null;
    if (info.size > maxBytes && mode === "skip") return null;
    const handle = await open(real, "r");
    try {
      const buffer = Buffer.alloc(Math.min(info.size, maxBytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

function manifestDescription(json: string): string | null {
  try {
    const parsed = JSON.parse(json) as { description?: unknown };
    return typeof parsed.description === "string" && parsed.description.trim() !== "" ? parsed.description : null;
  } catch {
    return null;
  }
}

const RESERVED_EXPORT_NAMES: ReadonlySet<string> = new Set(["default", "export"]);

/**
 * Exported identifiers from the parse worker's symbols. `exportSymbols`
 * (packages/evidence-engine/src/worker/tree-sitter.ts) names `export const X = …`
 * "default" (a lexical_declaration has no name field) and a bare
 * `export default x;` "export", so a declaration symbol that starts on the same
 * line as an export statement counts as exported too.
 */
export function exportedNames(symbols: readonly SymbolInfo[]): string[] {
  const exportLines = new Set(symbols.filter((symbol) => symbol.kind === "export").map((symbol) => symbol.startLine));
  const names: string[] = [];
  for (const symbol of symbols) {
    const exported =
      symbol.kind === "export"
        ? !RESERVED_EXPORT_NAMES.has(symbol.name)
        : symbol.kind !== "import" && symbol.kind !== "method" && exportLines.has(symbol.startLine);
    if (!exported || !IDENTIFIER.test(symbol.name) || names.includes(symbol.name)) continue;
    names.push(symbol.name);
  }
  return names;
}

/** Entry points first, else shallow index files; at most 3 parseable non-JSON files. */
export function exportCandidates(component: Component): string[] {
  const parseable = (file: string): boolean => languageForPath(file) !== null && !file.endsWith(".json");
  const entries = component.entryPoints.filter(parseable);
  const fallback = component.files
    .filter((file) => parseable(file) && INDEX_FILE.test(file))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  return [...new Set([...entries, ...fallback])].slice(0, EXPORT_FILES_PER_COMPONENT);
}

export interface FsBriefSourcesOptions {
  repoRoot: string;
  /** Without a parser, `exports` returns [] (N-5 takes exports from lane 04's OverviewView). */
  parse?: Pick<ParseService, "parseFile">;
}

export function createFsBriefSources(options: FsBriefSourcesOptions): BriefSources {
  const dirOf = (component: Component): string => (component.rootPath === "." ? "" : component.rootPath);
  return {
    async blurb(component) {
      const dir = dirOf(component);
      const manifest = await readInside(options.repoRoot, path.posix.join(dir, "package.json"), SOURCE_READ_MAX_BYTES, "skip");
      const description = manifest === null ? null : manifestDescription(manifest);
      if (description !== null) return blurbFrom(description);
      for (const name of README_NAMES) {
        const readme = await readInside(options.repoRoot, path.posix.join(dir, name), README_HEAD_BYTES, "head");
        if (readme === null) continue;
        const paragraph = firstReadmeParagraph(readme);
        return paragraph === null ? null : blurbFrom(paragraph);
      }
      return null;
    },
    async exports(component) {
      const parse = options.parse;
      if (parse === undefined) return [];
      const names: string[] = [];
      for (const file of exportCandidates(component)) {
        const source = await readInside(options.repoRoot, file, SOURCE_READ_MAX_BYTES, "skip");
        if (source === null) continue;
        let symbols: SymbolInfo[];
        try {
          symbols = await parse.parseFile(file, source);
        } catch {
          continue;
        }
        for (const name of exportedNames(symbols)) {
          if (!names.includes(name)) names.push(name);
        }
        if (names.length >= EXPORTS_PER_COMPONENT) break;
      }
      return names.slice(0, EXPORTS_PER_COMPONENT);
    },
  };
}
