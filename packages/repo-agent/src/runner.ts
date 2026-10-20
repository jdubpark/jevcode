import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Writer, WriterUsage } from "./brief.js";
import type { AutoConfig } from "./config.js";
import { NESTED_ENV } from "./io.js";
import { BRIEF_JSON_SCHEMA } from "./report.js";

export interface RunnerOptions {
  repo: string;
  prompt: string;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface ProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onStdout?: (chunk: Buffer) => void;
  exitMessage: (code: number | null) => string;
  missingMessage: string;
}

/** Strip inherited Git redirection and nested execution markers. Preserve provider authentication. */
function childEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") && !["CODEX_THREAD_ID", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"].includes(key)));
  return { ...env, [NESTED_ENV]: "1", ...extra };
}

/** Runs one provider process in its own group; cancellation and timeout terminate every descendant. */
function runProcess(options: ProcessOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: ["pipe", options.onStdout ? "pipe" : "ignore", "pipe"], detached: process.platform !== "win32" });
    let reason: string | null = null;
    let killed: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let exitCode: number | null = null;
    let escalated = false;
    const finish = () => {
      if (!closed || (killed && !escalated)) return;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (reason) reject(new Error(reason));
      else if (exitCode !== 0) reject(new Error(options.exitMessage(exitCode)));
      else resolve();
    };
    const stop = (message: string) => {
      if (reason) return;
      reason = message;
      const kill = (signal: NodeJS.Signals) => {
        try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already exited */ }
      };
      kill("SIGTERM");
      // A leader can close its pipes while a descendant ignores TERM. Always finish
      // group escalation before reporting cancellation, even after leader exit.
      killed = setTimeout(() => { kill("SIGKILL"); escalated = true; finish(); }, 2_000);
    };
    const timer = setTimeout(() => stop("Briefing timed out; no successful checkpoint was saved."), options.timeoutMs);
    const abort = () => stop("Briefing cancelled; no successful checkpoint was saved.");
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.onStdout) child.stdout?.on("data", options.onStdout);
    // Drain diagnostics without replaying private agent logs into the human-facing output.
    child.stderr?.on("data", () => {});
    child.stdin?.on("error", () => {});
    child.on("error", () => { reason = options.missingMessage; });
    child.on("close", (code) => {
      closed = true;
      exitCode = code;
      finish();
    });
    child.stdin?.end(options.input);
    if (options.signal?.aborted) abort();
  });
}

