import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { collectRepository } from "./collect.js";
import { readActivity } from "./activity.js";
import { renderBrief, validateBrief, type Brief } from "./report.js";
import { readCheckpoint, saveCheckpoint, previousContext, resolveStateDirectory } from "./state.js";
import { isSecretPath } from "@jevcode/evidence-engine/redactor";
import { OPENCODE_CONFIG, READ_RULES, runCodex, runOpenCode } from "./runner.js";

const exec = promisify(execFile);
const temporary: string[] = [];
const originalPath = process.env.PATH;
afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "jevcode-repo-test-"));
  temporary.push(root);
  for (const dir of ["src/api", "src/auth", "src/data"]) await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, "src/api/index.ts"), 'import { allowed } from "../auth/policy.js";\nexport const handler = allowed;\n');
  await writeFile(path.join(root, "src/auth/policy.ts"), 'export const allowed = () => false;\n');
  await writeFile(path.join(root, "src/data/store.py"), 'def save(record):\n    return record\n');
  await writeFile(path.join(root, "README.md"), '# Example\n\nAPI requests go through the authorization policy before storage.\n');
  await exec("git", ["init", "-q", root]);
  await exec("git", ["-C", root, "add", "."]);
  await exec("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "baseline"]);
  return realpath(root);
}

function report(): Brief {
  return {
    summary: "The API delegates access decisions to a shared policy.",
    architecture: [{ text: "The API imports the authorization policy.", citations: [{ source: "src/api/index.ts", line: 1 }] }],
    review: [{ priority: "high", area: "Authorization", why: "This policy controls access through the API.", question: "Does the policy deny unauthenticated callers?", citations: [{ source: "src/auth/policy.ts", line: 1 }] }],
    changes: [], checks: [], guidance: [], unknowns: ["Runtime behavior has not been tested."], diagrams: [],
  };
}

