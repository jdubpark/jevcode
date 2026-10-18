import { mkdir, open, readFile, realpath, rename, rm, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { BriefSchema, referencedEvidence, REMOVAL_NOTE, type Brief } from "./report.js";
import { contextFingerprint, type RepoContext } from "./collect.js";
import { clean, hash, readSource } from "./io.js";

const CheckpointSchema = z.object({
  version: z.literal(1), repo: z.string(), generatedAt: z.string(), fingerprint: z.string(), head: z.string().nullable(),
  fileHashes: z.record(z.string()), brief: BriefSchema,
  evidence: z.array(z.object({ source: z.string(), line: z.number().int().positive(), path: z.string().nullable(), text: z.string() })).default([]),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;
const statePath = (directory: string, repo: string): string => path.join(directory, `${hash(repo)}.json`);
const snapshotPath = (directory: string, repo: string): string => path.join(directory, `${hash(repo)}.snapshot.json`);
const SnapshotSchema = z.object({ head: z.string().nullable(), files: z.record(z.string()) });
export type Snapshot = z.infer<typeof SnapshotSchema>;

/**
 * Redacted content of the files that differed from the base when the brief was written, so the refresh
 * gate can show what changed since. Kept in the state directory; nothing is written to the checkout.
 */
export async function saveSnapshot(directory: string, context: RepoContext): Promise<void> {
  const files: Record<string, string> = {};
  let total = 0;
  for (const file of context.changed) {
    const text = await readSource(context.repo, file);
    if (text === null) continue;
    const cleaned = clean(text);
    if (total + cleaned.length > 1_500_000) break;
    files[file] = cleaned;
    total += cleaned.length;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = snapshotPath(directory, context.repo);
  const temporary = `${target}.${process.pid}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try { await handle.writeFile(JSON.stringify({ head: context.head, files })); } finally { await handle.close(); }
  await rename(temporary, target).finally(() => rm(temporary, { force: true }));
}

export async function readSnapshot(directory: string, repo: string): Promise<Snapshot | null> {
  try { const parsed = SnapshotSchema.safeParse(JSON.parse(await readFile(snapshotPath(directory, repo), "utf8"))); return parsed.success ? parsed.data : null; }
  catch { return null; }
}

/** The latest rendered brief, for humans and `jevcode show`. */
export const renderedPath = (directory: string, repo: string): string => path.join(directory, `${hash(repo)}.md`);

/** Resolve existing parent aliases without creating directories in the inspected checkout. */
export async function resolveStateDirectory(directory: string, repo: string): Promise<string> {
  let parent = path.resolve(directory);
  const missing: string[] = [];
  for (;;) {
    try { parent = await realpath(parent); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === path.dirname(parent)) throw error;
      missing.unshift(path.basename(parent));
      parent = path.dirname(parent);
    }
  }
  const resolved = path.join(parent, ...missing);
  if (resolved === repo || resolved.startsWith(repo + path.sep)) throw new Error("Checkpoint directory must be outside the target repository; use --no-state to disable persistence.");
  return resolved;
}

export async function readCheckpoint(directory: string, repo: string): Promise<Checkpoint | null> {
  try {
    const raw = await readFile(statePath(directory, repo), "utf8");
    const parsed = CheckpointSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.repo !== repo) throw new Error("Invalid checkpoint");
    return parsed.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("The previous briefing checkpoint is unreadable. Use --no-state for an independent brief.");
  }
}

export function previousContext(previous: Checkpoint | null, context: RepoContext): unknown {
  if (previous === null) return null;
  const changed = Object.entries(context.files).filter(([file, info]) => previous.fileHashes[file] !== info.hash).map(([file]) => file);
  const removed = Object.keys(previous.fileHashes).filter((file) => context.files[file] === undefined);
  return {
    generatedAt: previous.generatedAt, head: previous.head,
    note: "This was generated, not reviewed or approved. File differences compare source hashes, not an exact previous working-tree patch. Current patches still use the explicit base/HEAD.",
    changedSinceBrief: changed.slice(0, 250), removedSinceBrief: removed.slice(0, 250),
    omittedPaths: Math.max(0, changed.length - 250) + Math.max(0, removed.length - 250),
    summary: previous.brief.summary, review: previous.brief.review, unknowns: previous.brief.unknowns.filter((entry) => !REMOVAL_NOTE.test(entry)),
  };
}

/**
 * The lock is held only while a checkpoint is written (milliseconds), so one older than two minutes was
 * left by a crash; unattended runs reclaim it instead of failing forever.
 */
async function openLock(file: string): Promise<FileHandle> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await open(file, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await stat(file).catch(() => null);
      if (attempt === 0 && info && Date.now() - info.mtimeMs > 120_000) { await rm(file, { force: true }); continue; }
      if (attempt === 0 && !info) continue;
      break;
    }
  }
  throw new Error("Another briefing is saving this repository's checkpoint. The current brief was not checkpointed.");
}

/** Atomic, per-worktree state; concurrent or older runs cannot overwrite a newer checkpoint. */
export async function saveCheckpoint(directory: string, context: RepoContext, brief: Brief, rendered?: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = statePath(directory, context.repo);
  const lock = await openLock(target + ".lock");
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    const previous = await readCheckpoint(directory, context.repo);
    if (previous && previous.generatedAt > context.generatedAt) return;
    const checkpoint: Checkpoint = {
      version: 1, repo: context.repo, generatedAt: context.generatedAt, fingerprint: contextFingerprint(context), head: context.head,
      fileHashes: Object.fromEntries(Object.entries(context.files).map(([file, info]) => [file, info.hash])), brief, evidence: referencedEvidence(brief, context),
    };
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(checkpoint)); } finally { await file.close(); }
    await rename(temporary, target);
    if (rendered !== undefined) {
      const markdown = await open(temporary, "wx", 0o600);
      try { await markdown.writeFile(rendered); } finally { await markdown.close(); }
      await rename(temporary, renderedPath(directory, context.repo));
    }
  } finally {
    await lock.close();
    await rm(target + ".lock", { force: true });
    await rm(temporary, { force: true });
  }
}