/** Uses installed/authenticated Codex with integrations, hooks and delegation disabled. */
export async function runCodex(options: RunnerOptions): Promise<unknown> {
  const temporary = await mkdtemp(path.join(tmpdir(), "jevcode-brief-"));
  try {
    const schema = path.join(temporary, "schema.json");
    const output = path.join(temporary, "report.json");
    await writeFile(schema, JSON.stringify(BRIEF_JSON_SCHEMA), { mode: 0o600 });
    const args = ["exec", "--ignore-user-config", "--ephemeral", "--sandbox", "read-only", "--color", "never", "--json", "--cd", options.repo, "--output-schema", schema, "--output-last-message", output,
      "-c", "approval_policy=\"never\"", "-c", "web_search=\"disabled\"", "-c", "mcp_servers={}",
      "-c", "features.shell_snapshot=false", "-c", "shell_environment_policy.inherit=\"core\"",
      "--disable", "apps", "--disable", "hooks", "--disable", "multi_agent", "--disable", "in_app_browser",
      "--disable", "in_app_local_automation", "--disable", "skill_mcp_dependency_install"];
    if (options.model) args.push("--model", options.model);
    args.push("-");
    await runProcess({
      command: "codex", args, cwd: options.repo, env: childEnvironment(), input: options.prompt, timeoutMs: options.timeoutMs ?? 300_000, signal: options.signal,
      exitMessage: (code) => `Codex exited with code ${String(code)}. Check codex login status and CLI compatibility; no checkpoint was saved.`,
      missingMessage: "Could not start Codex. Install the Codex CLI and run codex login, or export the prompt for another agent.",
    });
    const raw = await readFile(output, "utf8");
    if (raw.length > 100_000) throw new Error("Codex returned an oversized brief.");
    try { return JSON.parse(raw) as unknown; } catch { throw new Error("Codex did not return a complete structured brief; no checkpoint was saved."); }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const OPENCODE_AGENT = "jevcode-brief";
// Read rules mirror evidence-engine's isSecretPath basenames. OpenCode matches wildcards against the
// path ("*" crosses "/") and the last matching rule wins, so the denials follow the allow.
const SECRET_NAMES = [".env", ".env*", "*.pem", "*.key", "id_rsa*", "id_ed25519*", "id_ecdsa*", "id_dsa*", "*.p12", "*.pfx", "*.jks", "*.keystore", ".npmrc", ".netrc", ".pgpass", ".pypirc", "credentials"];
const PUBLIC_KEYS = ["id_ed25519*.pub", "id_ecdsa*.pub", "id_dsa*.pub"];
export const READ_RULES: Record<string, "allow" | "deny"> = Object.fromEntries([
  ["*", "allow"],
  ...SECRET_NAMES.flatMap((name) => [[name, "deny"], [name.startsWith("*") ? name : `*/${name}`, "deny"]]),
  ...PUBLIC_KEYS.flatMap((name) => [[name, "allow"], [`*/${name}`, "allow"]]),
]);
// Deny everything (including MCP tools), then allow path-checked reads and name-only glob. grep is denied:
// it is permission-checked against the search pattern, not the file, and searches hidden files.
const READ_ONLY = { "*": "deny", read: READ_RULES, glob: "allow", external_directory: "deny", doom_loop: "deny" };
/** The only configuration the writer sees. Denied tools are not offered to the model at all. */
export const OPENCODE_CONFIG = {
  $schema: "https://opencode.ai/config.json",
  autoupdate: false, share: "disabled", snapshot: false, mcp: {},
  default_agent: OPENCODE_AGENT,
  permission: READ_ONLY,
  agent: {
    [OPENCODE_AGENT]: { description: "Read-only repository briefing agent", mode: "primary", steps: 50, permission: READ_ONLY },
    build: { disable: true }, plan: { disable: true }, general: { disable: true }, explore: { disable: true },
  },
};

/**
 * OPENCODE_CONFIG_CONTENT alone merges over the user's global and project config, so global MCP
 * servers, plugins and instructions would still load. A private XDG config home and session
 * database, plus the disable flags, leave only the supplied config. Provider credentials live
 * under XDG_DATA_HOME, which is kept.
 */
export function openCodeEnvironment(directory: string): Record<string, string> {
  return {
    XDG_CONFIG_HOME: path.join(directory, "config"), OPENCODE_DB: path.join(directory, "sessions.db"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(OPENCODE_CONFIG), OPENCODE_PURE: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  };
}

interface OpenCodeTokens { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
interface OpenCodeEvent { type?: string; part?: { type?: string; text?: string; tokens?: OpenCodeTokens }; error?: unknown }

/** The last text part is the answer (earlier ones can be preamble); step-finish parts carry token counts. */
export function parseOpenCodeEvents(stdout: string): { text: string; usage: WriterUsage | null; error: string | null } {
  let text = "";
  const totals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  let measured = false;
  let validUsage = true;
  let error: string | null = null;
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let event: OpenCodeEvent;
    try { event = JSON.parse(line) as OpenCodeEvent; } catch { continue; }
    if (event.type === "text" && typeof event.part?.text === "string") text = event.part.text;
    if (event.type === "step_finish" && event.part?.tokens) {
      const tokens = event.part.tokens;
      const values = [tokens.input, tokens.output, tokens.reasoning, tokens.cache?.read, tokens.cache?.write];
      if (values.some((value) => value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0))) validUsage = false;
      totals.input += tokens.input ?? 0;
      totals.output += tokens.output ?? 0;
      totals.reasoning += tokens.reasoning ?? 0;
      totals.cacheRead += tokens.cache?.read ?? 0;
      totals.cacheWrite += tokens.cache?.write ?? 0;
      measured = true;
    }
    // Provider messages can echo submitted content; keep only the error class.
    if (event.type === "error") error = `OpenCode reported ${typeof event.error === "object" && event.error !== null && typeof (event.error as { name?: unknown }).name === "string" ? (event.error as { name: string }).name.replace(/[^\w]/g, "") : "a provider error"}`;
  }
  return { text, usage: measured && validUsage && Object.values(totals).every((value) => Number.isFinite(value) && value >= 0) ? totals : null, error };
}

/** An answer that is not one parseable JSON object; the writer gets one chance to correct it. */
export class WriterFormatError extends Error {
  usage: WriterUsage | null = null;
  constructor(message: string, readonly answer: string) { super(message); this.name = "WriterFormatError"; }
}

/** Models without a structured-output option may wrap JSON in prose or a fence. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!candidate.trim()) throw new WriterFormatError("The writer did not return a structured brief; no checkpoint was saved.", text.slice(0, 20_000));
  try { return JSON.parse(candidate) as unknown; }
  catch { throw new WriterFormatError("The writer did not return a complete structured brief; no checkpoint was saved.", text.slice(0, 20_000)); }
}

export interface OpenCodeOptions extends RunnerOptions { model: string; variant?: string }

/** Muse Spark and DeepSeek run through OpenCode with only the supplied read-only agent config. */
export async function runOpenCode(options: OpenCodeOptions): Promise<{ value: unknown; usage: WriterUsage | null }> {
  const temporary = await mkdtemp(path.join(tmpdir(), "jevcode-opencode-"));
  try {
    const args = ["run", "--pure", "--format", "json", "--model", options.model, "--agent", OPENCODE_AGENT, "--dir", options.repo];
    if (options.variant) args.push("--variant", options.variant);
    // run appends piped stdin to the message, so the full assignment never touches argv or disk.
    args.push("--", "Carry out the assignment below for this repository. Return only the final JSON report.");
    const chunks: Buffer[] = [];
    let bytes = 0;
    await runProcess({
      command: "opencode", args, cwd: options.repo, input: options.prompt, timeoutMs: options.timeoutMs ?? 600_000, signal: options.signal,
      env: childEnvironment(openCodeEnvironment(temporary)),
      onStdout: (chunk) => { bytes += chunk.length; if (bytes <= 32 * 1024 * 1024) chunks.push(chunk); },
      exitMessage: (code) => `OpenCode exited with code ${String(code)} for ${options.model}. Check opencode auth and the model name; no checkpoint was saved.`,
      missingMessage: "Could not start OpenCode. Install the OpenCode CLI and authenticate the provider, or use --runner codex.",
    });
    const events = parseOpenCodeEvents(Buffer.concat(chunks).toString("utf8"));
    if (!events.text) throw new Error(`${events.error ?? "OpenCode returned no answer"} for ${options.model}; no checkpoint was saved.`);
    if (events.text.length > 100_000) throw new Error("The writer returned an oversized brief.");
    try { return { value: extractJson(events.text), usage: events.usage }; }
    catch (error) { if (error instanceof WriterFormatError) error.usage = events.usage; throw error; }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export type RunnerName = "muse" | "deepseek" | "codex";

export function openCodeWriter(id: string, model: string, variant?: string): Writer {
  return { id, model, run: (prompt, options) => runOpenCode({ prompt, model, variant, ...options }) };
}

export function codexWriter(model?: string): Writer {
  return { id: "codex", model: model ?? null, run: async (prompt, options) => ({ value: await runCodex({ prompt, model, ...options }), usage: null }) };
}

/** muse: the configured writer, then the configured fallback. deepseek and codex run alone. */
export function writersFor(runner: RunnerName, config: AutoConfig, model?: string, variant?: string): Writer[] {
  if (runner === "codex") return [codexWriter(model)];
  if (runner === "deepseek") return [openCodeWriter("deepseek", model ?? config.fallback?.model ?? "deepseek/deepseek-flash", variant ?? config.fallback?.variant ?? "high")];
  const primary = openCodeWriter("muse", model ?? config.writer.model, variant ?? config.writer.variant);
  return config.fallback ? [primary, openCodeWriter("deepseek", config.fallback.model, variant ?? config.fallback.variant)] : [primary];
}
