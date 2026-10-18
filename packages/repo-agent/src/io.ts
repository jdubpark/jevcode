import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isSkippedPath, normalizePath } from "@jevcode/codebase-map";
import { isSecretPath, redactText } from "@jevcode/evidence-engine/redactor";

const exec = promisify(execFile);
/** Set in every writer process so a hook fired inside a briefing run cannot start another one. */
export const NESTED_ENV = "JEVCODE_BRIEFING";
export const hash = (text: string | Buffer): string => createHash("sha1").update(text).digest("hex");
// eslint-disable-next-line no-control-regex -- Strip terminal control and bidi characters from untrusted evidence.
export const clean = (text: string): string => redactText(text).text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "");
/** Redact values before JSON encoding so a replacement cannot consume JSON delimiters. */
export function cleanData(value: unknown): unknown {
  if (typeof value === "string") return clean(value);
  if (Array.isArray(value)) return value.map(cleanData);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cleanData(item)]));
  return value;
}
export const eligible = (file: string): boolean => normalizePath(file) === file && !isSkippedPath(file) && !isSecretPath(file);

/** No shell, external diff driver, textconv, fsmonitor, or inherited Git redirection. */
export async function git(root: string, args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  try {
    return (await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-C", root, ...args], {
      encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 30_000, env,
    })).stdout;
  } catch {
    throw new Error(`Git could not complete ${args[0] ?? "the request"}. Check the repository and revision.`);
  }
}

/** Reject symlinks, including symlinked parents, escapes, binaries and secret paths. */
export async function readSource(root: string, file: string): Promise<string | null> {
  if (!eligible(file)) return null;
  try {
    const absolute = path.join(root, file);
    const actual = await realpath(absolute);
    if (actual !== absolute || !actual.startsWith(root + path.sep)) return null;
    const info = await lstat(actual);
    if (!info.isFile() || info.size > 1024 * 1024) return null;
    const bytes = await readFile(actual);
    if (bytes.length > 1024 * 1024 || bytes.includes(0)) return null;
    return bytes.toString("utf8");
  } catch {
    return null;
  }
}