describe("repository briefing boundary", () => {
  it("accepts bounded scoped activity over stdin without writing transcripts into the checkout", async () => {
    const root = await fixture();
    const before = (await exec("git", ["-C", root, "status", "--porcelain=v1"])).stdout;
    const cli = new URL("../dist/cli.js", import.meta.url).pathname;
    const command = exec(process.execPath, [cli, "context", "--repo", root, "--activity-stdin"]);
    command.child.stdin!.end([
      JSON.stringify({ role: "user", text: "Review the authorization boundary." }),
      JSON.stringify({ role: "assistant", text: "The agent reports that checks passed." }),
      JSON.stringify({ type: "reasoning", text: "private reasoning" }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", channel: "analysis", content: [{ type: "output_text", text: "private analysis" }] } }),
      JSON.stringify({ type: "unknown_event", text: "unsupported event" }),
    ].join("\n"));
    const context = JSON.parse((await command).stdout);
    expect(context.activity[0].records).toHaveLength(2);
    expect(context.activity[0].records[1].text).toContain("agent reports");
    expect(context.activity[0].omitted).toBe(3);
    expect(JSON.stringify(context)).not.toContain("private reasoning");
    expect(JSON.stringify(context)).not.toContain("private analysis");
    expect(JSON.stringify(context)).not.toContain("unsupported event");
    expect(context.limitations.join(" ")).not.toContain("No agent activity supplied");
    expect((await exec("git", ["-C", root, "status", "--porcelain=v1"])).stdout).toBe(before);
    const oversized = exec(process.execPath, [cli, "context", "--repo", root, "--activity-stdin"]);
    oversized.child.stdin!.on("error", () => {});
    oversized.child.stdin!.end("x".repeat(8 * 1024 * 1024 + 1));
    await expect(oversized).rejects.toMatchObject({ stdout: "", stderr: expect.stringContaining("Activity input exceeds 8 MiB") });
  });

  it("maps cross-component imports and includes staged, unstaged, untracked and deleted changes without modifying the target", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "src/auth/policy.ts"), 'export const allowed = (user: string) => user !== "";\n');
    await exec("git", ["-C", root, "add", "src/auth/policy.ts"]);
    await writeFile(path.join(root, "README.md"), "# Updated example\n");
    await writeFile(path.join(root, "src/api/a file.ts"), 'export const version = 2;\n');
    await rm(path.join(root, "src/data/store.py"));
    await writeFile(path.join(root, ".env"), "PASSWORD=do-not-include\n");
    const before = (await exec("git", ["-C", root, "status", "--porcelain=v1"])).stdout;
    const context = await collectRepository({ repo: path.join(root, "src"), focus: ["src/auth"] });
    expect(context.repo).toBe(root);
    expect(context.changed).toEqual(["README.md", "src/api/a file.ts", "src/auth/policy.ts", "src/data/store.py"]);
    const api = context.components.find((entry) => entry.path === "src/api")!;
    const auth = context.components.find((entry) => entry.path === "src/auth")!;
    expect(context.edges).toContainEqual(expect.objectContaining({ from: api.id, to: auth.id, count: 1 }));
    expect(auth.incoming).toBe(1);
    expect(context.patches[0]?.path).toBe("src/auth/policy.ts");
    expect(context.patches.find((entry) => entry.path === "src/data/store.py")?.text).toContain("-def save(record)");
    expect(JSON.stringify(context)).not.toContain("do-not-include");
    expect(context.limitations.join(" ")).toContain("JavaScript/TypeScript only");
    expect((await exec("git", ["-C", root, "status", "--porcelain=v1"])).stdout).toBe(before);
  });

  it("handles an unborn repository and refuses secret/symlink citations and invalid base revisions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "jevcode-unborn-"));
    temporary.push(root);
    await exec("git", ["init", "-q", root]);
    await writeFile(path.join(root, "main.py"), "print('hello')\n");
    await writeFile(path.join(root, ".env"), "PASSWORD=secret\n");
    await symlink(path.join(root, ".env"), path.join(root, "innocent.py"));
    await mkdir(path.join(root, "linked"));
    await writeFile(path.join(root, "linked/source.py"), "print('original')\n");
    await exec("git", ["-C", root, "add", "linked/source.py"]);
    await rm(path.join(root, "linked"), { recursive: true });
    const outside = await mkdtemp(path.join(tmpdir(), "jevcode-outside-"));
    temporary.push(outside);
    await writeFile(path.join(outside, "source.py"), "print('outside')\n");
    await symlink(outside, path.join(root, "linked"));
    const context = await collectRepository({ repo: root });
    expect(context.head).toBeNull();
    expect(context.patches.find((entry) => entry.path === "main.py")?.text).toContain("print('hello')");
    expect(context.files["innocent.py"]).toBeUndefined();
    expect(context.files["linked/source.py"]).toBeUndefined();
    const allowed = { ...report(), architecture: [{ text: "The program prints a greeting.", citations: [{ source: "main.py", line: 1 }] }], review: [] };
    await expect(validateBrief(allowed, context)).resolves.toMatchObject({ architecture: allowed.architecture });
    await expect(collectRepository({ repo: root, base: "--help" })).rejects.toThrow("revision");
    const invalid = report();
    invalid.architecture[0]!.citations = [{ source: "innocent.py", line: 1 }];
    await expect(validateBrief(invalid, context)).rejects.toThrow("unavailable source");
  });

  it("reduces repeated activity, retains early failures and later results, and redacts before clipping", async () => {
    const root = await fixture();
    const log = path.join(root, "activity.jsonl");
    const lines = [
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "test", exit_code: 1, aggregated_output: "authorization test failed" } }),
      ...Array.from({ length: 100 }, () => JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Inspecting source" } })),
      JSON.stringify({ type: "response_item", payload: { type: "reasoning", text: "private reasoning omitted" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Claim: fixed; token=do-not-publish" }] } }),
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "test", exit_code: 0, aggregated_output: "1 passed" } }),
    ];
    await writeFile(log, lines.join("\n"));
    const result = await readActivity(log, "activity:1");
    expect(result.records).toHaveLength(4);
    expect(result.records[0]).toMatchObject({ line: 1, text: expect.stringContaining("exit: 1") });
    expect(result.records[1]?.occurrences).toBe(100);
    expect(result.records.at(-1)).toMatchObject({ line: 104, text: expect.stringContaining("exit: 0") });
    expect(JSON.stringify(result)).not.toMatch(/do-not-publish|private reasoning/);
    await writeFile(log, '-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----\n{"type":"reasoning","text":"incomplete');
    const malformed = await readActivity(log, "activity:1");
    expect(malformed.records).toEqual([]);
    expect(malformed.omitted).toBe(4);
  });

  it("validates real source lines, rejects stale and fabricated evidence, and isolates durable state by checkout", async () => {
    const root = await fixture();
    const context = await collectRepository({ repo: root });
    const withSecret = report();
    withSecret.summary += " token=must-not-appear";
    const valid = await validateBrief(withSecret, context);
    expect(valid.summary).not.toContain("must-not-appear");
    expect(renderBrief(valid, context)).toContain("Review first");
    const invalid = report();
    invalid.architecture[0]!.citations[0]!.line = 900;
    await expect(validateBrief(invalid, context)).rejects.toThrow("unavailable source");
    const state = await mkdtemp(path.join(tmpdir(), "jevcode-state-"));
    temporary.push(state);
    await symlink(root, path.join(state, "alias-to-source"));
    await expect(resolveStateDirectory(path.join(state, "alias-to-source/checkpoints"), root)).rejects.toThrow("outside the target");
    await rm(path.join(state, "alias-to-source"));
    await saveCheckpoint(state, context, valid);
    const saved = await readCheckpoint(state, root);
    expect(saved?.brief.summary).toBe(valid.summary);
    expect(await readCheckpoint(state, root + "-different-worktree")).toBeNull();
    await writeFile(path.join(root, "src/auth/policy.ts"), "export const allowed = () => true;\n");
    await expect(validateBrief(report(), context)).rejects.toThrow("Source changed");
    const next = await collectRepository({ repo: root });
    expect(previousContext(saved, next)).toMatchObject({ changedSinceBrief: ["src/auth/policy.ts"] });
    // A previous run's removal disclosure is not handed back as an open question.
    const noted = { ...saved!, brief: { ...saved!.brief, unknowns: ["Is caching intended?", "2 generated entries were removed from changes because the cited evidence did not support them."] } };
    expect(previousContext(noted, next)).toMatchObject({ unknowns: ["Is caching intended?"] });
    expect(await readdir(state)).toHaveLength(1);
  });

  it("honors an explicit commit base and rejects changes outside the final report's citations", async () => {
    const root = await fixture();
    const base = (await exec("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
    await writeFile(path.join(root, "src/auth/policy.ts"), "export const allowed = () => true;\n");
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "policy change"]);
    expect((await collectRepository({ repo: root })).changed).toEqual([]);
    const context = await collectRepository({ repo: root, base });
    expect(context.changed).toEqual(["src/auth/policy.ts"]);
    await writeFile(path.join(root, "src/data/store.py"), "def save(record):\n    raise Exception('offline')\n");
    await expect(validateBrief(report(), context)).rejects.toThrow("Source changed");
  });
});

