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
const DEFAULT_PORT = 4179;
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WIDTHS = [1440, 1000];
const SMOKE_DIR = path.join(APP, ".smoke");

function parseArgs(argv) {
  const options = { views: ["hybrid"], skipBuild: false, port: DEFAULT_PORT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--skip-build") options.skipBuild = true;
    else if (arg === "--port") {
      // Parallel worktrees each serve the preview on their own port.
      options.port = Number(argv[i + 1]);
      i += 1;
      if (!Number.isInteger(options.port) || options.port <= 0) throw new Error("--port needs a port number");
    }
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

/** Chrome children (by pid, with their profile dir) that this run started and has not yet killed. */
const liveChrome = new Map();

/** Kills a Chrome we started: its process group, then any stray helper that still carries the profile dir. */
function killChrome(child, profile) {
  liveChrome.delete(child);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  // `--` keeps the pattern from being parsed as an option; the full profile path is unique to this run.
  spawnSync("pkill", ["-9", "-f", "--", `--user-data-dir=${profile}`]);
}

function killAllChrome() {
  for (const [child, profile] of [...liveChrome]) killChrome(child, profile);
}
process.on("exit", killAllChrome);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    killAllChrome();
    process.exit(1);
  });
}

/**
 * One headless Chrome call. Chrome 154 does all of its work (writes the screenshot, prints the DOM) and then never
 * exits, so `spawnSync` always ran into its timeout. Run it asynchronously, treat the call as complete once its own
 * completion marker shows (`... bytes written to file` on stderr for `--screenshot`, the closing `</html>` on stdout
 * for `--dump-dom`), then kill the process tree. A fresh profile per call keeps a killed Chrome's lock files out.
 */
function chrome(profile, args) {
  rmSync(profile, { recursive: true, force: true });
  const wantsDom = args.includes("--dump-dom");
  return new Promise((resolve, reject) => {
    const child = spawn(
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
      { stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    liveChrome.set(child, profile);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killChrome(child, profile);
      if (error) reject(error);
      else resolve(stdout);
    };
    const check = () => {
      if (wantsDom ? /<\/html>\s*$/i.test(stdout) : /bytes written to file/.test(stderr)) finish();
    };
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      check();
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
      check();
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => finish(code === 0 ? undefined : new Error(`chrome exited ${code}: ${stderr}`)));
    const timer = setTimeout(() => finish(new Error(`chrome gave no result within 90 s: ${stderr.slice(-2048)}`)), 90_000);
  });
}

/**
 * Real-time run over the DevTools protocol (spec §11 allows it when virtual time is flaky): opens `url`, polls
 * `<pre id="selftest">` until it holds text, returns it parsed. The view-switch selftest needs it: under
 * `--virtual-time-budget` its paint wait (rAF, then a MessageChannel post) stalls after the third switch.
 */
async function chromeSelftest(profile, url, timeoutMs) {
  rmSync(profile, { recursive: true, force: true });
  const browser = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profile}`,
      "--window-size=1440,900",
      "--remote-debugging-port=0",
      url,
    ],
    { stdio: "ignore", detached: true },
  );
  liveChrome.set(browser, profile);
  const deadline = Date.now() + timeoutMs;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let socket;
  try {
    const portFile = path.join(profile, "DevToolsActivePort");
    while (!existsSync(portFile)) {
      if (Date.now() > deadline) throw new Error("chrome wrote no DevToolsActivePort");
      await sleep(100);
    }
    const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((target) => target.type === "page");
    if (page === undefined) throw new Error("chrome has no page target");
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error("DevTools socket failed"));
    });
    const replies = new Map();
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      replies.get(message.id)?.(message);
      replies.delete(message.id);
    };
    let id = 0;
    const evaluate = (expression) =>
      new Promise((resolve) => {
        id += 1;
        replies.set(id, (message) => resolve(message.result?.result?.value));
        socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
      });
    for (;;) {
      const text = await evaluate('document.querySelector("pre#selftest")?.textContent ?? ""');
      if (typeof text === "string" && text.trim() !== "") return JSON.parse(text);
      if (Date.now() > deadline) throw new Error("the selftest wrote no result");
      await sleep(250);
    }
  } finally {
    socket?.close();
    killChrome(browser, profile);
  }
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
  const ORIGIN = `http://localhost:${options.port}`;
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
      ["--filter", "jevcode-trace-viewer-dev", "exec", "vite", "preview", "--port", String(options.port), "--strictPort"],
      { cwd: REPO, stdio: "ignore", detached: true },
    );
    await waitForServer(`${ORIGIN}/`, 30_000);
    mkdirSync(SMOKE_DIR, { recursive: true });
    let shots = 0;
    for (const view of options.views) {
      for (const width of WIDTHS) {
        const file = path.join(SMOKE_DIR, `${view}-${width}.png`);
        rmSync(file, { force: true });
        await chrome(profile, [
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
          await chrome(profile, [
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
      const html = await chrome(profile, [
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
    if (options.views.includes("canvas")) {
      // C3-12 (spec §10 "View switch"): 20 presses of 1/2 must restore the Canvas camera in the switch's frame.
      const switchResult = await chromeSelftest(
        path.join(tmp, "chrome-switch"),
        `${ORIGIN}/?bundle=oauth&selftest=switch${locationHash(sessionId, "canvas")}`,
        60_000,
      );
      if (switchResult.switches !== 20 || switchResult.misses !== 0) {
        throw new Error(
          `view switch missed ${switchResult.misses} of ${switchResult.switches}: ${switchResult.details.join("; ")}`,
        );
      }
      console.log(`view switch: ${switchResult.switches} switches, 0 misses`);
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
