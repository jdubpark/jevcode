import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Component, SymbolInfo } from "@jevcode/contracts";
import { createInlineParseService } from "@jevcode/evidence-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  README_BLURB_MAX_CHARS,
  createFsBriefSources,
  exportCandidates,
  exportedNames,
  firstReadmeParagraph,
} from "./explainer-narration-sources.js";

let repo = "";

beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), "jevcode-n3-sources-"));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function put(relative: string, content: string): void {
  mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
  writeFileSync(path.join(repo, relative), content);
}

function component(rootPath: string, overrides: Partial<Component> = {}): Component {
  return {
    id: "cmp_000000000001",
    rootPath,
    name: path.basename(rootPath),
    fileCount: 1,
    files: [`${rootPath}/src/index.ts`],
    language: "TypeScript",
    roleGuess: "domain",
    role: "domain",
    purpose: null,
    provenance: "rule",
    contentHash: "0".repeat(40),
    externalDeps: [],
    entryPoints: [`${rootPath}/src/index.ts`],
    importsAnalyzed: true,
    ...overrides,
  };
}

const noParse = { parseFile: async (): Promise<SymbolInfo[]> => [] };

describe("firstReadmeParagraph", () => {
  it.each([
    ["# Title\n\nFirst line\nsecond line.\n\nNext paragraph.", "First line second line."],
    ["---\ntitle: x\n---\n# T\n[![ci](b.svg)](l)\n![logo](l.png)\n<p align=center>x</p>\n\nReal text here.", "Real text here."],
    ["<!-- hidden\ncomment -->\n```sh\nnpm i\n```\n\n> quote\n- item\n| a | b |\n\nPlain paragraph.", "Plain paragraph."],
    ["# Only headings\n## And more", null],
    ["", null],
  ])("%j → %j", (markdown, expected) => {
    expect(firstReadmeParagraph(markdown)).toBe(expected);
  });
});

describe("createFsBriefSources.blurb", () => {
  it("prefers the package.json description, redacted", async () => {
    put("packages/vault/package.json", JSON.stringify({ name: "vault", description: "Token vault. key=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }));
    put("packages/vault/README.md", "# Vault\n\nREADME text that should not win.");
    const blurb = await createFsBriefSources({ repoRoot: repo, parse: noParse }).blurb(component("packages/vault"));
    expect(blurb).not.toContain("sk-ant-api03-");
    expect(blurb).toContain("[REDACTED:");
    expect(blurb?.startsWith("Token vault.")).toBe(true);
  });

  it("falls back to the first README paragraph, redacted before it is clipped to 600 characters", async () => {
    put("packages/notes/package.json", JSON.stringify({ name: "notes" }));
    put(
      "packages/notes/README.md",
      `# Notes\n\n[![ci](x)](y)\n\nStores notes. Bearer abcdefghijklmnopqrstuvwxyz0123 ${"lorem ".repeat(200)}\n\nSecond paragraph.`,
    );
    const blurb = await createFsBriefSources({ repoRoot: repo, parse: noParse }).blurb(component("packages/notes"));
    expect(blurb?.startsWith("Stores notes. Bearer [REDACTED:bearer]")).toBe(true);
    expect(Array.from(blurb ?? "").length).toBe(README_BLURB_MAX_CHARS);
    expect(blurb).not.toContain("Second paragraph");
  });

  it("ignores a symlinked README and a root path that escapes the repo", async () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), "jevcode-n3-outside-"));
    writeFileSync(path.join(outside, "secret.md"), "Outside secret paragraph.");
    mkdirSync(path.join(repo, "packages/linked"), { recursive: true });
    symlinkSync(path.join(outside, "secret.md"), path.join(repo, "packages/linked/README.md"));
    const sources = createFsBriefSources({ repoRoot: repo, parse: noParse });
    expect(await sources.blurb(component("packages/linked"))).toBeNull();
    expect(await sources.blurb(component("../" + path.basename(outside)))).toBeNull();
    rmSync(outside, { recursive: true, force: true });
  });

  it("reads the repo-root README for a flat repo", async () => {
    put("README.md", "# Flat\n\nA flat repository.");
    const blurb = await createFsBriefSources({ repoRoot: repo, parse: noParse }).blurb(component("."));
    expect(blurb).toBe("A flat repository.");
  });
});

describe("createFsBriefSources.exports", () => {
  it("returns exported identifiers from entry points only, without default or re-export specifiers", async () => {
    put(
      "packages/vault/src/index.ts",
      "export function openVault() { return 'BODY_MARKER_7f3a'; }\nexport const LIMIT = 3;\nexport default openVault;\nexport * from './other.js';\n",
    );
    put("packages/vault/src/other.ts", "export const notAnEntry = 1;\n");
    const parse = createInlineParseService();
    const spy = vi.spyOn(parse, "parseFile");
    const names = await createFsBriefSources({ repoRoot: repo, parse }).exports(
      component("packages/vault", { files: ["packages/vault/src/index.ts", "packages/vault/src/other.ts"] }),
    );
    expect(names).toEqual(["openVault", "LIMIT"]);
    expect(spy.mock.calls.map((call) => call[0])).toEqual(["packages/vault/src/index.ts"]);
    await parse.dispose();
  });

  it("skips files over 256 KiB and caps the list at 15 names", async () => {
    put("packages/big/src/index.ts", `export const huge = "${"x".repeat(300 * 1024)}";\n`);
    put("packages/many/src/index.ts", Array.from({ length: 20 }, (_, index) => `export const n${index} = ${index};`).join("\n"));
    const parse = createInlineParseService();
    const sources = createFsBriefSources({ repoRoot: repo, parse });
    expect(await sources.exports(component("packages/big"))).toEqual([]);
    expect(await sources.exports(component("packages/many"))).toHaveLength(15);
    expect(await createFsBriefSources({ repoRoot: repo }).exports(component("packages/many"))).toEqual([]);
    await parse.dispose();
  });

  it("counts declarations on an export line as exported (the parser names `export const` symbols \"default\")", () => {
    const sym = (name: string, kind: SymbolInfo["kind"], line: number): SymbolInfo => ({
      name,
      kind,
      signature: "",
      startLine: line,
      endLine: line,
    });
    expect(
      exportedNames([
        sym("openVault", "function", 1),
        sym("openVault", "export", 1),
        sym("LIMIT", "variable", 2),
        sym("default", "export", 2),
        sym("x", "import", 2),
        sym("hidden", "variable", 3),
        sym("export", "export", 4),
        sym("./other.js", "export", 5),
      ]),
    ).toEqual(["openVault", "LIMIT"]);
  });

  it("falls back to shallow index files when a component has no entry points", () => {
    const candidates = exportCandidates(
      component("packages/x", {
        entryPoints: [],
        files: ["packages/x/src/deep/index.ts", "packages/x/src/index.ts", "packages/x/src/util.ts", "packages/x/data.json"],
      }),
    );
    expect(candidates).toEqual(["packages/x/src/index.ts", "packages/x/src/deep/index.ts"]);
  });
});
