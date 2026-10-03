import path from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Pins the core purity ban in eslint.config.mjs (spec §4.2). The probe files never exist on
// disk: ESLint lints the code as if it lived at filePath, so the path decides which blocks apply.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

let eslint: ESLint | undefined;

async function ruleIds(filePath: string, code: string): Promise<string[]> {
  eslint ??= new ESLint({ cwd: REPO_ROOT });
  const [result] = await eslint.lintText(code, { filePath: path.join(REPO_ROOT, filePath) });
  if (result === undefined) throw new Error(`ESLint returned no result for ${filePath}`);
  return result.messages.map((message) => message.ruleId ?? `fatal: ${message.message}`);
}

const CASES: { filePath: string; code: string; expected: string[] }[] = [
  {
    filePath: "packages/codebase-map/src/core/probe.ts",
    code: 'import { readFileSync } from "node:fs"; export const x = readFileSync;',
    expected: ["no-restricted-imports"],
  },
  {
    filePath: "packages/codebase-map/src/core/probe.ts",
    code: 'import path from "path"; export const x = path;',
    expected: ["no-restricted-imports"],
  },
  {
    filePath: "packages/codebase-map/src/core/probe.ts",
    code: 'import { scanRepo } from "../node/scan.js"; export const x = scanRepo;',
    expected: ["no-restricted-imports"],
  },
  {
    filePath: "packages/codebase-map/src/core/probe.ts",
    code: 'export const x = () => Buffer.from("a");',
    expected: ["no-restricted-globals"],
  },
  {
    filePath: "packages/codebase-map/src/core/probe.ts",
    code: 'export const x = () => import("node:fs");',
    expected: ["no-restricted-syntax"],
  },
  {
    filePath: "packages/codebase-map/src/core/probe.test.ts",
    code: 'import { readFileSync } from "node:fs"; export const x = readFileSync;',
    expected: [],
  },
  {
    filePath: "packages/codebase-map/src/node/probe.ts",
    code: 'import { readFileSync } from "node:fs"; export const x = readFileSync;',
    expected: [],
  },
];

describe("codebase-map core purity (spec §4.2)", () => {
  it.each(CASES)("$filePath: $code", async ({ filePath, code, expected }) => {
    expect(await ruleIds(filePath, code)).toEqual(expected);
  });
});
