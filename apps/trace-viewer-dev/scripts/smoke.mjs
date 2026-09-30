#!/usr/bin/env node
// Visual smoke for the trace viewer dev host (design spec §11 "Visual smoke").
// Runs outside `pnpm -r test`; needs Google Chrome (CHROME_PATH overrides the default path).
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(APP, "../..");
const PORT = 4179;
const ORIGIN = `http://localhost:${PORT}`;
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WIDTHS = [1440, 1000];
const SMOKE_DIR = path.join(APP, ".smoke");

function parseArgs(argv) {
  const options = { views: ["hybrid"], skipBuild: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--skip-build") options.skipBuild = true;
    else if (arg === "--views") {
      options.views = String(argv[i + 1] ?? "")
        .split(",")
        .filter((view) => view !== "");
      i += 1;
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (options.views.length === 0) throw new Error("--views needs hybrid, canvas or both");
  for (const view of options.views) {
    if (view !== "hybrid" && view !== "canvas") throw new Error(`unknown view ${view}`);
  }
  return options;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: REPO, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
}

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const retry = () => {
      if (Date.now() > deadline) reject(new Error(`vite preview did not answer at ${url}`));
      else setTimeout(attempt, 250);
    };
    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode === 200) resolve();
        else retry();
      });
      request.on("error", retry);
    };
    attempt();
  });
}

function chrome(profile, args) {
  const result = spawnSync(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profile}`,
      ...args,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 90_000 },
  );
  if (result.status !== 0) throw new Error(`chrome exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

function locationHash(sessionId, view) {
  return `#${encodeURIComponent(JSON.stringify({ v: 1, sessionId, view, level: "chapter", brush: { kind: "session" } }))}`;
}

function decodeHtml(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function readSelftest(html) {
  const match = /<pre id="selftest"[^>]*>([\s\S]*?)<\/pre>/.exec(html);
  if (match === null || match[1].trim() === "") throw new Error("the selftest wrote no result");
  return JSON.parse(decodeHtml(match[1]));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}; set CHROME_PATH`);
  if (!options.skipBuild) run("pnpm", ["-r", "build"]);
  const tmp = mkdtempSync(path.join(os.tmpdir(), "tv-smoke-"));
  const profile = path.join(tmp, "chrome-profile");
  let preview;
  try {
    run("pnpm", ["--filter", "jevcode-desktop", "replay", path.join(REPO, "fixtures", "oauth"), path.join(tmp, "oauth")]);
    const bundles = path.join(APP, "public", "bundles");
    mkdirSync(bundles, { recursive: true });
    copyFileSync(path.join(tmp, "oauth", "trace.json"), path.join(bundles, "oauth.json"));
    const sessionId = JSON.parse(readFileSync(path.join(bundles, "oauth.json"), "utf8")).session.sessionId;
    run("pnpm", ["--filter", "jevcode-trace-viewer-dev", "build"]);
    preview = spawn(
      "pnpm",
      ["--filter", "jevcode-trace-viewer-dev", "exec", "vite", "preview", "--port", String(PORT), "--strictPort"],
      { cwd: REPO, stdio: "ignore", detached: true },
    );
    await waitForServer(`${ORIGIN}/`, 30_000);
    mkdirSync(SMOKE_DIR, { recursive: true });
    let shots = 0;
    for (const view of options.views) {
      for (const width of WIDTHS) {
        const file = path.join(SMOKE_DIR, `${view}-${width}.png`);
        rmSync(file, { force: true });
        chrome(profile, [
          `--window-size=${width},900`,
          "--virtual-time-budget=3000",
          `--screenshot=${file}`,
          `${ORIGIN}/?bundle=oauth${locationHash(sessionId, view)}`,
        ]);
        if (!existsSync(file)) throw new Error(`no screenshot at ${file}`);
        shots += 1;
      }
      if (view === "hybrid") {
        // Spec §1 "found at once": oauth opened in Hybrid at 1440 px with no input (?selftest=open).
        const opened = readSelftest(
          chrome(profile, [
            "--window-size=1440,900",
            "--dump-dom",
            "--virtual-time-budget=5000",
            `${ORIGIN}/?bundle=oauth&selftest=open${locationHash(sessionId, view)}`,
          ]),
        );
        const misses = [];
        if (opened.claimStepId === null) misses.push("no claim row in the bundle");
        if (opened.selected !== opened.claimStepId) {
          misses.push(`selected ${JSON.stringify(opened.selected)}, claim step ${JSON.stringify(opened.claimStepId)}`);
        }
        if (opened.claimRowInSpine !== true) misses.push("the claim row lies outside the spine viewport");
        if (opened.claimPinInOverview !== true) misses.push("the claim pin lies outside the overview viewport");
        if (typeof opened.paintedAtMs !== "number" || opened.paintedAtMs > 5000) {
          misses.push(`tv:initial-selection-painted startTime ${JSON.stringify(opened.paintedAtMs)}`);
        }
        if (misses.length > 0) throw new Error(`hybrid open: ${misses.join("; ")}`);
        console.log(
          `hybrid: opened with ${opened.selected} selected and in view, painted at ${Math.round(opened.paintedAtMs)} ms`,
        );
      }
      const html = chrome(profile, [
        "--window-size=1440,900",
        "--dump-dom",
        "--virtual-time-budget=5000",
        `${ORIGIN}/?bundle=oauth&selftest=drip${locationHash(sessionId, view)}`,
      ]);
      const result = readSelftest(html);
      const problems = [];
      if (result.ready !== true) problems.push("not ready");
      if (result.selectedTitle !== "Claim contradicts tests") problems.push(`selected ${JSON.stringify(result.selectedTitle)}`);
      if (result.errors.length !== 0) problems.push(`errors ${JSON.stringify(result.errors)}`);
      if (result.cspViolations.length !== 0) problems.push(`csp ${JSON.stringify(result.cspViolations)}`);
      if (!(result.maxDriftPx <= 1)) problems.push(`drift ${result.maxDriftPx}px`);
      if (problems.length > 0) throw new Error(`${view} selftest: ${problems.join("; ")}`);
      console.log(`${view}: selftest ok (rows ${result.rows}, max drift ${result.maxDriftPx}px)`);
    }
    console.log(`SMOKE_OK ${shots} screenshots`);
  } finally {
    if (preview?.pid !== undefined) {
      try {
        process.kill(-preview.pid, "SIGTERM");
      } catch {
        // The preview server already exited.
      }
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`SMOKE_FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
