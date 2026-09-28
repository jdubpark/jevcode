import path from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Pins the import bans in eslint.config.mjs (R7). The probe files never exist on disk:
// ESLint lints the code as if it lived at filePath, so the path decides which blocks apply.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

let eslint: ESLint | undefined;

async function ruleIds(filePath: string, code: string): Promise<string[]> {
  eslint ??= new ESLint({ cwd: REPO_ROOT });
  const [result] = await eslint.lintText(code, { filePath: path.join(REPO_ROOT, filePath) });
  if (result === undefined) throw new Error(`ESLint returned no result for ${filePath}`);
  return result.messages.map((message) => message.ruleId ?? `fatal: ${message.message}`);
}

interface BoundaryCase {
  filePath: string;
  code: string;
  expected: string[];
}

const CASES: BoundaryCase[] = [
  {
    filePath: "packages/trace-viewer/src/model/probe.ts",
    code: 'import { readFileSync } from "node:fs"; export const x = readFileSync;',
    expected: ["no-restricted-imports"],
  },
  {
    filePath: "packages/trace-viewer/src/model/probe.ts",
    code: 'import { useState } from "react"; export const x = useState;',
    expected: ["no-restricted-imports"],
  },
  {
    filePath: "packages/trace-viewer/src/model/probe.ts",
    code: 'import { Shell } from "../ui/Shell.js"; export const x = Shell;',
    expected: ["no-restricted-imports"],
  },
  {
    filePath: "packages/trace-viewer/src/model/probe.ts",
    code: 'import { buildTimeScale } from "../layout/time-scale.js"; export const x = buildTimeScale;',
    expected: ["no-restricted-imports"],
  },
  {
    filePath: "packages/trace-viewer/src/model/probe.ts",
    code: 'export const x = () => fetch("/x");',
    expected: ["no-restricted-globals"],
  },
  {
    filePath: "packages/trace-viewer/src/model/probe.ts",
    code: 'export const x = Buffer.byteLength("a");',
    expected: ["no-restricted-globals"],
  },
  {
    filePath: "packages/trace-viewer/src/model/probe.test.ts",
    code: 'import { readFileSync } from "node:fs"; export const x = readFileSync;',
    expected: [],
  },
  {
    filePath: "packages/trace-viewer/src/layout/probe.ts",
    code: 'import { useState } from "react"; export const x = useState;',
    expected: ["no-restricted-imports"],
  },
  {
    filePath: "packages/trace-viewer/src/layout/probe.ts",
    code: 'import { Shell } from "../ui/shell/Shell.js"; export const x = Shell;',
    expected: ["no-restricted-imports"],
  },
  {
    filePath: "packages/trace-viewer/src/layout/probe.ts",
    code: "export const x = () => document.body;",
    expected: ["no-restricted-globals"],
  },
  {
    filePath: "packages/trace-viewer/src/layout/probe.ts",
    code: "export const x = () => Date.now();",
    expected: ["no-restricted-globals"],
  },
  {
    filePath: "packages/trace-viewer/src/layout/probe.ts",
    code: 'import { LANES } from "../model/index.js"; export const x = LANES;',
    expected: [],
  },
  {
    filePath: "packages/trace-viewer/src/layout/probe.test.ts",
    code: "export const x = () => document.body;",
    expected: [],
  },
  {
    filePath: "packages/trace-viewer/src/ui/probe.tsx",
    code: 'import { useState } from "react"; export const x = useState;',
    expected: [],
  },
  {
    filePath: "packages/trace-viewer/src/ui/probe.tsx",
    code: 'import { registry } from "@jevcode/ui-catalog"; export const x = registry;',
    expected: ["no-restricted-imports"],
  },
  {
    filePath: "packages/trace-viewer/src/ui/probe.tsx",
    code: 'import { openDb } from "@jevcode/storage"; export const x = openDb;',
    expected: ["no-restricted-imports"],
  },
  {
    filePath: "packages/contracts/src/probe.ts",
    code: 'import { createHash } from "node:crypto"; export const x = createHash;',
    expected: ["no-restricted-imports"],
  },
  {
    filePath: "packages/contracts/src/node.ts",
    code: 'import { createHash } from "node:crypto"; export const x = createHash;',
    expected: [],
  },
];

describe("lint boundaries (eslint.config.mjs)", () => {
  it.each(CASES)(
    "$filePath: $code",
    async ({ filePath, code, expected }) => {
      expect(await ruleIds(filePath, code)).toEqual(expected);
    },
    30_000,
  );
});
