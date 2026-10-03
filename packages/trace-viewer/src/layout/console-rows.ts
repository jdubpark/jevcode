import type { NarrativeSentence } from "@jevcode/contracts";

import { agentEventLabel, type Finding, type FindingId, type Step, type StepId, type TraceSession, type Turn } from "../model/index.js";
import { anchoredFindings } from "./tone.js";
import type { TraceIndex } from "./trace-index.js";

/** One Console row (spec §3.2; interfaces §6.3). Keys come from step ids and finding ids, so they survive refolds. */
export type ConsoleRow =
  | { kind: "instruction"; key: string; stepId: string; text: string; mode: "steer" | "queue" | "start" }
  | { kind: "message"; key: string; stepId: string; text: string }
  | { kind: "reasoning"; key: string; stepId: string; ms: number | null }
  | { kind: "tool"; key: string; stepId: string; name: string; args: string; status: "running" | "ok" | "failed"; ms: number | null }
  | { kind: "command"; key: string; stepId: string; command: string; outputTail: string[]; exitCode: number | null; running: boolean; ms: number | null }
  | { kind: "reads"; key: string; stepIds: string[]; paths: string[] }
  | { kind: "edit"; key: string; stepId: string; path: string; added: number; removed: number }
  | { kind: "tests"; key: string; stepId: string; passed: number; failed: number; failing: string[] }
  | { kind: "decision"; key: string; stepId: string; decisionId: string; question: string; options: { id: string; label: string }[]; status: "pending" | "answered"; answer: string | null }
  | { kind: "lifecycle"; key: string; stepId: string; state: "waiting" | "completed" | "failed" | "interrupted"; text: string }
  | { kind: "finding"; key: string; stepId: string; findingId: string }
  /** Consecutive warning guardrail-clamp flag lines folded into one "Jev review · n guardrails" line (V-4 fix round 1). */
  | { kind: "guardrails"; key: string; stepIds: string[]; findingIds: string[]; findingStepIds: string[] }
  | { kind: "summary"; key: string; sentences: NarrativeSentence[]; provenance?: "rule" | "model" };

export interface ConsoleRowsState {
  rows: readonly ConsoleRow[];
  /** Step id → the row that shows it: its own row, its read group, or the finding row of a Jev step. */
  byStep: ReadonlyMap<string, number>;
}

/** Output lines a command row shows before it is expanded (spec §3.2). */
export const CONSOLE_TAIL_LINES = 8;

type ReadsRow = Extract<ConsoleRow, { kind: "reads" }>;
type GuardrailsRow = Extract<ConsoleRow, { kind: "guardrails" }>;

/** The step ids a row stands for: a read group's reads, a guardrail fold's steps, nothing for a summary, else its one step. */
export function consoleRowStepIds(row: ConsoleRow): readonly string[] {
  if (row.kind === "reads" || row.kind === "guardrails") return row.stepIds;
  if (row.kind === "summary") return [];
  return [row.stepId];
}

/**
 * Rows that arrived after `afterSeq`, counted back from the end (the Console's "N new" pill): a row is new when its
 * first step starts after it. A read group counts once and a silent Jev step not at all, unlike the step count.
 */
export function consoleNewRowCount(state: ConsoleRowsState, index: TraceIndex, afterSeq: number): number {
  let count = 0;
  for (let i = state.rows.length - 1; i >= 0; i -= 1) {
    const row = state.rows[i];
    const first = row === undefined ? undefined : consoleRowStepIds(row)[0];
    if (first === undefined) continue;
    const entry = index.entry(first);
    if (entry === undefined || entry.firstSeq <= afterSeq) break;
    count += 1;
  }
  return count;
}

interface StepPiece {
  /** The step's own row; null for a read (it joins a group) and for guardrail and attention steps. */
  own: ConsoleRow | null;
  /** A read step's path. */
  readPath: string | null;
  /** One flag row per finding anchored on the step, in FINDING_ORDER. */
  findings: readonly ConsoleRow[];
}

interface CachedPiece {
  step: Step;
  findingsById: ReadonlyMap<FindingId, Finding>;
  piece: StepPiece;
}

interface Cache {
  session: TraceSession;
  findingsById: ReadonlyMap<FindingId, Finding>;
  pieces: ReadonlyMap<string, CachedPiece>;
  reads: ReadonlyMap<string, ReadsRow>;
  folds: ReadonlyMap<string, GuardrailsRow>;
}

/** Per returned state, so ConsoleRowsState keeps the interface shape (deviation 12). */
const CACHE = new WeakMap<ConsoleRowsState, Cache>();
const NO_FINDINGS: readonly ConsoleRow[] = [];
const WAITING_TEXT = agentEventLabel({ type: "agent_waiting", sessionId: "", ts: "" });

