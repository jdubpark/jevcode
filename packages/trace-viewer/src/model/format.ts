import type { AgentState, NormalizedAgentEvent } from "@jevcode/contracts";

import type { StepKind, TestCounts } from "./types.js";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
}

/** Bidi controls (U+202A–U+202E, U+2066–U+2069, U+200E, U+200F) and C0 controls other than \t,
 *  and \n when multiline. All are single UTF-16 code units. Checked by code, not by a regex,
 *  because ESLint's no-control-regex rejects control ranges in patterns. */
function isUntrustedCode(code: number, multiline: boolean): boolean {
  if (code < 0x20) return code !== 0x09 && !(multiline && code === 0x0a);
  return (
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Replaces bidi and control characters with a visible ⟨U+XXXX⟩ token (spec §6.8), so agent text
 * cannot reorder or hide a command or path the supervisor reads. Tabs stay; line breaks stay only
 * with { multiline: true }. Text without such characters is returned as is.
 */
export function displayUntrusted(text: string, options: { multiline?: boolean } = {}): string {
  const multiline = options.multiline === true;
  let result = "";
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (!isUntrustedCode(code, multiline)) continue;
    result += `${text.slice(start, index)}⟨U+${code.toString(16).toUpperCase().padStart(4, "0")}⟩`;
    start = index + 1;
  }
  return start === 0 ? text : result + text.slice(start);
}

/** "exit 0", "exit 1"; "exit unknown" for a negative code (R2: -1 = Codex gave none); "" while running. */
export function exitLabel(exitCode: number | null): string {
  if (exitCode === null) return "";
  return exitCode < 0 ? "exit unknown" : `exit ${exitCode}`;
}

/**
 * Shortens text to at most maxGraphemes user-perceived characters by cutting
 * the middle. Paths keep their whole basename when it fits ("src/au…/file.ts").
 * Never splits an emoji ZWJ sequence or a Hangul syllable. Bidi and control
 * characters become visible tokens first (displayUntrusted).
 */
export function truncateMiddle(text: string, maxGraphemes: number): string {
  if (!Number.isFinite(maxGraphemes) || maxGraphemes < 1) return "";
  const max = Math.floor(maxGraphemes);
  const safe = displayUntrusted(text);
  // A string never has more graphemes than UTF-16 code units: skip the segmenter when it fits.
  if (safe.length <= max) return safe;
  const all = graphemes(safe);
  if (all.length <= max) return safe;
  const slash = safe.lastIndexOf("/");
  if (slash > 0 && slash < safe.length - 1) {
    const basename = graphemes(safe.slice(slash + 1));
    if (basename.length <= max - 2) {
      const headCount = max - 2 - basename.length;
      return `${all.slice(0, headCount).join("")}…/${basename.join("")}`;
    }
  }
  const headCount = Math.ceil((max - 1) / 2);
  const tailCount = Math.floor((max - 1) / 2);
  const tail = tailCount === 0 ? "" : all.slice(all.length - tailCount).join("");
  return `${all.slice(0, headCount).join("")}…${tail}`;
}

/** Cuts the end: at most maxGraphemes graphemes including the "…". Segments only the prefix it
 *  keeps. Bidi and control characters become visible tokens first (displayUntrusted). */
function truncateEnd(text: string, maxGraphemes: number): string {
  const safe = displayUntrusted(text);
  if (safe.length <= maxGraphemes) return safe;
  const kept: string[] = [];
  for (const part of graphemeSegmenter.segment(safe)) {
    if (kept.length === maxGraphemes) {
      kept.pop();
      return `${kept.join("")}…`;
    }
    kept.push(part.segment);
  }
  return safe;
}

function firstLine(text: string): string {
  let start = 0;
  while (start <= text.length) {
    const end = text.indexOf("\n", start);
    const line = (end === -1 ? text.slice(start) : text.slice(start, end)).trim();
    if (line !== "" || end === -1) return line;
    start = end + 1;
  }
  return "";
}

const SHELL_WRAPPER = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/;

/** Trims, unwraps one `bash -lc '…'` or `zsh -lc '…'` wrapper and collapses whitespace: the key
 *  for pairing, evidence attach and "same target" comparisons. */
export function normalizeCommand(command: string): string {
  const trimmed = command.trim();
  const inner = trimmed.match(SHELL_WRAPPER)?.[2] ?? trimmed;
  return inner.trim().replace(/\s+/g, " ");
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Session-relative offset: "+0:39", "+12:05", "+1:02:03". */
export function formatOffset(ms: number): string {
  const totalSeconds = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `+${hours}:${pad2(minutes)}:${pad2(seconds)}`;
  return `+${minutes}:${pad2(seconds)}`;
}

/** Wall-clock time of an ISO timestamp in the viewer's locale; "" when invalid. */
export function formatClock(ts: string, options: { seconds?: boolean } = {}): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    ...(options.seconds === true ? { second: "2-digit" as const } : {}),
  });
}

/** The only duration formatter: "850 ms", "4.5 s", "45 s", "2 m 05 s", "1 h 02 m". */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "";
  const value = Math.max(0, ms);
  if (value < 1000) return `${Math.floor(value)} ms`;
  if (value < 10_000) return `${(Math.floor(value / 100) / 10).toFixed(1)} s`;
  if (value < 60_000) return `${Math.floor(value / 1000)} s`;
  if (value < 3_600_000) {
    const minutes = Math.floor(value / 60_000);
    const seconds = Math.floor((value % 60_000) / 1000);
    return `${minutes} m ${pad2(seconds)} s`;
  }
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  return `${hours} h ${pad2(minutes)} m`;
}

