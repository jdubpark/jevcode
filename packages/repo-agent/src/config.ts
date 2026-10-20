import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
const writer = z.object({ model: z.string().min(1), variant: z.string().min(1).optional() }).strict();
export const AutoConfigSchema = z.object({
  enabled: z.boolean().default(true),
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
  const decoded: unknown = JSON.parse(raw);
  // `include` and `exclude` were per-repository opt-in rules. Ignore them in existing
  // config files while keeping strict validation for current settings.
  if (decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)) {
    delete (decoded as Record<string, unknown>).include;
    delete (decoded as Record<string, unknown>).exclude;
  }
  const parsed = AutoConfigSchema.safeParse(decoded);
  if (!parsed.success) throw new Error(`Invalid Jevcode auto configuration in ${file}.`);
  return parsed.data;
}

export async function saveConfig(config: AutoConfig, file = configPath()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(AutoConfigSchema.parse(config), null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, file);
}
