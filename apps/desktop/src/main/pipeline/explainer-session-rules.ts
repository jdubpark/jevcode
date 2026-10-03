import type { ChangeUnit, Citation, Decision, ExplainerRecord, NarrativeSentence } from "@jevcode/contracts";
import {
  NarratorUnavailableError,
  SESSION_LIMITS,
  plainTextViolation,
  type DecisionWhyInput,
  type SessionStoryInput,
} from "@jevcode/jev-router";
import { componentIdForPath, truncateMiddle, type OverviewModel, type Step, type TraceSession } from "@jevcode/trace-viewer/model";

import { NARRATOR_BACKOFF_MS } from "./explainer-narration.js";

// Rule-based parts of the session explainer (spec §6.1, §6.5): highlights, narrator inputs and the
// rule-based story used when the narrator is off, offline or its output is dropped. Pure.

export const STORY_MIN_INTERVAL_MS = 20_000;
/** S-1's story state shows this many steps; the input never holds more, so the guard sees what the model saw. */
export const STORY_RECENT_STEPS = SESSION_LIMITS.steps;
export const STORY_UNIT_THRESHOLD = 3;
export const DECISION_NEARBY = SESSION_LIMITS.nearby;
/** ExplainerRecordSchema caps decision and unit ids at 128 characters. */
export const EXPLAINER_ID_MAX = 128;

const MAX_HIGHLIGHTS = 200;
const MAX_UNIT_IDS = 50;
const MAX_CITATIONS = 6;
/** CitationSchema caps ids at 512 characters. */
const CITATION_ID_MAX = 512;
/** NarrativeSentenceSchema caps text at 220 characters. */
const SENTENCE_MAX = 220;
const RULE_NAME_MAX = 40;
const RULE_NAMES_SHOWN = 3;
const RULE_MAX_SENTENCES = 6;

export type HighlightEntry = Extract<ExplainerRecord, { kind: "highlights" }>["components"][number];
type HighlightState = HighlightEntry["state"];

/** Spec §3.4: a card shows its strongest session state; red only for failures. */
const STATE_RANK: Readonly<Record<HighlightState, number>> = { changed: 0, new: 1, decision: 2, failing: 3 };

/** N-3's table (30 s, 2 min, 10 min, then 10 min), shared by every narrator call (spec §6.6). */
export function backoffMs(failures: number): number {
  const index = Math.min(Math.max(failures, 1), NARRATOR_BACKOFF_MS.length) - 1;
  return NARRATOR_BACKOFF_MS[index] ?? 600_000;
}

