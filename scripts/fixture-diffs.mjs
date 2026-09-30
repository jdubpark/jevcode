// One-off, idempotent fixture generator for the trace viewer (A1-9).
//
// For each fixtures/<scenario>/events.jsonl it:
//   1. stamps turnId "turn-<scenario>-1" on every agent event (one Codex process);
//   2. gives each command/tool start and its completion one callId
//      "turn-<scenario>-1:item_<n>", n counting calls in line order (FIFO pairing
//      by command text or tool name), and an agent_reasoning line its own call;
//   3. stamps sourceCallId on each derived command_executed / test_result fact:
//      the open call with the same command, else the last one that closed;
//   4. recomputes every git_hunk from `git diff --no-index repo/<file> changes/<file>`:
//      added/removed from the raw diff, diff from prepareDiffForStorage;
//   5. oauth only: inserts one agent_reasoning line before the final claim and
//      fixes the failure text to what vitest prints for toBe(7) on null;
//   6. stamps Decision.ts (the source time of the row's status) on each decision
//      row without one: the ts of the nearest earlier record that has one. For an
//      answered row that is the user's decision message.
// Unchanged lines stay byte-identical; changed lines keep the file's JSON style.
//
// Needs built output: pnpm --filter "jevcode-desktop^..." build && pnpm --filter jevcode-desktop build
// Run from the repo root: node scripts/fixture-diffs.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareDiffForStorage } from "../apps/desktop/dist/main/pipeline/redactor.js";
import { diffLineCounts } from "./diff-line-counts.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCENARIOS = ["oauth", "rate-limit", "schema-change", "api-break", "dep-change"];

const OAUTH_CLAIM = "OAuth implementation complete; all checks pass.";
const OAUTH_REASONING = {
  type: "agent_reasoning",
  sessionId: "sess-oauth-0001",
  ts: "2026-09-18T09:00:42.000Z",
  text: "pnpm test reported 1 failed and 14 passed; the account-linking test still fails.",
};
const OAUTH_OLD_FAILURE = "expected 7 to be null";
const OAUTH_NEW_FAILURE = "expected null to be 7";

// Python json.dumps style (", " and ": "), used by fixtures/oauth/events.jsonl.
function spacedJson(value) {
  if (Array.isArray(value)) return `[${value.map(spacedJson).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${spacedJson(v)}`).join(", ")}}`;
  }
  return JSON.stringify(value);
}

function isAgentEvent(record) {
  return !("repoId" in record) && !("severity" in record) && !("kind" in record);
}

function isDecision(record) {
  return "severity" in record && "status" in record && !("kind" in record);
}

// Pinned flags keep the text independent of the user's git config and of the
// repository size (full blob ids, fixed prefixes and algorithm).
function rawFixtureDiff(dir, file) {
  const before = existsSync(path.join(dir, "repo", file)) ? `repo/${file}` : "/dev/null";
  const after = existsSync(path.join(dir, "changes", file)) ? `changes/${file}` : "/dev/null";
  let out;
  try {
    out = execFileSync(
      "git",
      [
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-index",
        "--no-color",
        "--no-ext-diff",
        "--full-index",
        "--diff-algorithm=myers",
        "--indent-heuristic",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--",
        before,
        after,
      ],
      { cwd: dir, encoding: "utf8" },
    );
  } catch (error) {
    if (error.status !== 1) throw error;
    out = error.stdout;
  }
  // Present the diff as the git collector would see it: paths relative to the repo.
  return out
    .split("\n")
    .map((line) =>
      /^(diff --git |--- |\+\+\+ )/.test(line)
        ? line.replace(/(^|\s)([ab])\/(?:repo|changes)\//g, "$1$2/")
        : line,
    )
    .join("\n");
}

function processScenario(scenario) {
  const dir = path.join(ROOT, "fixtures", scenario);
  const eventsPath = path.join(dir, "events.jsonl");
  const turnId = `turn-${scenario}-1`;
  const input = readFileSync(eventsPath, "utf8").split("\n");
  const trailing = input.at(-1) === "" ? [""] : [];
  const lines = input.filter((line) => line.trim() !== "");
  const spaced = lines[0]?.startsWith('{"type": ') ?? false;
  const serialize = (record) => (spaced ? spacedJson(record) : JSON.stringify(record));

  const entries = lines.map((line) => ({ line, record: JSON.parse(line) }));
  if (scenario === "oauth" && !entries.some((entry) => entry.record.type === "agent_reasoning")) {
    const claimIndex = entries.findIndex(
      (entry) => entry.record.type === "agent_message" && entry.record.text === OAUTH_CLAIM,
    );
    if (claimIndex < 0) throw new Error("oauth: final claim message not found");
    entries.splice(claimIndex, 0, { line: null, record: { ...OAUTH_REASONING } });
  }

  let nextItem = 1;
  let lastTs;
  const openCalls = new Map();
  const lastClosed = new Map();
  const mint = () => `${turnId}:item_${nextItem++}`;

  const output = entries.map(({ line, record }) => {
    const next = { ...record };
    if (isAgentEvent(next)) {
      next.turnId = turnId;
      const family =
        next.type.startsWith("command_") ? "command" : next.type.startsWith("tool_") ? "tool" : null;
      const target = family === "command" ? next.command : family === "tool" ? next.tool : null;
      const key = `${family}\u0000${target}`;
      if (next.type === "command_started" || next.type === "tool_started") {
        next.callId = mint();
        openCalls.set(key, [...(openCalls.get(key) ?? []), next.callId]);
      } else if (next.type === "command_completed" || next.type === "tool_completed") {
        const queue = openCalls.get(key) ?? [];
        next.callId = queue.shift() ?? mint();
        openCalls.set(key, queue);
        if (family === "command") lastClosed.set(next.command, next.callId);
      } else if (next.type === "agent_reasoning") {
        next.callId = mint();
      }
    } else if (next.type === "command_executed" || next.type === "test_result") {
      const open = openCalls.get(`command\u0000${next.command}`) ?? [];
      const sourceCallId = open.at(-1) ?? lastClosed.get(next.command);
      if (sourceCallId !== undefined) next.sourceCallId = sourceCallId;
      if (scenario === "oauth" && next.type === "test_result") {
        next.failures = next.failures.map((failure) =>
          failure.message === OAUTH_OLD_FAILURE ? { ...failure, message: OAUTH_NEW_FAILURE } : failure,
        );
      }
    } else if (next.type === "git_hunk") {
      const raw = rawFixtureDiff(dir, next.file);
      const counts = diffLineCounts(raw);
      next.added = counts.added;
      next.removed = counts.removed;
      next.diff = prepareDiffForStorage(next.file, raw);
    } else if (isDecision(next) && next.ts === undefined && lastTs !== undefined) {
      next.ts = lastTs;
    }
    if (typeof next.ts === "string") lastTs = next.ts;
    const changed = line === null || JSON.stringify(next) !== JSON.stringify(record);
    return changed ? serialize(next) : line;
  });
  writeFileSync(eventsPath, [...output, ...trailing].join("\n"));
  return output.length;
}

for (const scenario of SCENARIOS) {
  const count = processScenario(scenario);
  console.log(`fixture-diffs: ${scenario} ${count} records`);
}
