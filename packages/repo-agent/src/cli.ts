#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runAuto } from "./auto.js";
import { generateBrief } from "./brief.js";
import { collectRepository, contextFingerprint, repositoryRoot } from "./collect.js";
import { configPath, defaultStateDirectory, loadConfig, repoEnabled, saveConfig, setOptIn } from "./config.js";
import { launchFromHook } from "./hook.js";
import { clean } from "./io.js";
import { jevFromEnv } from "./jev.js";
import { appendLedger, calibrate, churn, newId, readLedger, readTuning, saveTuning, type LedgerEntry, type Verdict } from "./learning.js";
import { buildPrompt, SECTIONS } from "./prompt.js";
import { referencedEvidence, renderBrief } from "./report.js";
import { writersFor, type RunnerName } from "./runner.js";
import { previousContext, readCheckpoint, renderedPath, resolveStateDirectory, saveCheckpoint, saveSnapshot } from "./state.js";

const HELP = `Jevcode repository briefing agent

  jevcode brief    [options]  Investigate and print a review brief
  jevcode auto     [options]  Refresh the brief only when Jev judges it due
  jevcode show     [options]  Print the latest generated brief; no model call
  jevcode status   [options]  Show automatic-brief settings, tuning and recent decisions
  jevcode feedback VERDICT    Record useful, noise, late, wrong or harsh for the latest brief
  jevcode optin    [--repo]   Brief this repository automatically (all its clones and worktrees)
  jevcode optout   [--repo]   Stop automatic briefs for this repository
  jevcode context  [options]  Print collected evidence as JSON; no model call
  jevcode prompt   [options]  Print the reusable agent prompt and evidence

  --repo PATH       Git checkout to inspect (default: current directory)
  --base REF        Compare this commit to the working tree (default: HEAD)
  --log PATH        Explicit agent transcript/JSONL file (repeatable, max 5)
  --activity-stdin  Read one explicitly scoped activity log from stdin (max 8 MiB; brief and auto)
  --focus PATH      Critical repo-relative component/path (repeatable)
  --question TEXT   Additional review focus
  --format FORMAT   markdown or json (brief only; default: markdown)
  --runner NAME     muse (default, DeepSeek fallback), deepseek, or codex
  --model MODEL     Writer model override for the selected runner
  --variant NAME    OpenCode reasoning variant (default: high)
  --no-verify       Skip the Jev claim-support check
  --timeout SEC     Model run limit, 10-1800 seconds (default: 600)
  --state-dir PATH  Checkpoint directory outside the target source tree
  --no-state        Do not read or save previous generated brief
  --hook KIND       auto: read a claude or codex Stop hook payload from stdin; run detached
  --dry-run         auto: print the decision without writing a brief or recording it
  --trigger KIND    auto: hook, manual or host (default: manual); host skips opt-in
  --format json     auto: print the decision and the current brief as one JSON object
  --session ID      auto: agent session identifier for the ledger
  --section NAME    feedback: the brief section the verdict is about
  --note TEXT       feedback: a short note
  --help            Show this help

Source is read-only. No tests/builds are executed. No logs are discovered
globally. Checkpoints mean generated, never human-reviewed. The muse and
deepseek runners need an authenticated OpenCode CLI; codex needs Codex.
Jev (TypeSafe) reads JEV_API_KEY or TYPESAFE_API_KEY; without a key the gate
uses disclosed heuristics and claims are not checked. Automatic briefs run
only in opted-in repositories. Settings: ${configPath()}
`;

