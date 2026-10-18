import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

const writer = z.object({ model: z.string().min(1), variant: z.string().min(1).optional() }).strict();
export const AutoConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Checkout path prefixes, or "*" for every Git checkout. Exclusions win. */
  include: z.array(z.string()).default(["*"]),
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

export function repoEnabled(config: AutoConfig, repo: string): boolean {
  if (!config.enabled || config.exclude.some((prefix) => within(repo, prefix))) return false;
  return config.include.some((prefix) => prefix === "*" || within(repo, prefix));
}