/** Lane 05's failure code for a call record or log: the reason, never the provider's message. */
export function failureReason(error: unknown): string {
  return error instanceof NarratorUnavailableError ? error.reason : "unavailable";
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Descending order of numbers, with -Infinity for NaN. */
function newestFirst(a: number, b: number): number {
  const x = Number.isNaN(a) ? Number.NEGATIVE_INFINITY : a;
  const y = Number.isNaN(b) ? Number.NEGATIVE_INFINITY : b;
  return x === y ? 0 : x < y ? 1 : -1;
}

/**
 * Change units and test failures carry the path the agent used, often absolute; the model's path rule
 * (lane 06's componentIdForPath) needs repo-relative paths. Strips the repo root and any leading "./".
 * A path outside the repo stays absolute, and the path rule gives it no component.
 */
export function repoRelative(repoRoot: string, path: string): string {
  const prefix = `${repoRoot.replace(/\/+$/, "")}/`;
  let relative = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  while (relative.startsWith("./")) relative = relative.slice(2);
  return relative;
}

/**
 * The latest settled run of each test or check command, in seq order. Read from the session's steps
 * (the test_result fact joins its own command step), not from change-unit attachment.
 */
export function latestTestRuns(session: TraceSession): Step[] {
  const latest = new Map<string, Step>();
  for (const step of session.steps) {
    if (step.tests === undefined || step.status === "running") continue;
    latest.set(step.target ?? step.id, step);
  }
  return [...latest.values()].sort((a, b) => a.firstSeq - b.firstSeq);
}

/** Files of the failing tests in the latest run of each command. */
export function failingTestFiles(session: TraceSession): Set<string> {
  const files = new Set<string>();
  for (const step of latestTestRuns(session)) {
    if (step.tests === undefined || step.tests.failed === 0) continue;
    for (const failure of step.tests.failures) files.add(failure.file);
  }
  return files;
}

export interface HighlightInput {
  units: readonly ChangeUnit[];
  decisions: readonly Decision[];
  overview: OverviewModel | null;
  /** Component ids of the first overview snapshot the session folded; null before one arrives. */
  initialComponentIds: ReadonlySet<string> | null;
  failingFiles: ReadonlySet<string>;
}

export function computeHighlights(input: HighlightInput): HighlightEntry[] {
  const overview = input.overview;
  if (overview === null) return [];
  const components = overview.snapshot.components;
  const repoRoot = overview.snapshot.repoRoot;
  // Interfaces §8.4 R6: null for a path outside the repo or a nested path no component claims.
  const componentOf = (file: string): string | null => componentIdForPath(components, repoRelative(repoRoot, file));
  const decided = new Set<string>();
  for (const decision of input.decisions) for (const unitId of decision.affectedChangeUnits) decided.add(unitId);
  const byComponent = new Map<string, { state: HighlightState; unitIds: Set<string> }>();
  const mark = (componentId: string, state: HighlightState, unitId: string | null): void => {
    const entry = byComponent.get(componentId) ?? { state, unitIds: new Set<string>() };
    if (STATE_RANK[state] > STATE_RANK[entry.state]) entry.state = state;
    if (unitId !== null && unitId.length <= EXPLAINER_ID_MAX) entry.unitIds.add(unitId);
    byComponent.set(componentId, entry);
  };
  for (const unit of input.units) {
    if (unit.status === "superseded") continue;
    const unitState: HighlightState =
      unit.status === "failed" ? "failing" : decided.has(unit.id) || unit.relatedDecisions.length > 0 ? "decision" : "changed";
    for (const file of unit.files) {
      const componentId = componentOf(file);
      if (componentId === null) continue;
      const isNew = input.initialComponentIds !== null && !input.initialComponentIds.has(componentId);
      mark(componentId, unitState === "changed" && isNew ? "new" : unitState, unit.id);
    }
  }
  for (const file of input.failingFiles) {
    const componentId = componentOf(file);
    if (componentId !== null) mark(componentId, "failing", null);
  }
  return [...byComponent.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .slice(0, MAX_HIGHLIGHTS)
    .map(([id, entry]) => ({ id, state: entry.state, unitIds: [...entry.unitIds].sort(compareText).slice(0, MAX_UNIT_IDS) }));
}

/** The chosen option's label (never its id), by the viewer's rule (fold-chapters decisionDetail); null when none. */
export function chosenLabel(decision: Decision): string | null {
  const chosen = new Set(Object.values(decision.answer?.decision ?? {}));
  const labels = decision.options.filter((option) => chosen.has(option.id)).map((option) => option.label);
  return labels.length > 0 ? labels.join(", ") : null;
}

/**
 * Open decisions first, then the newest (the seq of the decision's latest row, then its ts), capped at
 * S-1's 20, so the cap never drops an open decision for an old answered one.
 */
export function storyDecisions(session: TraceSession, decisions: readonly Decision[]): Decision[] {
  const lastSeq = new Map<string, number>();
  for (const step of session.steps) if (step.decision !== undefined) lastSeq.set(step.decision.decisionId, step.lastSeq);
  return decisions
    .map((decision, index) => ({
      decision,
      index,
      // A decision the fold has not reached yet is newer than every folded one.
      seq: lastSeq.get(decision.id) ?? Number.POSITIVE_INFINITY,
      ts: Date.parse(decision.ts ?? ""),
    }))
    .sort(
      (a, b) =>
        Number(b.decision.status === "open") - Number(a.decision.status === "open") ||
        newestFirst(a.seq, b.seq) ||
        newestFirst(a.ts, b.ts) ||
        b.index - a.index,
    )
    .slice(0, SESSION_LIMITS.decisions)
    .map((entry) => entry.decision);
}

export function sessionStoryInput(
  session: TraceSession,
  decisions: readonly Decision[],
  highlights: readonly HighlightEntry[],
): SessionStoryInput {
  const recent: Step[] = [];
  for (let i = session.steps.length - 1; i >= 0 && recent.length < STORY_RECENT_STEPS; i -= 1) {
    const step = session.steps[i];
    // Lifecycle steps are noise in the views, but completion and failure must change the story's input.
    if (step !== undefined && (step.noise === null || step.kind === "lifecycle")) recent.push(step);
  }
  recent.reverse();
  const runs = latestTestRuns(session);
  const lastRun = runs.at(-1);
  const tests =
    lastRun === undefined
      ? null
      : {
          ...runs.reduce(
            (sum, step) => ({ passed: sum.passed + (step.tests?.passed ?? 0), failed: sum.failed + (step.tests?.failed ?? 0) }),
            { passed: 0, failed: 0 },
          ),
          stepId: lastRun.id,
        };
  const names = session.overview?.componentById;
  const touched = [...highlights]
    .sort((a, b) => STATE_RANK[b.state] - STATE_RANK[a.state] || compareText(a.id, b.id))
    .slice(0, SESSION_LIMITS.components);
  return {
    prompt: session.meta.prompt,
    recentSteps: recent.map((step) => ({ id: step.id, headline: step.headline })),
    decisions: storyDecisions(session, decisions).map((decision) => ({
      id: decision.id,
      title: decision.title,
      status: decision.status,
      answer: decision.status === "open" ? null : chosenLabel(decision),
    })),
    tests,
    touchedComponents: touched.map((entry) => ({ id: entry.id, name: names?.get(entry.id)?.name ?? entry.id })),
  };
}

/** The decision, its options, the chosen label, who chose and the agent messages nearest the answer (spec §6.2). */
export function decisionWhyInput(session: TraceSession, decision: Decision): DecisionWhyInput | null {
  const step = session.steps.find((candidate) => candidate.decision?.decisionId === decision.id);
  if (step?.decision === undefined) return null;
  const answerSeq = step.decision.answerSeq ?? step.lastSeq;
  const plans = new Set<string>();
  for (const turn of session.turns) if (turn.planStepId !== undefined) plans.add(turn.planStepId);
  const nearby = session.steps
    .filter((candidate) => candidate.kind === "message" && candidate.actor === "agent" && (candidate.text ?? "").trim() !== "")
    .map((candidate) => ({ candidate, distance: Math.abs(candidate.firstSeq - answerSeq) }))
    .sort((a, b) => a.distance - b.distance || a.candidate.firstSeq - b.candidate.firstSeq)
    .slice(0, DECISION_NEARBY)
    .map(({ candidate }) => ({
      id: candidate.id,
      kind: plans.has(candidate.id) ? ("step" as const) : ("message" as const),
      text: candidate.text ?? "",
    }));
  const delegated = decision.status === "delegated";
  const answer = chosenLabel(decision) ?? (delegated ? "Delegated to the agent" : "No answer recorded");
  return {
    decisionId: decision.id,
    title: decision.title,
    options: decision.options.map((option) => ({ id: option.id, label: option.label })),
    answer,
    chosenBy: delegated ? "agent" : "developer",
    nearby,
  };
}

function plural(count: number, word: string): string {
  return `${count} ${count === 1 ? word : `${word}s`}`;
}

function citable(id: string): boolean {
  return id.length > 0 && id.length <= CITATION_ID_MAX;
}

/** Factual sentences from rule-based data; every citation names an id the session holds. */
export function ruleStory(
  session: TraceSession,
  input: SessionStoryInput,
  units: readonly ChangeUnit[],
  highlights: readonly HighlightEntry[],
): NarrativeSentence[] {
  const sentences: NarrativeSentence[] = [];
  const lastStep = session.steps.at(-1);
  const files = new Set<string>();
  for (const unit of units) if (unit.status !== "superseded") for (const file of unit.files) files.add(file);
  const names = session.overview?.componentById;
  const changed = highlights.filter((entry) => entry.unitIds.length > 0);
  if (changed.length > 0 && files.size > 0) {
    const shown = changed.slice(0, RULE_NAMES_SHOWN).map((entry) => truncateMiddle(names?.get(entry.id)?.name ?? entry.id, RULE_NAME_MAX));
    const more = changed.length > RULE_NAMES_SHOWN ? ` and ${changed.length - RULE_NAMES_SHOWN} more` : "";
    const named = `Changed ${plural(files.size, "file")} in ${shown.join(", ")}${more}.`;
    // Component names are untrusted (spec §6.3): a name or sentence that fails the narrator's plain-text
    // check (a link, Markdown, HTML, control characters), or is too long, gives the counted form instead.
    const plain = shown.every((name) => plainTextViolation(name) === null) && plainTextViolation(named) === null;
    sentences.push({
      text: plain && named.length <= SENTENCE_MAX ? named : `Changed ${plural(files.size, "file")} in ${plural(changed.length, "component")}.`,
      citations: changed.slice(0, MAX_CITATIONS).map((entry): Citation => ({ kind: "component", id: entry.id })),
    });
  } else if (lastStep !== undefined) {
    sentences.push({
      text: files.size > 0 ? `Changed ${plural(files.size, "file")}.` : "Working on the task; no file changes yet.",
      citations: [{ kind: "step", id: lastStep.id }],
    });
  }
  if (input.tests !== null) {
    sentences.push({
      text: `Latest tests: ${input.tests.passed} passed, ${input.tests.failed} failed.`,
      citations: [{ kind: "step", id: input.tests.stepId }],
    });
  }
  const cite = (decisions: SessionStoryInput["decisions"]): Citation[] =>
    decisions
      .filter((decision) => citable(decision.id))
      .slice(0, MAX_CITATIONS)
      .map((decision): Citation => ({ kind: "decision", id: decision.id }));
  const open = input.decisions.filter((decision) => decision.status === "open");
  const closed = input.decisions.filter((decision) => decision.status === "answered" || decision.status === "delegated");
  if (open.length > 0 && cite(open).length > 0) {
    sentences.push({
      text: open.length === 1 ? "Waiting for your decision." : `Waiting for ${open.length} decisions.`,
      citations: cite(open),
    });
  } else if (closed.length > 0 && cite(closed).length > 0) {
    sentences.push({
      text: closed.length === 1 ? "1 decision answered." : `${closed.length} decisions answered.`,
      citations: cite(closed),
    });
  }
  const state = session.meta.state;
  if (lastStep !== undefined && (state === "completed" || state === "failed" || state === "paused")) {
    const text = state === "completed" ? "The agent finished." : state === "failed" ? "The agent stopped with an error." : "The agent is paused.";
    sentences.push({ text, citations: [{ kind: "step", id: lastStep.id }] });
  }
  return sentences.slice(0, RULE_MAX_SENTENCES);
}