async function readStdin(limit: number, label: string): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += buffer.length;
    if (bytes > limit) throw new Error(`${label} exceeds ${Math.round(limit / 1024 / 1024)} MiB.`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const write = (output: string) => new Promise<void>((resolve, reject) => process.stdout.write(output, (error) => error ? reject(error) : resolve()));

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    repo: { type: "string" }, base: { type: "string" }, log: { type: "string", multiple: true }, focus: { type: "string", multiple: true },
    question: { type: "string" }, format: { type: "string" }, model: { type: "string" }, timeout: { type: "string" },
    runner: { type: "string" }, variant: { type: "string" }, "no-verify": { type: "boolean" },
    "state-dir": { type: "string" }, "no-state": { type: "boolean" }, "activity-stdin": { type: "boolean" }, help: { type: "boolean", short: "h" },
    hook: { type: "string" }, "dry-run": { type: "boolean" }, trigger: { type: "string" }, session: { type: "string" },
    section: { type: "string" }, note: { type: "string" },
  } });
  if (values.help) { process.stdout.write(HELP); return; }
  const command = positionals[0] ?? "brief";
  const commands = ["brief", "auto", "show", "status", "feedback", "optin", "optout", "context", "prompt"];
  if (!commands.includes(command) || positionals.length > (command === "feedback" ? 2 : 1)) throw new Error(`Expected ${commands.join(", ")}. Use --help for usage.`);
  const stateOption = values["state-dir"] ?? defaultStateDirectory();

  if (command === "auto" && values.hook !== undefined) {
    if (!["claude", "codex"].includes(values.hook)) throw new Error("Hook must be claude or codex.");
    // A hook must never block or fail the agent's stop; launch problems go to auto.log only.
    const payload = await readStdin(1024 * 1024, "Hook payload").catch(() => "{}");
    await launchFromHook(payload, fileURLToPath(import.meta.url), stateOption).catch(() => {});
    return;
  }
  if (values.format !== undefined && !["markdown", "json"].includes(values.format)) throw new Error("Format must be markdown or json.");
  if (values.runner !== undefined && !["muse", "deepseek", "codex"].includes(values.runner)) throw new Error("Runner must be muse, deepseek, or codex.");
  const timeout = Number(values.timeout ?? "600");
  if (!Number.isFinite(timeout) || timeout < 10 || timeout > 1800) throw new Error("Timeout must be between 10 and 1800 seconds.");
  const config = await loadConfig();
  const writers = writersFor((values.runner ?? "muse") as RunnerName, config, values.model, values.variant);
  const log = (message: string) => process.stderr.write(`${message}\n`);

  if (command === "auto") {
    if (values.trigger !== undefined && !["hook", "manual", "host"].includes(values.trigger)) throw new Error("Trigger must be hook, manual or host.");
    const activityText = values["activity-stdin"] ? await readStdin(8 * 1024 * 1024, "Activity input") : undefined;
    const outcome = await runAuto({
      repo: values.repo ?? process.cwd(), logs: values.log ?? [], session: values.session ?? null, trigger: (values.trigger ?? "manual") as "hook" | "manual" | "host",
      dryRun: values["dry-run"] ?? false, stateDir: stateOption, config: values.timeout ? { ...config, timeoutSeconds: timeout } : config,
      judge: values["no-verify"] ? null : jevFromEnv(), writers, log, activityText, base: values.base,
    });
    if (values.format === "json") {
      // The current brief, refreshed or carried; generatedAt says which snapshot it describes.
      const checkpoint = outcome.repo && outcome.directory ? await readCheckpoint(outcome.directory, outcome.repo) : null;
      const decision = { action: outcome.action, reason: clean(outcome.reason), judge: outcome.judgment?.judge ?? null, worthwhile: outcome.judgment?.worthwhile ?? null, scope: outcome.judgment?.scope ?? null };
      await write(JSON.stringify(checkpoint ? {
        decision, repo: checkpoint.repo, head: checkpoint.head, base: checkpoint.base ?? null, generatedAt: checkpoint.generatedAt, fingerprint: checkpoint.fingerprint,
        brief: checkpoint.brief, evidence: checkpoint.evidence, coverage: checkpoint.coverage ?? [],
      } : { decision, repo: outcome.repo ?? null, brief: null }, null, 2) + "\n");
    } else await write(`${new Date().toISOString()} ${outcome.action}: ${clean(outcome.reason)}${outcome.briefPath ? `\nBrief: ${outcome.briefPath}` : ""}\n`);
    if (outcome.action === "failed") process.exitCode = 1;
    return;
  }

  if (command === "optin" || command === "optout") {
    const repo = await repositoryRoot(values.repo ?? process.cwd());
    const next = await setOptIn(config, repo, command === "optin");
    await saveConfig(next);
    const on = await repoEnabled(next, repo);
    await write(`${repo}: automatic briefs ${on ? "on" : "off"}${command === "optin" && !on ? " (still disabled or excluded by another rule in " + configPath() + ")" : ""}.\n`);
    return;
  }

  if (command === "show" || command === "status" || command === "feedback") {
    const repo = await repositoryRoot(values.repo ?? process.cwd());
    const directory = await resolveStateDirectory(stateOption, repo);
    if (command === "show") {
      const rendered = await readFile(renderedPath(directory, repo), "utf8").catch(() => null);
      if (rendered === null) throw new Error("No generated brief exists for this checkout yet. Run jevcode brief or jevcode auto.");
      await write(rendered);
      return;
    }
    if (command === "feedback") {
      const verdict = positionals[1] as Verdict | undefined;
      if (!verdict || !["useful", "noise", "late", "wrong", "harsh"].includes(verdict)) throw new Error("Feedback must be useful, noise, late, wrong or harsh.");
      if (values.section !== undefined && !(SECTIONS as readonly string[]).includes(values.section)) throw new Error(`Section must be one of ${SECTIONS.join(", ")}.`);
      await appendLedger(directory, repo, { kind: "feedback", id: newId(), at: new Date().toISOString(), verdict, section: values.section ?? null, note: values.note ? clean(values.note).slice(0, 300) : null });
      const tuning = await readTuning(directory, repo);
      const next = calibrate(tuning, await readLedger(directory, repo), new Date());
      if (next !== tuning) await saveTuning(directory, repo, next);
      const changed = next.history.slice(tuning.history.length);
      await write(`Recorded ${verdict}.${changed.length ? "\n" + changed.map((entry) => `${entry.field}: ${entry.from} → ${entry.to} (${entry.reason})`).join("\n") : " Tuning needs more outcomes before it changes."}\n`);
      return;
    }
    const checkpoint = await readCheckpoint(directory, repo);
    const tuning = await readTuning(directory, repo);
    const ledger = await readLedger(directory, repo);
    const removedLast = ledger.filter((entry): entry is Extract<LedgerEntry, { kind: "run" }> => entry.kind === "run" && entry.ok).at(-1)?.removed ?? [];
    const describe = (entry: LedgerEntry): string => entry.kind === "decision" ? `${entry.at} ${entry.action} (${entry.judge}): ${entry.reason}`
      : entry.kind === "run" ? `${entry.at} ${entry.ok ? "brief" : "failed"} by ${entry.writer ?? "none"}${entry.writerUsage ? `, ${entry.writerUsage.input + entry.writerUsage.output} writer tokens` : ""}${entry.churn !== null ? `, churn ${entry.churn.toFixed(2)}` : ""}${entry.error ? `: ${entry.error}` : ""}`
        : `${entry.at} feedback ${entry.verdict}${entry.section ? ` on ${entry.section}` : ""}`;
    await write([
      `Repository: ${repo}`, `Automatic briefs: ${await repoEnabled(config, repo) ? "on for this repository" : config.enabled ? "off (run jevcode optin)" : "disabled"} (${configPath()})`,
      `Writers: ${writers.map((writer) => `${writer.id} ${writer.model ?? "default"}`).join(" → ")}`,
      `Jev: ${jevFromEnv() ? "TypeSafe key available" : "no key; heuristic gate, claims unchecked"}`,
      `Latest brief: ${checkpoint ? `${checkpoint.generatedAt} (${renderedPath(directory, repo)})` : "none"}`,
      `Tuning: gate ${tuning.gateThreshold}, debounce ${tuning.debounceMinutes} min, min files ${tuning.minFiles}, verify ${tuning.verifyThreshold}${tuning.adjustedAt ? `, last evaluated ${tuning.adjustedAt}` : ""}`,
      ...tuning.history.slice(-3).map((entry) => `  ${entry.at} ${entry.field} ${entry.from} → ${entry.to}: ${entry.reason}`),
      "Recent activity:", ...ledger.slice(-10).map((entry) => `  ${describe(entry)}`),
      ...(removedLast.length ? ["Removed by the claim check in the latest brief (jevcode feedback harsh if they were correct):", ...removedLast.map((entry) => `  ${entry.support.toFixed(2)} ${entry.section}: ${clean(entry.text)}`)] : []),
    ].join("\n") + "\n");
    return;
  }

  const activityText = values["activity-stdin"] ? await readStdin(8 * 1024 * 1024, "Activity input") : undefined;
  const context = await collectRepository({ repo: values.repo ?? process.cwd(), base: values.base, logs: values.log, focus: values.focus, activityText });
  if (command === "context") { process.stdout.write(JSON.stringify(context, null, 2) + "\n"); return; }
  const stateDir = values["no-state"] ? "" : await resolveStateDirectory(stateOption, context.repo);
  const previous = values["no-state"] ? null : await readCheckpoint(stateDir, context.repo);
  const prompt = buildPrompt(context, values.question, previousContext(previous, context));
  if (command === "prompt") { process.stdout.write(prompt + "\n"); return; }
  log(`Reviewing ${context.components.length} components and ${context.changed.length} changed source paths…`);
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const started = Date.now();
  const tuning = values["no-state"] ? null : await readTuning(stateDir, context.repo);
  const record = async (fields: Partial<Extract<LedgerEntry, { kind: "run" }>>) => {
    if (values["no-state"]) return;
    await appendLedger(stateDir, context.repo, { kind: "run", id: newId(), at: new Date().toISOString(), trigger: "manual", decision: null, ok: false, error: null, writer: null, model: null, attempts: 0, writerUsage: null, jevUsage: null, churn: null, weakClaims: 0, removedClaims: 0, unsupportedAtDefault: 0, removed: [], elapsedMs: Date.now() - started, ...fields });
  };
  let result: Awaited<ReturnType<typeof generateBrief>>;
  try {
    result = await generateBrief({
      context, prompt, writers, deadline: started + timeout * 1000, signal: abort.signal,
      judge: values["no-verify"] ? null : jevFromEnv(), verifyThreshold: tuning?.verifyThreshold ?? 0.35, log,
    });
  } catch (error) {
    await record({ error: error instanceof Error && error.name !== "ZodError" ? clean(error.message).slice(0, 500) : "invalid report" }).catch(() => {});
    throw error;
  } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
  if (abort.signal.aborted) throw new Error("Briefing cancelled; no successful checkpoint was saved.");
  const { brief } = result;
  const rendered = renderBrief(brief, context);
  const output = values.format === "json" ? JSON.stringify({ repo: context.repo, head: context.head, base: context.base, generatedAt: context.generatedAt, fingerprint: contextFingerprint(context), brief, evidence: referencedEvidence(brief, context), coverage: context.limitations }, null, 2) + "\n" : rendered;
  await write(output);
  if (!values["no-state"]) {
    await saveCheckpoint(stateDir, context, brief, rendered);
    await saveSnapshot(stateDir, context);
    await record({ ok: true, writer: result.writer, model: result.model, attempts: result.attempts, writerUsage: result.writerUsage, jevUsage: result.jevUsage, churn: churn(previous?.brief ?? null, brief), weakClaims: result.weakClaims, removedClaims: result.removedClaims, unsupportedAtDefault: result.unsupportedAtDefault, removed: result.removed });
  }
}

main().catch((error: unknown) => {
  // Schema/provider errors can contain submitted data. Do not echo raw schema issue dumps.
  const message = error instanceof Error && error.name !== "ZodError" ? clean(error.message) : "The generated brief did not satisfy the report contract; no checkpoint was saved.";
  process.stderr.write(`jevcode: ${message}\n`);
  process.exitCode = 1;
});
