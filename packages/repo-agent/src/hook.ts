import { spawn } from "node:child_process";
import { lstat, mkdir, open, stat, truncate } from "node:fs/promises";
import path from "node:path";
import { NESTED_ENV } from "./io.js";

export type HookKind = "claude" | "codex";
export interface HookTarget { cwd: string; transcript: string | null; session: string | null }

const text = (value: unknown): string | null => typeof value === "string" && value.trim() !== "" ? value : null;

/** Claude Code Stop and Codex Stop payloads both carry the session's cwd, id and transcript path. */
export function parseHookPayload(raw: string, fallbackCwd: string): HookTarget {
  let data: Record<string, unknown> = {};
  try { const parsed: unknown = JSON.parse(raw); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>; }
  catch { /* An unreadable payload still names the working directory through the hook's cwd. */ }
  const cwd = text(data.cwd) ?? fallbackCwd;
  const transcript = text(data.transcript_path);
  return {
    cwd: path.isAbsolute(cwd) ? cwd : fallbackCwd,
    transcript: transcript && path.isAbsolute(transcript) ? transcript : null,
    session: text(data.session_id) ?? text(data.thread_id),
  };
}

/**
 * Returns immediately: the brief runs in a detached child so an agent's stop is never delayed.
 * Output goes to auto.log in the state directory, never to the agent's terminal.
 */
export async function launchFromHook(raw: string, cli: string, stateDir: string): Promise<void> {
  if (process.env[NESTED_ENV]) return;
  const target = parseHookPayload(raw, process.cwd());
  const transcript = target.transcript && await lstat(target.transcript).then((info) => info.isFile(), () => false) ? target.transcript : null;
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const logFile = path.join(stateDir, "auto.log");
  if (((await stat(logFile).catch(() => null))?.size ?? 0) > 1024 * 1024) await truncate(logFile, 0);
  const log = await open(logFile, "a", 0o600);
  try {
    const args = [cli, "auto", "--repo", target.cwd, "--trigger", "hook", "--state-dir", stateDir, ...(transcript ? ["--log", transcript] : []), ...(target.session ? ["--session", target.session] : [])];
    const child = spawn(process.execPath, args, { cwd: target.cwd, detached: true, stdio: ["ignore", log.fd, log.fd], env: process.env });
    child.unref();
  } finally {
    await log.close();
  }
}
