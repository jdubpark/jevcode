import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BRIEF_JSON_SCHEMA } from "./report.js";

export interface RunnerOptions {
  repo: string;
  prompt: string;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
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
    await new Promise<void>((resolve, reject) => {
      // Strip inherited Git redirection and nested execution markers. Preserve provider authentication.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") && !["CODEX_THREAD_ID", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"].includes(key)));
      const child = spawn("codex", args, { cwd: options.repo, env, stdio: ["pipe", "ignore", "pipe"], detached: process.platform !== "win32" });
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
        else if (exitCode !== 0) reject(new Error(`Codex exited with code ${String(exitCode)}. Check codex login status and CLI compatibility; no checkpoint was saved.`));
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
      const timer = setTimeout(() => stop("Briefing timed out; no successful checkpoint was saved."), options.timeoutMs ?? 300_000);
      const abort = () => stop("Briefing cancelled; no successful checkpoint was saved.");
      options.signal?.addEventListener("abort", abort, { once: true });
      // Drain diagnostics without replaying private agent logs into the human-facing output.
      child.stderr.on("data", () => {});
      child.stdin.on("error", () => {});
      child.on("error", () => { reason = "Could not start Codex. Install the Codex CLI and run codex login, or export the prompt for another agent."; });
      child.on("close", (code) => {
        closed = true;
        exitCode = code;
        finish();
      });
      child.stdin.end(options.prompt);
      if (options.signal?.aborted) abort();
    });
    const raw = await readFile(output, "utf8");
    if (raw.length > 100_000) throw new Error("Codex returned an oversized brief.");
    try { return JSON.parse(raw) as unknown; } catch { throw new Error("Codex did not return a complete structured brief; no checkpoint was saved."); }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
