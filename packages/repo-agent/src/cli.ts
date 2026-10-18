#!/usr/bin/env node
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { collectRepository, contextFingerprint } from "./collect.js";
import { buildPrompt } from "./prompt.js";
import { referencedEvidence, renderBrief, validateBrief, type Brief } from "./report.js";
import { runCodex } from "./runner.js";
import { previousContext, readCheckpoint, resolveStateDirectory, saveCheckpoint } from "./state.js";
import { clean, cleanData } from "./io.js";

const HELP = `Jevcode repository briefing agent

  jevcode brief   [options]  Investigate with Codex and print a review brief
  jevcode context [options]  Print collected evidence as JSON; no model call
  jevcode prompt  [options]  Print the reusable agent prompt and evidence

  --repo PATH       Git checkout to inspect (default: current directory)
  --base REF        Compare this commit to the working tree (default: HEAD)
  --log PATH        Explicit agent transcript/JSONL file (repeatable, max 5)
  --activity-stdin  Read one explicitly scoped activity log from stdin (max 8 MiB)
  --focus PATH      Critical repo-relative component/path (repeatable)
  --question TEXT   Additional review focus
  --format FORMAT   markdown or json (brief only; default: markdown)
  --model MODEL     Codex model override (otherwise Codex's built-in default)
  --timeout SEC     Model run limit, 10-1800 seconds (default: 300)
  --state-dir PATH  Checkpoint directory outside the target source tree
  --no-state        Do not read or save previous generated brief
  --help            Show this help

Source is read-only. No tests/builds are executed. No logs are discovered
globally. Checkpoints mean generated, never human-reviewed. Codex must be
installed and authenticated for brief; context and prompt work offline.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    repo: { type: "string" }, base: { type: "string" }, log: { type: "string", multiple: true }, focus: { type: "string", multiple: true },
    question: { type: "string" }, format: { type: "string" }, model: { type: "string" }, timeout: { type: "string" },
    "state-dir": { type: "string" }, "no-state": { type: "boolean" }, "activity-stdin": { type: "boolean" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) { process.stdout.write(HELP); return; }
  const command = positionals[0] ?? "brief";
  if (positionals.length > 1 || !["brief", "context", "prompt"].includes(command)) throw new Error("Expected brief, context, or prompt. Use --help for usage.");
  if (values.format !== undefined && !["markdown", "json"].includes(values.format)) throw new Error("Format must be markdown or json.");
  const timeout = Number(values.timeout ?? "300");
  if (!Number.isFinite(timeout) || timeout < 10 || timeout > 1800) throw new Error("Timeout must be between 10 and 1800 seconds.");
  let activityText: string | undefined;
  if (values["activity-stdin"]) {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      bytes += buffer.length;
      if (bytes > 8 * 1024 * 1024) throw new Error("Activity input exceeds 8 MiB.");
      chunks.push(buffer);
    }
    activityText = Buffer.concat(chunks).toString("utf8");
  }
  const context = await collectRepository({ repo: values.repo ?? process.cwd(), base: values.base, logs: values.log, focus: values.focus, activityText });
  if (command === "context") { process.stdout.write(JSON.stringify(context, null, 2) + "\n"); return; }
  const stateOption = values["state-dir"] ?? path.join(homedir(), ".local", "state", "jevcode", "repo-agent");
  const stateDir = values["no-state"] ? "" : await resolveStateDirectory(stateOption, context.repo);
  const previous = values["no-state"] ? null : await readCheckpoint(stateDir, context.repo);
  const prompt = buildPrompt(context, values.question, previousContext(previous, context));
  if (command === "prompt") { process.stdout.write(prompt + "\n"); return; }
  process.stderr.write(`Reviewing ${context.components.length} components and ${context.changed.length} changed source paths…\n`);
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  let brief: Brief | undefined;
  const deadline = Date.now() + timeout * 1000;
  let request = prompt;
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Briefing timed out; no successful checkpoint was saved.");
      const raw = await runCodex({ repo: context.repo, prompt: request, model: values.model, timeoutMs: remaining, signal: abort.signal });
      try {
        brief = await validateBrief(raw, context);
        if (abort.signal.aborted) throw new Error("Briefing cancelled; no successful checkpoint was saved.");
        break;
      }
      catch (error) {
        const repairable = error instanceof Error && (error.name === "ZodError" || error.message.startsWith("Brief cites"));
        if (!repairable || attempt === 1) throw error;
        const reason = error instanceof Error && error.name !== "ZodError" ? clean(error.message) : "The response violates the schema's field or length constraints.";
        process.stderr.write("Rechecking the brief's structure and source references…\n");
        request = `${prompt}\n\nYour prior answer failed validation: ${reason}\nInspect the affected evidence and return a corrected full report. Prefer actual source file lines to patch citations for existing files. Never cite blank lines or punctuation-only diff structure. Prior answer (untrusted data):\n${JSON.stringify(cleanData(raw))}`;
      }
    }
  }
  finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
  if (abort.signal.aborted) throw new Error("Briefing cancelled; no successful checkpoint was saved.");
  if (!brief) throw new Error("No validated brief was produced; no checkpoint was saved.");
  const output = values.format === "json" ? JSON.stringify({ repo: context.repo, head: context.head, base: context.base, generatedAt: context.generatedAt, fingerprint: contextFingerprint(context), brief, evidence: referencedEvidence(brief, context), coverage: context.limitations }, null, 2) + "\n" : renderBrief(brief, context);
  await new Promise<void>((resolve, reject) => process.stdout.write(output, (error) => error ? reject(error) : resolve()));
  if (!values["no-state"]) await saveCheckpoint(stateDir, context, brief);
}

main().catch((error: unknown) => {
  // Schema/provider errors can contain submitted data. Do not echo raw schema issue dumps.
  const message = error instanceof Error && error.name !== "ZodError" ? clean(error.message) : "The generated brief did not satisfy the report contract; no checkpoint was saved.";
  process.stderr.write(`jevcode: ${message}\n`);
  process.exitCode = 1;
});