function tailLines(text: string | undefined, max: number): string[] {
  if (text === undefined || text === "") return [];
  const all = text.split(/\r?\n/);
  while (all.length > 0 && all[all.length - 1] === "") all.pop();
  return all.slice(-max);
}

function instructionMode(step: Step, turnByStart: ReadonlyMap<number, Turn>): "steer" | "queue" | "start" {
  for (const seq of step.seqs) {
    const turn = turnByStart.get(seq);
    if (turn === undefined) continue;
    if (turn.index !== step.turnIndex) return "queue";
    return turn.trigger === "steer" ? "steer" : "start";
  }
  return "queue";
}

function lifecycleState(step: Step): "waiting" | "completed" | "failed" | "interrupted" {
  if (step.status === "failed") return "failed";
  if (step.status === "ok") return "completed";
  return step.headline === WAITING_TEXT ? "waiting" : "interrupted";
}

function commandRow(step: Step): ConsoleRow {
  return {
    kind: "command",
    key: step.id,
    stepId: step.id,
    command: step.command?.command ?? step.target ?? "",
    outputTail: tailLines(step.command?.outputTail, CONSOLE_TAIL_LINES),
    exitCode: step.command?.exitCode ?? null,
    running: step.status === "running",
    // A running step's durationMs is live elapsed time; the row keeps ms for finished work only.
    ms: step.status === "running" ? null : step.durationMs,
  };
}

function decisionRow(step: Step): ConsoleRow {
  const decision = step.decision;
  if (decision === undefined) return { kind: "lifecycle", key: step.id, stepId: step.id, state: "waiting", text: step.headline };
  const chosen = decision.options.filter((option) => option.chosen).map((option) => option.label);
  return {
    kind: "decision",
    key: step.id,
    stepId: step.id,
    decisionId: decision.decisionId,
    question: decision.title,
    options: decision.options.map((option) => ({ id: option.id, label: option.label })),
    status: decision.status === "open" ? "pending" : "answered",
    answer: chosen.length === 0 ? null : chosen.join(", "),
  };
}

function ownRow(step: Step, turnByStart: ReadonlyMap<number, Turn>): ConsoleRow | null {
  const key = step.id;
  const stepId = step.id;
  switch (step.kind) {
    case "instruction":
      return { kind: "instruction", key, stepId, text: step.text ?? step.headline, mode: instructionMode(step, turnByStart) };
    case "message":
      return { kind: "message", key, stepId, text: step.text ?? "" };
    case "reasoning":
      return { kind: "reasoning", key, stepId, ms: step.durationMs };
    case "tool":
      return {
        kind: "tool",
        key,
        stepId,
        name: step.target ?? "tool",
        args: "",
        status: step.status === "running" ? "running" : step.status === "failed" ? "failed" : "ok",
        ms: step.status === "running" || step.status === "unknown" ? null : step.durationMs,
      };
    case "test":
      if (step.tests !== undefined) {
        return {
          kind: "tests",
          key,
          stepId,
          passed: step.tests.passed,
          failed: step.tests.failed,
          failing: step.tests.failures.map((failure) => failure.testName),
        };
      }
      return commandRow(step);
    case "command":
    case "check":
      return commandRow(step);
    case "edit":
    case "dependency":
    case "revert":
      return {
        kind: "edit",
        key,
        stepId,
        path: step.edit?.path ?? step.target ?? step.headline,
        added: step.edit?.added ?? 0,
        removed: step.edit?.removed ?? 0,
      };
    case "decision":
      return decisionRow(step);
    case "approval":
      return { kind: "lifecycle", key, stepId, state: "waiting", text: step.headline };
    case "lifecycle":
      return { kind: "lifecycle", key, stepId, state: lifecycleState(step), text: step.headline };
    case "read":
    case "guardrail":
    case "attention":
      return null;
  }
}

