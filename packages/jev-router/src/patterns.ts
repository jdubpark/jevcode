// Destructive-command classification lives in @jevcode/contracts (single
// authoritative copy, SPEC 8.3.1). Re-exported here so jev-router call sites
// and downstream consumers of this package keep a stable import path.
export {
  classifyDestructive,
  destructivePatterns,
  isDestructiveCommand,
  matchDestructive,
} from "@jevcode/contracts";

export const SECURITY_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)auth\//i,
  /(^|\/)session\//i,
  /token/i,
  /oauth/i,
  /(^|\/)\.env($|\.)/i,
  /permissions?/i,
  /access[_-]?control/i,
];

export function isSecurityPath(path: string): boolean {
  return SECURITY_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

export const SCHEMA_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)migrations?\//i,
  /(^|\/)prisma\//i,
  /schema\.sql$/i,
  /\.prisma$/i,
];

export function isSchemaPath(path: string): boolean {
  return SCHEMA_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

export const TEST_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)tests?\//i,
  /(^|\/)__tests__\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
];

export function isTestPath(path: string): boolean {
  return TEST_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

export function isTestOnly(files: readonly string[]): boolean {
  return files.length > 0 && files.every((file) => isTestPath(file));
}
