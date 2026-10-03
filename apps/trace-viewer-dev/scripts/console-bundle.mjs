#!/usr/bin/env node
// Writes public/bundles/console-10k.json: one finished session with more than 10,000 Console steps, the input of the
// spec 2026-10-02 §11 Console budgets. Run after `pnpm -r build`: it validates the bundle with the contracts' dist.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TRACE_BUNDLE_FORMAT, TRACE_BUNDLE_VERSION, TraceBundleSchema } from "@jevcode/contracts";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(APP, "public", "bundles", "console-10k.json");
// 5.2 Console steps per unit (message, read, command, edit, reasoning, and a test run every fifth unit).
const UNITS = Number(process.env.CONSOLE_UNITS ?? 2_100);
// With CONSOLE_STORY_EVERY=n, an explainer story row after every n-th unit (each with new sentences), so the Console
// merges a ◆ Summary row per story (lane 07 S-4); 0, the default, writes none.
const STORY_EVERY = Number(process.env.CONSOLE_STORY_EVERY ?? 0);
if (!Number.isInteger(STORY_EVERY) || STORY_EVERY < 0) throw new Error("CONSOLE_STORY_EVERY must be a whole number");
const SESSION_ID = "sess-console-10k";
const REPO_ID = "repo-console-10k";
const PROMPT = "Refactor the auth module and keep every test green.";
const T0 = Date.parse("2026-10-02T09:00:00.000Z");

const rows = [];
const iso = (seq) => new Date(T0 + seq * 1_000).toISOString();

function push(type, payload, extra = {}) {
  const seq = rows.length + 1;
  const ts = iso(seq);
  rows.push({ seq, type, ts, payload: { ...payload, ts }, ...extra });
}
const agent = (event) => push("agent_event", { sessionId: SESSION_ID, ...event });
const fact = (body, factId) => push("evidence_fact", { repoId: REPO_ID, sessionId: SESSION_ID, ...body }, { factId });

agent({ type: "agent_started", prompt: PROMPT });
let stories = 0;
for (let unit = 0; unit < UNITS; unit += 1) {
  const dir = `src/module${unit % 97}`;
  const file = `${dir}/part${unit}.ts`;
  agent({ type: "agent_message", role: "assistant", text: `Step ${unit}: updating ${file}, then rerunning the focused tests.` });
  const messageSeq = rows.length;
  agent({ type: "file_read", path: file });
  agent({ type: "command_started", command: `rg -n "export" ${dir}`, callId: `cmd_${unit}` });
  agent({
    type: "command_completed",
    command: `rg -n "export" ${dir}`,
    exitCode: 0,
    callId: `cmd_${unit}`,
    stderr: "",
    stdout: Array.from({ length: 12 }, (_, line) => `${dir}/part${line}.ts:${line + 1}: export const value${line} = ${line};`).join("\n"),
  });
  agent({ type: "file_changed", path: file, callId: `edit_${unit}` });
  fact(
    { type: "git_hunk", file, added: 1 + (unit % 9), removed: unit % 4, isFormattingOnly: false, isConfigOnly: false, isLockfile: false },
    `fact_hunk_${unit}`,
  );
  agent({ type: "agent_reasoning", text: `Checking ${dir} before the next file.` });
  if (unit % 5 === 4) {
    agent({ type: "command_started", command: "pnpm test --filter auth", callId: `test_${unit}` });
    agent({
      type: "command_completed",
      command: "pnpm test --filter auth",
      exitCode: 0,
      stdout: "Tests 24 passed (24)",
      stderr: "",
      callId: `test_${unit}`,
    });
    fact(
      { type: "test_result", runner: "vitest", command: "pnpm test --filter auth", passed: 24, failed: 0, skipped: 0, failures: [], sourceCallId: `test_${unit}` },
      `fact_test_${unit}`,
    );
  }
  if (STORY_EVERY > 0 && unit % STORY_EVERY === STORY_EVERY - 1) {
    const seq = rows.length + 1;
    rows.push({
      seq,
      type: "explainer",
      ts: iso(seq),
      payload: {
        sessionId: SESSION_ID,
        kind: "story",
        basisSeq: seq - 1,
        sentences: [{ text: `The agent updated ${file} and kept the auth tests green (unit ${unit}).`, citations: [{ kind: "step", id: `step:${messageSeq}` }] }],
      },
    });
    stories += 1;
  }
}
agent({ type: "agent_completed" });

const lastSeq = rows.length;
const bundle = TraceBundleSchema.parse({
  format: TRACE_BUNDLE_FORMAT,
  version: TRACE_BUNDLE_VERSION,
  exportedAt: iso(lastSeq + 1),
  redactionCount: 0,
  session: {
    sessionId: SESSION_ID,
    repoId: REPO_ID,
    repoName: "console-10k",
    prompt: PROMPT,
    state: "completed",
    startedAt: iso(0),
    endedAt: iso(lastSeq),
    lastEventSeq: lastSeq,
  },
  rows,
});
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(bundle), { mode: 0o600 });
console.log(`console-10k: ${rows.length} rows from ${UNITS} units, ${stories} story rows -> ${OUT}`);