export function agentStateLabel(state: AgentState): string {
  switch (state) {
    case "starting":
      return "Starting";
    case "running":
      return "Working";
    case "waiting_decision":
      return "Needs your decision";
    case "paused":
      return "Paused";
    case "completed":
      return "Completed";
    case "failed":
      return "Stopped with an error";
  }
}

function readable(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** "mcp.github.search_issues" -> "Search Issues". */
export function toolLabel(tool: string): string {
  const parts = tool.split(".");
  return readable(parts[parts.length - 1] ?? tool);
}

export function agentEventLabel(event: NormalizedAgentEvent): string {
  switch (event.type) {
    case "agent_started":
      return "Started working on the task";
    case "agent_message":
      return event.role === "user" ? "Direction received" : event.text;
    case "agent_reasoning":
      return "Thinking";
    case "tool_started":
      return `Using ${toolLabel(event.tool)}`;
    case "tool_completed":
      return `Finished ${toolLabel(event.tool)}`;
    case "command_started":
      return `Running ${event.command}`;
    case "command_completed":
      return event.exitCode < 0
        ? `${event.command} finished (exit code unknown)`
        : `${event.command} finished with exit ${event.exitCode}`;
    case "file_read":
      return `Reading ${truncateMiddle(event.path, 48)}`;
    case "file_changed":
      return `Changed ${truncateMiddle(event.path, 48)}`;
    case "approval_requested":
      return `Approval needed for ${event.command}`;
    case "test_started":
      return `Checking with ${event.command}`;
    case "test_completed":
      return event.exitCode === 0
        ? `${event.command} passed`
        : event.exitCode < 0
          ? `${event.command} finished`
          : `${event.command} failed`;
    case "agent_waiting":
      return "Waiting for direction";
    case "agent_completed":
      return "Turn ended";
    case "agent_failed":
      return `Stopped: ${event.error}`;
    case "agent_interrupted":
      return event.reason === "stop" ? "Stopped" : event.reason === "steer" ? "Redirected" : "Paused";
  }
}

export interface StepHeadlineInput {
  kind: StepKind;
  target?: string;
  text?: string;
  tests?: TestCounts;
  exitCode?: number | null;
  decisionTitle?: string;
  clampIds?: string[];
}

const HEADLINE_MAX = 80;
const COMMAND_MAX = 64;
const PATH_MAX = 48;

/** The instruction line of a structured decision answer ("decision: … instruction:\n  text"). */
const INSTRUCTION_SECTION = /(?:^|\n)instruction:[ \t]*\n[ \t]*(\S[^\n]*)/;

function testsHeadline(command: string, tests: TestCounts): string {
  const total = tests.passed + tests.failed + tests.skipped;
  const counts = total === 0 ? "no tests ran" : `${tests.passed}/${total}`;
  return command === "" ? `Tests · ${counts}` : `${command} · ${counts}`;
}

function runHeadline(command: string, exitCode: number | null | undefined): string {
  return exitCode === null ? `Running ${command}` : command;
}

/** Short title for a step. Details belong in the Inspector (D8). Every agent-supplied string goes
 *  through truncateMiddle or truncateEnd, which call displayUntrusted. */
export function stepHeadline(input: StepHeadlineInput): string {
  const target = input.target ?? "";
  const text = input.text !== undefined ? firstLine(input.text) : "";
  switch (input.kind) {
    case "instruction": {
      const answer = input.text?.match(INSTRUCTION_SECTION)?.[1]?.trim();
      if (answer !== undefined && answer !== "") return truncateEnd(answer, HEADLINE_MAX);
      return text === "" ? "Instruction" : truncateEnd(text, HEADLINE_MAX);
    }
    case "message":
      return text === "" ? "Message" : truncateEnd(text, HEADLINE_MAX);
    case "reasoning":
      return "Thinking";
    case "command":
    case "test":
    case "check": {
      const command = target === "" ? "" : truncateMiddle(normalizeCommand(target), COMMAND_MAX);
      if (input.kind === "test" && input.tests !== undefined) return testsHeadline(command, input.tests);
      if (command === "") return input.kind === "test" ? "Tests" : input.kind === "check" ? "Check" : "Command";
      return runHeadline(command, input.exitCode);
    }
    case "edit":
      return target === "" ? "Edit" : truncateMiddle(target, PATH_MAX);
    case "read":
      return target === "" ? "Read" : `Read ${truncateMiddle(target, PATH_MAX)}`;
    case "tool":
      return target === "" ? "Tool" : truncateMiddle(toolLabel(target), COMMAND_MAX);
    case "approval":
      return target === "" ? "Approval needed" : `Approval needed for ${truncateMiddle(normalizeCommand(target), COMMAND_MAX)}`;
    case "decision":
      return input.decisionTitle !== undefined && input.decisionTitle !== ""
        ? truncateEnd(input.decisionTitle, HEADLINE_MAX)
        : "Decision";
    case "dependency":
      if (text !== "") return truncateEnd(text, HEADLINE_MAX);
      return target === "" ? "Dependencies changed" : `Dependencies in ${truncateMiddle(target, PATH_MAX)}`;
    case "revert":
      return text === "" ? "Revert detected" : truncateEnd(text, HEADLINE_MAX);
    case "lifecycle":
      return text === "" ? "Session event" : truncateEnd(text, HEADLINE_MAX);
    case "guardrail": {
      if (text !== "") return truncateEnd(text, HEADLINE_MAX);
      const count = input.clampIds?.length ?? 0;
      return count === 1 ? "1 guardrail" : `${count} guardrails`;
    }
    case "attention":
      return "Attention scored";
  }
}