describe("Codex process boundary", () => {
  it("kills a detached-from-stdio descendant before cancellation settles", async () => {
    const root = await fixture();
    const bin = path.join(root, "bin");
    await mkdir(bin);
    const pidFile = path.join(root, "descendant.pid");
    const aliveFile = path.join(root, "alive");
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
    const descendant = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>fs.writeFileSync(${JSON.stringify(aliveFile)},String(Date.now())),20);`;
    await writeFile(path.join(bin, "codex"), `#!/usr/bin/env node\nrequire('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});process.stdin.resume();setInterval(()=>{},1000);\n`, { mode: 0o700 });
    let pid: number | undefined;
    try {
      const controller = new AbortController();
      const running = runCodex({ repo: root, prompt: "inspect", timeoutMs: 5000, signal: controller.signal });
      void running.catch(() => {});
      const deadline = Date.now() + 4000;
      while (await readFile(aliveFile, "utf8").catch(() => "") === "") {
        if (Date.now() >= deadline) throw new Error("Descendant did not become ready");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      controller.abort();
      await expect(running).rejects.toThrow("cancelled");
      pid = Number(await readFile(pidFile, "utf8"));
      const stopped = await readFile(aliveFile, "utf8");
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(await readFile(aliveFile, "utf8")).toBe(stopped);
    } finally {
      pid ??= Number(await readFile(pidFile, "utf8").catch(() => "0"));
      if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch { /* already terminated */ } }
    }
  }, 10000);

  it("returns a structured final answer without replaying process logs and terminates a timed-out run", async () => {
    const root = await fixture();
    const bin = path.join(root, "bin");
    await mkdir(bin);
    const executable = path.join(bin, "codex");
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
    await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[args.indexOf('--sandbox') + 1] !== 'read-only') process.exit(9);
process.stdin.resume();
process.stdin.on('end', () => {
  process.stderr.write('private tool transcript');
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({finished: true}));
});
`, { mode: 0o700 });
    expect(await runCodex({ repo: root, prompt: "inspect" })).toEqual({ finished: true });
    await writeFile(executable, "#!/usr/bin/env node\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n", { mode: 0o700 });
    await expect(runCodex({ repo: root, prompt: "inspect", timeoutMs: 50 })).rejects.toThrow("timed out");
  });

  it("a failed provider does not produce a checkpoint or success output", async () => {
    const root = await fixture();
    const bin = path.join(root, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "codex"), "#!/usr/bin/env node\nprocess.exit(3);\n", { mode: 0o700 });
    const state = path.join(tmpdir(), `jevcode-failed-${path.basename(root)}`);
    temporary.push(state);
    const cli = new URL("../dist/cli.js", import.meta.url);
    // A bare model name selects Codex without --runner, as older hosts call it.
    await expect(exec(process.execPath, [cli.pathname, "brief", "--model", "gpt-6-luna", "--repo", root, "--state-dir", state], {
      env: { ...process.env, PATH: `${bin}${path.delimiter}${originalPath ?? ""}` },
    })).rejects.toMatchObject({ stdout: "", stderr: expect.stringMatching(/codex: Codex exited with code 3[\s\S]*no checkpoint was saved/) });
    expect(await readCheckpoint(state, root)).toBeNull();
  });
});

describe("OpenCode process boundary", () => {
  /** A stand-in opencode that records its invocation and answers per model. */
  async function fakeOpenCode(answers: Record<string, string>): Promise<string> {
    // Outside the checkout: anything written inside it would correctly fail the freshness check.
    const outside = await mkdtemp(path.join(tmpdir(), "jevcode-fake-opencode-"));
    temporary.push(outside);
    const bin = path.join(outside, "bin");
    await mkdir(bin, { recursive: true });
    const record = path.join(outside, "invocations.jsonl");
    await writeFile(path.join(bin, "opencode"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const model = args[args.indexOf('--model') + 1];
  fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args, input, env: {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, OPENCODE_DB: process.env.OPENCODE_DB, config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}'),
    project: process.env.OPENCODE_DISABLE_PROJECT_CONFIG, claude: process.env.OPENCODE_DISABLE_CLAUDE_CODE, skills: process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS, nested: process.env.JEVCODE_BRIEFING,
  } }) + '\\n');
  const answer = ${JSON.stringify(answers)}[model];
  if (answer === undefined) { console.log(JSON.stringify({ type: 'error', error: { name: 'APIError', data: { message: 'echo of submitted secret' } } })); process.exit(1); }
  const step = (tokens) => console.log(JSON.stringify({ type: 'step_finish', part: { tokens } }));
  console.log(JSON.stringify({ type: 'text', part: { text: 'I will inspect the repository first.' } }));
  step({ input: 1000, output: 50, reasoning: 200, cache: { read: 300, write: 0 } });
  console.log(JSON.stringify({ type: 'text', part: { text: answer } }));
  step({ input: 400, output: 100, reasoning: 0, cache: { read: 0, write: 0 } });
});
`, { mode: 0o700 });
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
    return record;
  }

  it("runs read-only with only the supplied config and returns the last answer with summed usage", async () => {
    const root = await fixture();
    const record = await fakeOpenCode({ "meta/muse-spark-1.3-contributor": "Here is the report:\n```json\n{\"finished\":true}\n```" });
    const result = await runOpenCode({ repo: root, prompt: "inspect the authorization boundary", model: "meta/muse-spark-1.3-contributor", variant: "high" });
    expect(result).toEqual({ value: { finished: true }, usage: { input: 1700, output: 350 } });
    const call = JSON.parse((await readFile(record, "utf8")).trim());
    expect(call.args).toEqual(expect.arrayContaining(["run", "--pure", "--format", "json", "--agent", "jevcode-brief", "--dir", root, "--variant", "high"]));
    expect(call.input).toBe("inspect the authorization boundary");
    expect(call.env).toMatchObject({ project: "1", claude: "1", skills: "1", nested: "1" });
    expect(call.env.XDG_CONFIG_HOME).toContain("jevcode-opencode-");
    expect(call.env.OPENCODE_DB).toContain("jevcode-opencode-");
    const permission = call.env.config.agent["jevcode-brief"].permission;
    expect(Object.keys(permission)[0]).toBe("*");
    expect(permission).toMatchObject({ "*": "deny", glob: "allow", read: { "*": "allow", "*/.env*": "deny", "*.pem": "deny" } });
    expect(permission.bash ?? permission.edit ?? permission.webfetch).toBeUndefined();
    expect(call.env.config.mcp).toEqual({});
    // The per-run config home and session database are removed afterwards.
    await expect(readdir(path.dirname(call.env.XDG_CONFIG_HOME))).rejects.toThrow();
  });

  it("answers a host with one JSON envelope: the decision and the current brief", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "src/auth/policy.ts"), "export const allowed = () => true;\n");
    await fakeOpenCode({ "meta/muse-spark-1.3-contributor": JSON.stringify({ ...report(), review: [] }) });
    const state = await mkdtemp(path.join(tmpdir(), "jevcode-host-cli-"));
    const config = await mkdtemp(path.join(tmpdir(), "jevcode-host-config-"));
    temporary.push(state, config);
    const cli = new URL("../dist/cli.js", import.meta.url).pathname;
    const call = async () => {
      const running = exec(process.execPath, [cli, "auto", "--trigger", "host", "--format", "json", "--activity-stdin", "--session", "s1", "--repo", root, "--state-dir", state, "--no-verify"],
        { env: { ...process.env, XDG_CONFIG_HOME: config, JEV_API_KEY: "", TYPESAFE_API_KEY: "" } });
      running.child.stdin!.end(JSON.stringify({ role: "user", text: "Open the policy for everyone.", ts: "2026-01-01T00:00:00Z" }) + "\n");
      return JSON.parse((await running).stdout);
    };
    const first = await call();
    expect(first).toMatchObject({ decision: { action: "run" }, repo: root, brief: { summary: report().summary }, coverage: expect.arrayContaining([expect.stringContaining("JavaScript/TypeScript only")]) });
    expect(first.base).toMatch(/^[0-9a-f]{40}$/);
    const second = await call();
    expect(second).toMatchObject({ decision: { action: "skip" }, generatedAt: first.generatedAt, fingerprint: first.fingerprint, brief: first.brief });
  });

  it("denies exactly the secret paths Jevcode excludes, and grep entirely", () => {
    // OpenCode semantics: "*" matches any run of characters including "/", and the last matching rule wins.
    const decide = (file: string) => Object.entries(READ_RULES).filter(([pattern]) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(file)).at(-1)?.[1];
    const samples = [".env", "config/.env.local", ".env.example", "deploy/server.pem", "certs/tls.key", "id_rsa", "id_rsa.pub", "home/.ssh/id_ed25519", "home/.ssh/id_ed25519.pub", "keys/store.jks", "a/b.p12", ".npmrc", "a/.netrc", "aws/credentials",
      "src/index.ts", "README.md", "docs/credentials.md", "src/env.ts", "keys/public.pem.txt"];
    for (const file of samples) {
      for (const candidate of [file, `/work/repo/${file}`]) expect([candidate, decide(candidate)]).toEqual([candidate, isSecretPath(file) ? "deny" : "allow"]);
    }
    const permission = OPENCODE_CONFIG.agent["jevcode-brief"].permission as Record<string, unknown>;
    expect(permission.grep).toBeUndefined();
    expect(permission["*"]).toBe("deny");
  });

  it("falls back from Muse to DeepSeek through the CLI and records the writer that succeeded", async () => {
    const root = await fixture();
    const brief = JSON.stringify({ ...report(), review: [] });
    const record = await fakeOpenCode({ "deepseek/deepseek-flash": brief });
    await expect(runOpenCode({ repo: root, prompt: "inspect", model: "meta/muse-spark-1.3-contributor" })).rejects.toThrow(/exited with code 1/);
    const state = await mkdtemp(path.join(tmpdir(), "jevcode-fallback-state-"));
    temporary.push(state);
    const cli = new URL("../dist/cli.js", import.meta.url).pathname;
    const { stdout, stderr } = await exec(process.execPath, [cli, "brief", "--repo", root, "--state-dir", state, "--no-verify"], { env: { ...process.env, JEV_API_KEY: "", TYPESAFE_API_KEY: "" } });
    expect(stdout).toContain("System shape");
    expect(stderr).toContain("muse did not produce a valid brief; trying deepseek");
    expect(stderr + stdout).not.toContain("echo of submitted secret");
    const models = (await readFile(record, "utf8")).trim().split("\n").map((line) => JSON.parse(line).args).map((args: string[]) => args[args.indexOf("--model") + 1]);
    expect(models.slice(-2)).toEqual(["meta/muse-spark-1.3-contributor", "deepseek/deepseek-flash"]);
    expect((await readCheckpoint(state, root))?.brief.summary).toBe(report().summary);
    const ledger = (await readFile(path.join(state, (await readdir(state)).find((file) => file.endsWith(".ledger.jsonl"))!), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(ledger.at(-1)).toMatchObject({ kind: "run", trigger: "manual", ok: true, writer: "deepseek", writerUsage: { input: 1700, output: 350 } });
  });
});
