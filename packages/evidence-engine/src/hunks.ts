export interface FileCounts {
  added: number;
  removed: number;
}

export interface DiffHunk {
  addedLines: string[];
  removedLines: string[];
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

export function parseNumstat(output: string): Map<string, FileCounts> {
  const counts = new Map<string, FileCounts>();
  for (const rawLine of output.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const line = rawLine.trimEnd();
    const tab1 = line.indexOf("\t");
    const tab2 = tab1 === -1 ? -1 : line.indexOf("\t", tab1 + 1);
    if (tab1 === -1 || tab2 === -1) continue;
    const addedRaw = line.slice(0, tab1);
    const removedRaw = line.slice(tab1 + 1, tab2);
    const file = line.slice(tab2 + 1);
    if (!file) continue;
    if (addedRaw === "-" || removedRaw === "-") {
      counts.set(file, { added: 0, removed: 0 });
      continue;
    }
    counts.set(file, {
      added: Number.parseInt(addedRaw, 10) || 0,
      removed: Number.parseInt(removedRaw, 10) || 0,
    });
  }
  return counts;
}

export function parseDiffHunks(diffText: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  for (const line of diffText.split(/\r?\n/)) {
    if (HUNK_HEADER.test(line)) {
      current = { addedLines: [], removedLines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("\\")) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) {
      current.addedLines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      current.removedLines.push(line.slice(1));
    }
  }
  return hunks;
}

function normalizeForFormattingComparison(line: string): string {
  return line.replace(/\s+/g, "");
}

export function isWhitespaceOnlyHunk(hunk: DiffHunk): boolean {
  if (hunk.addedLines.length === 0 || hunk.removedLines.length === 0) {
    return false;
  }
  const added = hunk.addedLines
    .map(normalizeForFormattingComparison)
    .filter((l) => l.length > 0)
    .sort();
  const removed = hunk.removedLines
    .map(normalizeForFormattingComparison)
    .filter((l) => l.length > 0)
    .sort();
  if (added.length === 0 || removed.length === 0) return false;
  if (added.length !== removed.length) return false;
  return added.every((value, i) => value === removed[i]);
}

export function isFormattingOnlyDiff(diffText: string): boolean {
  if (!diffText.trim()) return false;
  if (/Binary files .* differ/.test(diffText) || /GIT binary patch/.test(diffText)) {
    return false;
  }
  const hunks = parseDiffHunks(diffText);
  if (hunks.length === 0) return false;
  return hunks.every(isWhitespaceOnlyHunk);
}

const CONFIG_BASENAMES = [
  ".editorconfig",
  ".eslintignore",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.mjs",
  ".eslintrc.json",
  ".eslintrc.yaml",
  ".eslintrc.yml",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  ".prettierignore",
  "package.json",
];

const CONFIG_BASENAME_PREFIXES = [".prettierrc", ".npmrc", ".babelrc"];
const CONFIG_BASENAME_SUFFIXES = [".toml", ".yaml", ".yml", ".ini"];

export function isConfigPath(filePath: string): boolean {
  const base = filePath.replace(/\\/g, "/").split("/").at(-1) ?? filePath;
  if (CONFIG_BASENAMES.includes(base)) return true;
  if (CONFIG_BASENAME_PREFIXES.some((prefix) => base.startsWith(prefix))) return true;
  if (/^tsconfig(?:\..+)?\.json$/.test(base)) return true;
  if (/^.+\.config\.(js|cjs|mjs|ts|mts|cts|json)$/.test(base)) return true;
  const dotIndex = base.lastIndexOf(".");
  if (dotIndex > 0) {
    const ext = base.slice(dotIndex);
    if (CONFIG_BASENAME_SUFFIXES.includes(ext)) {
      const stem = base.slice(0, dotIndex);
      if (CONFIG_BASENAME_PREFIXES.some((prefix) => stem.startsWith(prefix))) return true;
    }
  }
  return false;
}

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "npm-shrinkwrap.json",
]);

export function isLockfilePath(filePath: string): boolean {
  const base = filePath.replace(/\\/g, "/").split("/").at(-1) ?? filePath;
  return LOCKFILE_NAMES.has(base) || base.endsWith(".lock");
}

export const KNOWN_LOCKFILE_NAMES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"];

export function isKnownLockfileName(filePath: string): boolean {
  const base = filePath.replace(/\\/g, "/").split("/").at(-1) ?? filePath;
  return KNOWN_LOCKFILE_NAMES.includes(base);
}
