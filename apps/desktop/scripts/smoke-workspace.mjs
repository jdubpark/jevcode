#!/usr/bin/env node
// Electron workspace smoke (plan lane 03, D-2 and D-6). Needs a built app
// (pnpm -r build) and the Electron ABI (pnpm --filter jevcode-desktop run rebuild).
// Usage: node apps/desktop/scripts/smoke-workspace.mjs [shotsDir]
// Wrap it in an outer alarm longer than KILL_AFTER_MS (260 s): `perl -e 'alarm 300; exec @ARGV' node ...`.
// The script spawns the Electron binary itself in its own process group and kills the group on timeout, SIGINT,
// SIGTERM and SIGALRM; the temp dir goes only after the child has exited.
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(APP, "../..");
const shots = path.resolve(process.argv[2] ?? path.join(REPO_ROOT, ".superpowers", "shots"));
// Past the in-app workspace timeout (smoke.ts SMOKE_WORKSPACE_TIMEOUT_MS, 240 s), so the app reports its own failure first.
const KILL_AFTER_MS = Number(process.env.JEVCODE_SMOKE_KILL_MS ?? 260_000);

const tmp = mkdtempSync(path.join(os.tmpdir(), "jevcode-ws-smoke-"));
const repo = path.join(tmp, "repo");
mkdirSync(repo);
writeFileSync(path.join(repo, "README.md"), "# smoke\n");
const git = (...args) => execFileSync("git", ["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", ...args], { cwd: repo });
git("init", "-q", "-b", "main");
git("add", "README.md");
git("commit", "-q", "-m", "init");
mkdirSync(shots, { recursive: true });

// require("electron") is the binary's path. node_modules/.bin/electron is a shim whose cli.js forwards only SIGINT and
// SIGTERM, so a SIGKILL to the shim would orphan the real process.
const electron = createRequire(import.meta.url)("electron");
const child = spawn(electron, ["."], {
  cwd: APP,
  detached: true,
  env: {
    ...process.env,
    // Empty, not deleted: main's .env loader never overrides a variable that is already set, so an empty key stays empty.
    ANTHROPIC_API_KEY: "",
    JEVCODE_SMOKE: "1",
    JEVCODE_SMOKE_WORKSPACE: "1",
    JEVCODE_SMOKE_REPO: repo,
    JEVCODE_SMOKE_SHOTS: shots,
    // 80 steps = 321 agent events and 160 evidence facts, 150 ms apart: enough append samples for a p95 (docs/perf.md, >= 300).
    JEVCODE_SMOKE_STEPS: process.env.JEVCODE_SMOKE_STEPS ?? "80",
    JEVCODE_DB: path.join(tmp, "smoke.db"),
    JEVC_AGENT: "mock",
    JEVC_JEV_CLIENT: "degrade",
    // The narrator stays off: no billed model calls, no nondeterministic snapshot rows during the latency sample.
    JEVCODE_NARRATOR: "off",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
let exited = false;
child.stdout.on("data", (chunk) => {
  out += chunk;
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

/** Kills the child's whole process group (Electron's helpers included). */
function killGroup(signal) {
  if (exited || child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group is already gone.
  }
}
const killer = setTimeout(() => {
  console.error(`WORKSPACE_SMOKE_FAIL killed after ${KILL_AFTER_MS / 1000}s`);
  killGroup("SIGKILL");
}, KILL_AFTER_MS);
let signalled = null;
for (const signal of ["SIGINT", "SIGTERM", "SIGALRM"]) {
  process.on(signal, () => {
    signalled = signal;
    console.error(`WORKSPACE_SMOKE_FAIL ${signal}`);
    killGroup("SIGKILL");
    // The exit handler below cleans up; a child that is already gone still ends the run.
    if (exited) process.exit(1);
  });
}
child.on("error", (error) => {
  console.error(`WORKSPACE_SMOKE_FAIL spawn: ${error.message}`);
  clearTimeout(killer);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
});
child.on("exit", (code) => {
  clearTimeout(killer);
  // Before exited is set: killGroup is a no-op once it is, and helpers can outlive the main process.
  killGroup("SIGKILL");
  exited = true;
  rmSync(tmp, { recursive: true, force: true });
  const ok = signalled === null && code === 0 && /^SMOKE_OK$/m.test(out);
  console.log(ok ? "WORKSPACE_SMOKE_PASS" : `WORKSPACE_SMOKE_FAIL exit=${code}${signalled === null ? "" : ` signal=${signalled}`}`);
  process.exit(ok ? 0 : 1);
});