function pieceOf(step: Step, turnByStart: ReadonlyMap<number, Turn>, findingsById: ReadonlyMap<FindingId, Finding>): StepPiece {
  const anchored = step.findingIds.length === 0 ? [] : anchoredFindings(step, findingsById);
  const findings: readonly ConsoleRow[] = anchored.length === 0
    ? NO_FINDINGS
    : anchored.map((finding): ConsoleRow => ({ kind: "finding", key: finding.id, stepId: step.id, findingId: finding.id }));
  if (step.kind === "read") return { own: null, readPath: step.target ?? step.headline, findings };
  return { own: ownRow(step, turnByStart), readPath: null, findings };
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * The Console rows of a session (spec §8.2). Pure and React-free. With `prev` (the state this function returned for
 * an earlier commit of the same session), steps whose objects did not change keep their row objects; the result
 * always equals a fresh build.
 */
export function buildConsoleRows(session: TraceSession, index: TraceIndex, prev?: ConsoleRowsState): ConsoleRowsState {
  const findingsById = index.findingsById;
  const cache = prev === undefined ? undefined : CACHE.get(prev);
  if (prev !== undefined && cache !== undefined && cache.session === session && cache.findingsById === findingsById) return prev;

  const turnByStart = new Map<number, Turn>();
  for (const turn of session.turns) turnByStart.set(turn.startSeq, turn);
  const pieces = new Map<string, CachedPiece>();
  const reads = new Map<string, ReadsRow>();
  const rows: ConsoleRow[] = [];
  const byStep = new Map<string, number>();
  let group: { stepIds: StepId[]; paths: string[]; turnIndex: number } | null = null;

  const closeGroup = (): void => {
    const open = group;
    if (open === null) return;
    group = null;
    const key = `reads:${open.stepIds[0] ?? ""}`;
    const old = cache?.reads.get(key);
    const row: ReadsRow =
      old !== undefined && sameStrings(old.stepIds, open.stepIds) && sameStrings(old.paths, open.paths)
        ? old
        : { kind: "reads", key, stepIds: open.stepIds, paths: open.paths };
    reads.set(key, row);
    const at = rows.length;
    rows.push(row);
    for (const id of open.stepIds) byStep.set(id, at);
  };

  // A run of warning guardrail flag lines (no other row between them) folds into one row; a critical one never does.
  const foldable = (row: ConsoleRow): row is Extract<ConsoleRow, { kind: "finding" }> => {
    if (row.kind !== "finding") return false;
    const finding = findingsById.get(row.findingId as FindingId);
    return finding?.ruleId === "guardrail_clamp" && finding.severity !== "critical";
  };
  const runs: { at: number; stepIds: string[]; findingIds: string[]; findingStepIds: string[] }[] = [];
  const pushFindings = (stepId: string, findings: readonly ConsoleRow[]): void => {
    for (const row of findings) {
      const run = runs.at(-1);
      if (foldable(row) && run !== undefined && run.at === rows.length - 1) {
        if (!run.stepIds.includes(stepId)) run.stepIds.push(stepId);
        run.findingIds.push(row.findingId);
        run.findingStepIds.push(stepId);
        if (!byStep.has(stepId)) byStep.set(stepId, run.at);
        continue;
      }
      if (!byStep.has(stepId)) byStep.set(stepId, rows.length);
      if (foldable(row)) runs.push({ at: rows.length, stepIds: [stepId], findingIds: [row.findingId], findingStepIds: [stepId] });
      rows.push(row);
    }
  };

  for (const step of session.steps) {
    const old = cache?.pieces.get(step.id);
    const reusable =
      old !== undefined &&
      old.step === step &&
      step.kind !== "instruction" &&
      (step.findingIds.length === 0 || old.findingsById === findingsById);
    const entry: CachedPiece = reusable ? old : { step, findingsById, piece: pieceOf(step, turnByStart, findingsById) };
    pieces.set(step.id, entry);
    const piece = entry.piece;

    if (piece.readPath !== null) {
      if (group !== null && group.turnIndex !== step.turnIndex) closeGroup();
      const current: { stepIds: StepId[]; paths: string[]; turnIndex: number } =
        group ?? { stepIds: [], paths: [], turnIndex: step.turnIndex };
      group = current;
      current.stepIds.push(step.id);
      current.paths.push(piece.readPath);
      if (piece.findings.length > 0) {
        closeGroup();
        pushFindings(step.id, piece.findings);
      }
      continue;
    }
    // A guardrail or attention step with no anchored finding is Jev's, not the agent's: no row, and a read group
    // around it stays one group.
    if (piece.own === null && piece.findings.length === 0) continue;
    closeGroup();
    if (piece.own !== null) {
      byStep.set(step.id, rows.length);
      rows.push(piece.own);
    }
    pushFindings(step.id, piece.findings);
  }
  closeGroup();

  const folds = new Map<string, GuardrailsRow>();
  for (const run of runs) {
    if (run.findingIds.length < 2) continue;
    const key = `guardrails:${run.findingIds[0] ?? ""}`;
    const old = cache?.folds.get(key);
    const row: GuardrailsRow =
      old !== undefined && sameStrings(old.stepIds, run.stepIds) && sameStrings(old.findingIds, run.findingIds) && sameStrings(old.findingStepIds, run.findingStepIds)
        ? old
        : { kind: "guardrails", key, stepIds: run.stepIds, findingIds: run.findingIds, findingStepIds: run.findingStepIds };
    folds.set(key, row);
    rows[run.at] = row;
  }

  const state: ConsoleRowsState = { rows, byStep };
  CACHE.set(state, { session, findingsById, pieces, reads, folds });
  return state;
}
