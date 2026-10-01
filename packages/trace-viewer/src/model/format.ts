import type { AgentState, NormalizedAgentEvent } from "@jevcode/contracts";

import type {
  Chapter,
  DecisionDetail,
  Entity,
  GraphicSpec,
  Step,
  StepKind,
  TestCounts,
  TraceSession,
} from "./types.js";

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

/**
 * A span of display-clock offsets, "+0:33 – +0:40", or one offset when both ends read the same at display precision
 * (a point frame reads "+0:43", never "+0:43 – +0:43"). An end before the start reads as the start.
 */
export function formatOffsetRange(startMs: number, endMs: number): string {
  const start = formatOffset(startMs);
  const end = formatOffset(Math.max(startMs, endMs));
  return start === end ? start : `${start} – ${end}`;
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

// ------------------------------------------------------------ mini graphics (D8, R25)

type DurationEnd = Extract<GraphicSpec, { kind: "duration" }>["end"];
type TableEntry = Extract<GraphicSpec, { kind: "table" }>["tables"][number];

/** DiffBar lists at most this many files for a chapter, then "+k" (spec §7.5). */
const DIFF_FILES_MAX = 4;
/** FlowGlyph shows at most this many file stems (spec §7.12). */
const FLOW_NODES_MAX = 3;

function isChapter(target: Step | Chapter): target is Chapter {
  return target.id.startsWith("unit:");
}

function linesChanged(entity: Entity): number {
  return entity.added + entity.removed;
}

/** Per-session lookups for chapter graphics, so an Outline of n chapters costs O(n · own data), not
 *  O(n · (entities + steps)). A finalized TraceSession never changes (spec §6.4). Each part is built on first use:
 *  a Live commit whose rows need no test or fork graphic never indexes the steps. */
interface GraphicLookups {
  /** Entity positions per path, ascending. */
  readonly entitiesByPath: ReadonlyMap<string, readonly number[]>;
  readonly stepPosition: ReadonlyMap<string, number>;
  /** decisionId → position of the first step deciding it (decidedBy set). */
  readonly decidedStep: ReadonlyMap<string, number>;
  /** chapter id → the decision that gave birth to it (bornChapters). */
  readonly bornFrom: Map<string, string>;
}

const LOOKUPS = new WeakMap<TraceSession, GraphicLookups>();

export interface EntityPositions {
  readonly entities: readonly Entity[];
  readonly byPath: ReadonlyMap<string, readonly number[]>;
}

/**
 * Entity positions per path, ascending. From `previous` when the list keeps its paths at their positions (a Live
 * commit replaces an entity in place or appends one): the map is copied and only the new positions are added, so a
 * commit costs O(entities) comparisons instead of a rebuild. Never changes `previous`.
 */
export function entityPositions(entities: readonly Entity[], previous?: EntityPositions): EntityPositions {
  const before = previous?.entities;
  let keeps = previous !== undefined && before !== undefined && entities.length >= before.length;
  if (keeps && before !== undefined) {
    for (let position = 0; position < before.length; position += 1) {
      const entity = entities[position];
      const was = before[position];
      if (entity !== was && entity?.path !== was?.path) {
        keeps = false;
        break;
      }
    }
  }
  if (!keeps || previous === undefined || before === undefined) {
    const byPath = new Map<string, number[]>();
    entities.forEach((entity, position) => {
      const list = byPath.get(entity.path);
      if (list === undefined) byPath.set(entity.path, [position]);
      else list.push(position);
    });
    return { entities, byPath };
  }
  if (entities.length === before.length) return { entities, byPath: previous.byPath };
  const byPath = new Map<string, readonly number[]>(previous.byPath);
  for (let position = before.length; position < entities.length; position += 1) {
    const path = entities[position]?.path ?? "";
    byPath.set(path, [...(byPath.get(path) ?? []), position]);
  }
  return { entities, byPath };
}

export interface StepPositions {
  readonly steps: readonly Step[];
  readonly stepPosition: ReadonlyMap<string, number>;
  /** decisionId → position of the first step deciding it (decidedBy set). */
  readonly decidedStep: ReadonlyMap<string, number>;
}

function decidedSteps(steps: readonly Step[]): Map<string, number> {
  const decidedStep = new Map<string, number>();
  steps.forEach((step, position) => {
    const decision = step.decision;
    if (decision?.decidedBy !== undefined && !decidedStep.has(decision.decisionId)) decidedStep.set(decision.decisionId, position);
  });
  return decidedStep;
}

/**
 * Step positions by id and the first deciding step per decision. From `previous` when the list keeps its ids at their
 * positions: new positions are added to a copy, and the decision map is kept unless a changed or added step carries a
 * decision. Never changes `previous`.
 */
export function stepPositions(steps: readonly Step[], previous?: StepPositions): StepPositions {
  const before = previous?.steps;
  let keeps = previous !== undefined && before !== undefined && steps.length >= before.length;
  let decisions = false;
  if (keeps && before !== undefined) {
    for (let position = 0; position < before.length; position += 1) {
      const step = steps[position];
      const was = before[position];
      if (step === was) continue;
      if (step?.id !== was?.id) {
        keeps = false;
        break;
      }
      if (step?.decision !== undefined || was?.decision !== undefined) decisions = true;
    }
  }
  if (!keeps || previous === undefined || before === undefined) {
    const stepPosition = new Map<string, number>();
    steps.forEach((step, position) => stepPosition.set(step.id, position));
    return { steps, stepPosition, decidedStep: decidedSteps(steps) };
  }
  for (let position = before.length; position < steps.length && !decisions; position += 1) {
    if (steps[position]?.decision !== undefined) decisions = true;
  }
  let stepPosition = previous.stepPosition;
  if (steps.length > before.length) {
    const copy = new Map(previous.stepPosition);
    for (let position = before.length; position < steps.length; position += 1) copy.set(steps[position]?.id ?? "", position);
    stepPosition = copy;
  }
  return { steps, stepPosition, decidedStep: decisions ? decidedSteps(steps) : previous.decidedStep };
}

/**
 * The latest session's positions, so the next Live session derives its own from them (one generation kept). Held
 * weakly: the session's own lookups keep them alive while it is, and a closed view's session is not retained here.
 */
let lastEntityPositions: WeakRef<EntityPositions> | undefined;
let lastStepPositions: WeakRef<StepPositions> | undefined;

/** Drops the slots, so the next lookups are built from scratch. For tests that compare against a fresh build. */
export function resetGraphicLookups(): void {
  lastEntityPositions = undefined;
  lastStepPositions = undefined;
}

function lazyLookups(session: TraceSession): GraphicLookups {
  let entitiesByPath: ReadonlyMap<string, readonly number[]> | undefined;
  let steps: StepPositions | undefined;
  let bornFrom: Map<string, string> | undefined;
  const stepMaps = (): StepPositions => {
    if (steps !== undefined) return steps;
    steps = stepPositions(session.steps, lastStepPositions?.deref());
    lastStepPositions = new WeakRef(steps);
    return steps;
  };
  return {
    get entitiesByPath() {
      if (entitiesByPath !== undefined) return entitiesByPath;
      const positions = entityPositions(session.entities, lastEntityPositions?.deref());
      lastEntityPositions = new WeakRef(positions);
      return (entitiesByPath = positions.byPath);
    },
    get stepPosition() {
      return stepMaps().stepPosition;
    },
    get decidedStep() {
      return stepMaps().decidedStep;
    },
    get bornFrom() {
      return (bornFrom ??= bornChapters(session));
    },
  };
}

/**
 * The step with this id in session.steps (the last one when ids repeat), through the session's position index, which
 * a Live commit derives from the previous session's instead of mapping every step again.
 */
export function sessionStep(session: TraceSession, id: string): Step | undefined {
  const position = lookupsOf(session).stepPosition.get(id);
  return position === undefined ? undefined : session.steps[position];
}

function lookupsOf(session: TraceSession): GraphicLookups {
  let lookups = LOOKUPS.get(session);
  if (lookups === undefined) {
    lookups = lazyLookups(session);
    LOOKUPS.set(session, lookups);
  }
  return lookups;
}

/** The chapter's file entities, in first-edit order (buildEntities builds them in step order). */
function chapterEntities(chapter: Chapter, session: TraceSession): Entity[] {
  const { entitiesByPath } = lookupsOf(session);
  const positions = new Set<number>();
  for (const file of chapter.files) for (const position of entitiesByPath.get(file) ?? []) positions.add(position);
  return [...positions].sort((a, b) => a - b).flatMap((position) => session.entities[position] ?? []);
}

/** Chapter.schema (spec §6.6): one entry per table named by a table/model item or by the prefix
 *  before the last "." of a column/field item; null without schema data. */
function tableSpec(chapter: Chapter): GraphicSpec | null {
  const tables = new Map<string, TableEntry>();
  const tableFor = (name: string): TableEntry => {
    let table = tables.get(name);
    if (table === undefined) {
      table = { name, role: "altered", columns: 0 };
      tables.set(name, table);
    }
    return table;
  };
  for (const change of chapter.schemaChanges) {
    if (change.entityType === "table" || change.entityType === "model") {
      const table = tableFor(change.entity);
      if (change.change === "added") table.role = "new";
      continue;
    }
    if (change.entityType !== "column" && change.entityType !== "field") continue;
    const dot = change.entity.lastIndexOf(".");
    if (dot <= 0) continue;
    tableFor(change.entity.slice(0, dot)).columns += 1;
  }
  return tables.size === 0 ? null : { kind: "table", tables: [...tables.values()] };
}

function fileStem(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** FlowGlyph (spec §7.12): up to 3 file stems in first-edit order; focus = most lines changed. */
function flowSpec(chapter: Chapter, session: TraceSession): GraphicSpec | null {
  const nodes = chapterEntities(chapter, session).slice(0, FLOW_NODES_MAX);
  if (nodes.length === 0) return null;
  let focus = 0;
  nodes.forEach((entity, index) => {
    const best = nodes[focus];
    if (best !== undefined && linesChanged(entity) > linesChanged(best)) focus = index;
  });
  return { kind: "flow", nodes: nodes.map((entity) => fileStem(entity.path)), focus };
}

/** TestDots for a tests chapter: the latest run with a test result among the steps its
 *  validations attached to and its joined steps. */
function chapterTestsSpec(chapter: Chapter, session: TraceSession): GraphicSpec | null {
  const { stepPosition } = lookupsOf(session);
  let latest = -1;
  for (const id of [...chapter.validationStepIds, ...chapter.stepIds]) {
    const position = stepPosition.get(id) ?? -1;
    if (position > latest && session.steps[position]?.tests !== undefined) latest = position;
  }
  const tests = session.steps[latest]?.tests;
  return tests === undefined
    ? null
    : { kind: "tests", passed: tests.passed, failed: tests.failed, skipped: tests.skipped };
}

function forkSpec(decision: DecisionDetail): GraphicSpec {
  return {
    kind: "fork",
    options: decision.options.map((option) => ({ label: option.label, chosen: option.chosen })),
    decidedBy: decision.decidedBy ?? "open",
  };
}

/**
 * Decision-born chapters (the Outline's one-row rule, §7.1): for each decision step in order, the earliest current,
 * non-noise chapter of the same turn that lists the decision and starts at or after it, unless an earlier decision
 * already took that chapter. A chapter that links the decision but starts before it (oauth's Identity layer) is not
 * born from it.
 */
function bornChapters(session: TraceSession): Map<string, string> {
  const bornFrom = new Map<string, string>();
  for (const step of session.steps) {
    const decisionId = step.decision?.decisionId;
    if (step.kind !== "decision" || decisionId === undefined) continue;
    const stableId = `decision:${decisionId}`;
    const nextTurnT = session.turns[step.turnIndex + 1]?.tMs ?? Number.POSITIVE_INFINITY;
    let born: Chapter | undefined;
    for (const chapter of session.chapters) {
      if (!chapter.current || chapter.noise || bornFrom.has(chapter.id)) continue;
      if (chapter.tMs < step.tMs || chapter.tMs >= nextTurnT || !chapter.decisionIds.some((id) => id === stableId)) continue;
      if (born === undefined || chapter.tMs < born.tMs) born = chapter;
    }
    if (born !== undefined) bornFrom.set(born.id, decisionId);
  }
  return bornFrom;
}

export interface PickGraphicOptions {
  /**
   * Spec §7.12 refinement (C3-6 ruling): whether the decision already shows its fork next to the chapter, as its own
   * Canvas frame, Outline row or spine row at the same level. Default: yes, since every surface that lists chapters
   * also lists decision steps. A surface that shows one chapter alone (the Inspector) passes `() => false`.
   */
  decisionShown?(decisionId: string): boolean;
}

/** ForkGlyph for the chapter born from an answered or delegated decision, only where the decision is not shown. */
function chapterForkSpec(chapter: Chapter, session: TraceSession, options: PickGraphicOptions): GraphicSpec | null {
  if (chapter.decisionIds.length === 0) return null;
  const lookups = lookupsOf(session);
  const decisionId = lookups.bornFrom.get(chapter.id);
  if (decisionId === undefined || (options.decisionShown?.(decisionId) ?? true)) return null;
  const decision = session.steps[lookups.decidedStep.get(decisionId) ?? -1]?.decision;
  return decision === undefined ? null : forkSpec(decision);
}

/** DiffBar list: totals over the chapter's files, the top 4 by lines changed (ties by path), and
 *  how many more there are. */
function diffListSpec(chapter: Chapter, session: TraceSession): GraphicSpec | null {
  const entities = chapterEntities(chapter, session);
  if (entities.length === 0) return null;
  const ranked = [...entities].sort(
    (a, b) => linesChanged(b) - linesChanged(a) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  return {
    kind: "diff",
    added: entities.reduce((sum, entity) => sum + entity.added, 0),
    removed: entities.reduce((sum, entity) => sum + entity.removed, 0),
    files: ranked.slice(0, DIFF_FILES_MAX).map((entity) => ({ path: entity.path, added: entity.added, removed: entity.removed })),
    ...(ranked.length > DIFF_FILES_MAX ? { moreFiles: ranked.length - DIFF_FILES_MAX } : {}),
  };
}

/** spec §7.12 CHAPTER_GRAPHIC: the first rule that matches; a rule without data falls through. */
function chapterGraphic(chapter: Chapter, session: TraceSession, options: PickGraphicOptions): GraphicSpec | null {
  let spec: GraphicSpec | null = null;
  if (chapter.category === "schema") spec = tableSpec(chapter);
  else if (chapter.category === "architecture" || chapter.category === "api") spec = flowSpec(chapter, session);
  else if (chapter.category === "tests") spec = chapterTestsSpec(chapter, session);
  return spec ?? chapterForkSpec(chapter, session, options) ?? diffListSpec(chapter, session);
}

function durationSpec(step: Step): GraphicSpec {
  const running = step.status === "running";
  const exitCode = step.command?.exitCode ?? null;
  const end: DurationEnd =
    (step.kind === "test" || step.kind === "check") && step.status === "failed"
      ? "bad_dot"
      : step.kind === "command" && exitCode !== null && exitCode > 0
        ? "exit_x"
        : "none";
  return { kind: "duration", durationMs: running ? null : step.durationMs, running, status: step.status, end };
}

/** The mini graphic (D8) that replaces prose for a step or chapter, or null when none fits. */
export function pickGraphic(target: Step | Chapter, session: TraceSession, options: PickGraphicOptions = {}): GraphicSpec | null {
  if (isChapter(target)) return chapterGraphic(target, session, options);
  const step = target;
  const finding = session.findings.find(
    (candidate) => candidate.ruleId === "claim_contradicted" && candidate.claim?.claim.stepId === step.id,
  );
  const claim = finding?.claim;
  if (claim !== undefined) {
    return {
      kind: "claim",
      claim: {
        text: claim.claim.text,
        ...(finding?.claimSpan !== undefined ? { span: finding.claimSpan } : {}),
        tMs: claim.claim.tMs,
      },
      observed: {
        passed: claim.observed.passed,
        failed: claim.observed.failed,
        command: claim.observed.command,
        tMs: claim.observed.tMs,
      },
    };
  }
  if (step.edit !== undefined) return { kind: "diff", added: step.edit.added, removed: step.edit.removed };
  if (step.tests !== undefined) {
    return { kind: "tests", passed: step.tests.passed, failed: step.tests.failed, skipped: step.tests.skipped };
  }
  if (step.decision !== undefined) return forkSpec(step.decision);
  if (step.command !== undefined) return durationSpec(step);
  return null;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Text alternative for a graphic (screen readers, tooltips, copy). */
export function describeGraphic(spec: GraphicSpec): string {
  switch (spec.kind) {
    case "diff": {
      const counts = `+${spec.added} −${spec.removed}`;
      const files = spec.files === undefined ? 0 : spec.files.length + (spec.moreFiles ?? 0);
      return files > 0 ? `${counts} in ${plural(files, "file")}` : counts;
    }
    case "tests":
      return `${spec.passed} passed, ${spec.failed} failed${spec.skipped > 0 ? `, ${spec.skipped} skipped` : ""}`;
    case "duration":
      if (spec.running) return "running";
      return spec.durationMs === null ? spec.status : `${formatDuration(spec.durationMs)}, ${spec.status}`;
    case "fork": {
      const chosen = spec.options.filter((option) => option.chosen).map((option) => option.label);
      const who = spec.decidedBy === "supervisor" ? "you chose" : spec.decidedBy === "delegated" ? "delegated:" : "open";
      return `${plural(spec.options.length, "option")}; ${who}${chosen.length > 0 ? ` ${chosen.join(", ")}` : ""}`;
    }
    case "flow":
      return spec.nodes.join(" → ");
    case "table":
      return spec.tables
        .map((table) => `${table.name} (${table.role}${table.columns > 0 ? `, ${plural(table.columns, "column")}` : ""})`)
        .join("; ");
    case "claim":
      return `Claimed "${spec.claim.text}"; ${spec.observed.command} had ${spec.observed.passed} passed, ${spec.observed.failed} failed`;
  }
}
