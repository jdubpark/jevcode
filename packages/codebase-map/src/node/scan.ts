import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { buildManifest, tsconfigFromTexts } from "../core/manifest.js";
import { compareText, isSkippedPath, languageOf, normalizePath } from "../core/paths.js";
import type { ScannedFile, TsconfigPaths, WorkspaceManifest } from "../core/types.js";

const execFileAsync = promisify(execFile);

/** Spec §5.1: hard cap on mapped files; past it the map is partial. */
export const MAX_SCAN_FILES = 20_000;
/** Spec §5.1: larger files are skipped. */
export const MAX_FILE_BYTES = 1024 * 1024;
const READ_CONCURRENCY = 32;
const PROGRESS_EVERY = 200;
const SNIFF_BYTES = 8_000;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const PATHSPEC_CHUNK = 500;
const LFS_POINTER_HEADER = "version https://git-lfs.github.com/spec/v1";

export interface ScanOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  signal?: AbortSignal;
  onProgress?(done: number, total: number): void;
  /** Called once per kept file with its UTF-8 text; the scan awaits it inside its read pool. */
  visit?(file: ScannedFile, source: string): Promise<void> | void;
}

export interface ScanResult {
  files: ScannedFile[];
  manifest: WorkspaceManifest;
  partial: boolean;
  tsconfig: TsconfigPaths;
  /** Ruling R3: repo files that pass the path skips, before the cap; `files.length` when not partial. */
  totalFiles: number;
}

export interface ScanPathsResult {
  /** Changed files that exist and pass every skip rule, sorted. */
  files: ScannedFile[];
  /** Normalized paths that are deleted, ignored, skipped or unreadable, sorted. */
  gone: string[];
}

interface ReadResult {
  file: ScannedFile;
  buffer: Buffer;
}

function isManifestText(rel: string): boolean {
  return rel === "pnpm-workspace.yaml" || rel === "package.json" || rel.endsWith("/package.json") || /^tsconfig[^/]*\.json$/.test(rel);
}

export function looksBinary(buffer: Uint8Array): boolean {
  const end = Math.min(buffer.length, SNIFF_BYTES);
  for (let i = 0; i < end; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

export function isLfsPointer(buffer: Buffer): boolean {
  return buffer.length < 1024 && buffer.subarray(0, LFS_POINTER_HEADER.length).toString("utf8") === LFS_POINTER_HEADER;
}

async function readCandidate(repoRoot: string, rel: string, maxBytes: number): Promise<ReadResult | null> {
  const abs = path.join(repoRoot, rel);
  try {
    // lstat: a symlink is never followed, so a link out of the repo is never read.
    const info = await lstat(abs);
    if (!info.isFile() || info.size > maxBytes) return null;
    const buffer = await readFile(abs);
    if (buffer.length > maxBytes || looksBinary(buffer) || isLfsPointer(buffer)) return null;
    return {
      file: { path: rel, hash: createHash("sha1").update(buffer).digest("hex"), size: buffer.length, language: languageOf(rel) },
      buffer,
    };
  } catch {
    return null;
  }
}

async function gitListFiles(repoRoot: string, pathspecs: readonly string[], signal?: AbortSignal): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", repoRoot, "ls-files", "-z", "--cached", "--others", "--exclude-standard", ...(pathspecs.length > 0 ? ["--", ...pathspecs] : [])],
    { maxBuffer: GIT_MAX_BUFFER, signal, encoding: "utf8" },
  );
  return stdout.split("\0").filter((entry) => entry !== "");
}

/** Tracked files plus untracked files that .gitignore does not exclude, sorted and unique. */
export async function listRepoFiles(repoRoot: string, signal?: AbortSignal): Promise<string[]> {
  return [...new Set(await gitListFiles(repoRoot, [], signal))].sort(compareText);
}

async function readAll(
  repoRoot: string,
  rels: readonly string[],
  options: Pick<ScanOptions, "maxFileBytes" | "signal" | "onProgress">,
  onFile: (result: ReadResult | null, rel: string) => Promise<void>,
): Promise<void> {
  const maxBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      options.signal?.throwIfAborted();
      const index = next;
      next += 1;
      if (index >= rels.length) return;
      const rel = rels[index] as string;
      await onFile(await readCandidate(repoRoot, rel, maxBytes), rel);
      done += 1;
      if (done % PROGRESS_EVERY === 0 || done === rels.length) options.onProgress?.(done, rels.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(READ_CONCURRENCY, rels.length)) }, worker));
}

/** Spec §5.1: git ls-files, skips, the 20,000-file cap, workspace manifest and root tsconfig paths. */
export async function scanRepo(repoRoot: string, options: ScanOptions = {}): Promise<ScanResult> {
  const maxFiles = options.maxFiles ?? MAX_SCAN_FILES;
  const candidates = (await listRepoFiles(repoRoot, options.signal)).filter((rel) => !isSkippedPath(rel));
  const partial = candidates.length > maxFiles;
  const selected = partial ? candidates.slice(0, maxFiles) : candidates;
  const files: ScannedFile[] = [];
  const texts = new Map<string, string>();
  options.onProgress?.(0, selected.length);
  await readAll(repoRoot, selected, options, async (result) => {
    if (result === null) return;
    files.push(result.file);
    const manifestText = isManifestText(result.file.path);
    if (!manifestText && options.visit === undefined) return;
    const source = result.buffer.toString("utf8");
    if (manifestText) texts.set(result.file.path, source);
    await options.visit?.(result.file, source);
  });
  options.signal?.throwIfAborted();
  files.sort((a, b) => compareText(a.path, b.path));
  return {
    files,
    manifest: buildManifest(files.map((file) => file.path), texts),
    partial,
    tsconfig: tsconfigFromTexts(texts),
    totalFiles: partial ? candidates.length : files.length,
  };
}

/**
 * Re-reads changed paths after the first scan (spec §5.1 incremental updates). Paths that
 * leave the repo root are dropped; deleted, gitignored, skipped or unreadable paths are `gone`.
 */
export async function scanPaths(
  repoRoot: string,
  paths: readonly string[],
  options: Pick<ScanOptions, "maxFileBytes" | "signal" | "visit"> = {},
): Promise<ScanPathsResult> {
  const rels = [
    ...new Set(paths.map((entry) => normalizePath(entry.replaceAll("\\", "/"))).filter((entry): entry is string => entry !== null && entry !== "")),
  ].sort(compareText);
  const gone: string[] = [];
  const eligible = rels.filter((rel) => {
    if (!isSkippedPath(rel)) return true;
    gone.push(rel);
    return false;
  });
  const listed = new Set<string>();
  for (let i = 0; i < eligible.length; i += PATHSPEC_CHUNK) {
    const chunk = eligible.slice(i, i + PATHSPEC_CHUNK).map((rel) => `:(literal)${rel}`);
    for (const rel of await gitListFiles(repoRoot, chunk, options.signal)) listed.add(rel);
  }
  const files: ScannedFile[] = [];
  const readable = eligible.filter((rel) => {
    if (listed.has(rel)) return true;
    gone.push(rel);
    return false;
  });
  await readAll(repoRoot, readable, options, async (result, rel) => {
    if (result === null) {
      gone.push(rel);
      return;
    }
    files.push(result.file);
    await options.visit?.(result.file, result.buffer.toString("utf8"));
  });
  files.sort((a, b) => compareText(a.path, b.path));
  return { files, gone: gone.sort(compareText) };
}
