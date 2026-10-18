import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { git } from "./io.js";

const writer = z.object({ model: z.string().min(1), variant: z.string().min(1).optional() }).strict();
export const AutoConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /**
   * Opt-in rules; exclusions win. A rule is a checkout path prefix, "*" for every Git checkout, or
   * "root:<sha>" for every clone and worktree whose history starts at that root commit.
   */
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  writer: writer.default({ model: "meta/muse-spark-1.3-contributor", variant: "high" }),
  fallback: writer.nullable().default({ model: "deepseek/deepseek-flash", variant: "high" }),
  /** "merge-base" compares with the upstream default branch; "head" covers uncommitted work only; otherwise a revision. */
  base: z.string().default("merge-base"),
  timeoutSeconds: z.number().int().min(30).max(1800).default(600),
}).strict();
export type AutoConfig = z.infer<typeof AutoConfigSchema>;

export const configPath = (env: NodeJS.ProcessEnv = process.env): string =>
  path.join(env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "jevcode", "auto.json");

export const defaultStateDirectory = (): string => path.join(homedir(), ".local", "state", "jevcode", "repo-agent");

export async function loadConfig(file = configPath()): Promise<AutoConfig> {
  let raw: string;
  try { raw = await readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return AutoConfigSchema.parse({});
    throw error;
  }
  const parsed = AutoConfigSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`Invalid Jevcode auto configuration in ${file}.`);
  return parsed.data;
}

const within = (repo: string, prefix: string): boolean => {
  const resolved = path.resolve(prefix.replace(/^~(?=$|\/)/, homedir()));
  return repo === resolved || repo.startsWith(resolved + path.sep);
};

/**
 * Root commits identify a repository across clones, worktrees and moves; an unborn checkout has none.
 * "all" reads every ref, so a repository whose history was rewritten keeps both lineages.
 */
export async function repositoryRoots(repo: string, scope: "head" | "all" = "head"): Promise<string[]> {
  return (await git(repo, ["rev-list", "--max-parents=0", scope === "all" ? "--all" : "HEAD"]).catch(() => "")).split("\n").filter(Boolean);
}

const matches = (rule: string, repo: string, roots: string[]): boolean =>
  rule === "*" || (rule.startsWith("root:") ? roots.includes(rule.slice(5)) : within(repo, rule));

/** Root commits are read only when a root rule needs them. */
export async function repoEnabled(config: AutoConfig, repo: string): Promise<boolean> {
  if (!config.enabled) return false;
  const roots = [...config.include, ...config.exclude].some((rule) => rule.startsWith("root:")) ? await repositoryRoots(repo) : [];
  if (config.exclude.some((rule) => matches(rule, repo, roots))) return false;
  return config.include.some((rule) => matches(rule, repo, roots));
}

/**
 * Opt a checkout in or out by repository identity (its root commits), so every clone and worktree follows;
 * an unborn checkout falls back to its path. Returns the updated configuration.
 */
export async function setOptIn(config: AutoConfig, repo: string, on: boolean): Promise<AutoConfig> {
  const roots = await repositoryRoots(repo, "all");
  const rules = roots.length ? roots.map((root) => `root:${root}`) : [repo];
  // Only rules naming this repository; "*" and parent-path rules stay and are overridden by an exclusion.
  const mine = (entry: string) => entry.startsWith("root:") ? roots.includes(entry.slice(5)) : entry !== "*" && path.resolve(entry.replace(/^~(?=$|\/)/, homedir())) === repo;
  const next = { ...config, include: config.include.filter((entry) => !mine(entry)), exclude: config.exclude.filter((entry) => !mine(entry)) };
  if (on) next.include.push(...rules);
  else if (await repoEnabled(next, repo)) next.exclude.push(...rules);
  return next;
}

export async function saveConfig(config: AutoConfig, file = configPath()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(AutoConfigSchema.parse(config), null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, file);
}
