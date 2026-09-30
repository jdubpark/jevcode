import { hasSevereClamp, ownsRunOutcome } from "./classify.js";
import { normalizeCommand } from "./format.js";
import { clampMeta, severityRank } from "./registry.js";
import {
  CAPABILITIES,
  SIGNAL_IDS,
  findingStableId,
  unitStableId,
  type Capability,
  type Chapter,
  type ClaimObservation,
  type Coverage,
  type Finding,
  type Severity,
  type SignalCoverage,
  type SignalId,
  type SignalMeta,
  type Step,
  type StepId,
  type TraceSession,
  type Turn,
  type UnitStableId,
} from "./types.js";

export interface SignalInput {
  session: Omit<TraceSession, "findings" | "coverage">;
  /** Lookups the finalize already maintains (fold-finalize.ts); built from session when absent. */
  index?: SignalIndex;
  /**
   * The positions of the steps each rule reads (buildSignalScan of session.steps). Rules then visit only those steps,
   * in list order, instead of every step; the findings are the same. Ignored unless built from this session.steps.
   */
  scan?: SignalScan;
}

// ------------------------------------------------------------ scan

const RUN = 1;
const TARGET = 2;
const EDIT = 4;
const DESTRUCTIVE = 8;
const GUARD = 16;

/**
 * Per step position, what the rules test it for: a run (test or check) and whether it has a target, a non-duplicate
 * edit, a destructive command, a severe guardrail clamp. Built from the previous scan: a position holding the same
 * Step object keeps its category (a finalized Step never changes, spec §6.4), so a Live commit categorizes only the
 * steps it changed. Step ids are assumed unique (a finalize's steps are).
 */
export interface SignalScan {
  readonly steps: readonly Step[];
  readonly cats: Uint8Array;
  /** Positions, ascending, of runs (any target), non-duplicate edits, destructive commands and severe guardrails. */
  readonly runs: readonly number[];
  readonly edits: readonly number[];
  readonly destructive: readonly number[];
  readonly guards: readonly number[];
  /** Steps categorized by this build (not kept): a regression gauge for tests. */
  readonly categorized: number;
}

function categoryOf(step: Step): number {
  let cat = 0;
  if (isRun(step)) cat |= RUN;
  if (step.target !== undefined) cat |= TARGET;
  if (step.kind === "edit" && step.noise !== "duplicate_poll") cat |= EDIT;
  if (step.command?.destructivePattern !== undefined) cat |= DESTRUCTIVE;
  if (step.kind === "guardrail" && step.guardrail !== undefined && hasSevereClamp(step)) cat |= GUARD;
  return cat;
}

export function buildSignalScan(steps: readonly Step[], previous?: SignalScan): SignalScan {
  const before = previous?.steps;
  const cats = new Uint8Array(steps.length);
  const runs: number[] = [];
  const edits: number[] = [];
  const destructive: number[] = [];
  const guards: number[] = [];
  let categorized = 0;
  for (let position = 0; position < steps.length; position += 1) {
    const step = steps[position] as Step;
    let cat: number;
    if (before !== undefined && before[position] === step) {
      cat = previous?.cats[position] ?? 0;
    } else {
      cat = categoryOf(step);
      categorized += 1;
    }
    cats[position] = cat;
    if (cat === 0) continue;
    if ((cat & RUN) !== 0) runs.push(position);
    if ((cat & EDIT) !== 0) edits.push(position);
    if ((cat & DESTRUCTIVE) !== 0) destructive.push(position);
    if ((cat & GUARD) !== 0) guards.push(position);
  }
  return { steps, cats, runs, edits, destructive, guards, categorized };
}

function scanOf(input: SignalInput): SignalScan | undefined {
  const scan = input.scan;
  return scan !== undefined && scan.steps === input.session.steps ? scan : undefined;
}

/** The steps at `positions`, in order. */
function at(scan: SignalScan, positions: readonly number[]): Step[] {
  return positions.map((position) => scan.steps[position] as Step);
}

/** Two ascending position lists merged, ascending. */
function merged(a: readonly number[], b: readonly number[]): number[] {
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const x = a[i];
    const y = b[j];
    if (y === undefined || (x !== undefined && x <= y)) {
      if (x !== undefined) out.push(x);
      if (x === y) j += 1;
      i += 1;
    } else {
      out.push(y);
      j += 1;
    }
  }
  return out;
}

export interface SignalIndex {
  stepById: ReadonlyMap<StepId, Step>;
  chapterById: ReadonlyMap<UnitStableId, Chapter>;
  /** runChapters(run, chapterById), kept up to date as chapters change. */
  runChapters(run: Step): UnitStableId[];
}

export interface FindingDraft {
  anchorSeq: number;
  /** One of stepIds (R25). */
  anchorStepId: StepId;
  severity: Severity;
  headline: string;
  reason: string;
  stepIds: StepId[];
  chapterIds: UnitStableId[];
  evidenceSeqs: number[];
  claim?: ClaimObservation;
  /** claim_contradicted only (R25; set in B-12). */
  claimStepId?: StepId;
  evidenceStepIds?: StepId[];
  claimSpan?: [number, number];
  matchedPattern?: string;
  clampId?: string;
}

export interface SignalRule extends SignalMeta {
  evaluate(input: SignalInput): FindingDraft[];
}

// ------------------------------------------------------------ shared helpers

/** normalizeCommand memo: signals run on every finalize, over every run step. Bounded. */
const normalized = new Map<string, string>();

function commandKey(command: string): string {
  let key = normalized.get(command);
  if (key === undefined) {
    if (normalized.size >= 4_096) normalized.clear();
    key = normalizeCommand(command);
    normalized.set(command, key);
  }
  return key;
}

function isRun(step: Step): boolean {
  return step.kind === "test" || step.kind === "check";
}

function runFailed(step: Step): boolean {
  return step.status === "failed";
}

function runPassed(step: Step): boolean {
  return step.status === "ok" && (step.tests === undefined || step.tests.failed === 0);
}

/** seq of the test_result behind a run, else its first row. */
function runSeq(step: Step): number {
  return step.tests?.resultSeq ?? step.firstSeq;
}

function sortedUnique(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function sortStepIds(ids: readonly StepId[], steps: ReadonlyMap<StepId, Step>): StepId[] {
  return [...new Set(ids)].sort((a, b) => (steps.get(a)?.firstSeq ?? 0) - (steps.get(b)?.firstSeq ?? 0));
}

/** The chapters a finding about a test or check run names (spec §6.7 "Finding chapters"). One
 *  validation is often cited by every unit, so the run belongs to every chapter; only the chapters
 *  that own the failure count: of the run's chapters, those whose unit failed or whose files hold a
 *  failing test's file, else the latest of them (session order). This keeps a shared validation from
 *  making every chapter a finding chapter and from clearing noise on lockfile or formatting chapters. */
export function runChapters(run: Step, chapterById: ReadonlyMap<UnitStableId, Chapter>): UnitStableId[] {
  const owners = run.chapterIds.filter((id) => {
    const chapter = chapterById.get(id);
    return chapter !== undefined && ownsRunOutcome(chapter, run);
  });
  if (owners.length > 0) return owners;
  const latest = run.chapterIds[run.chapterIds.length - 1];
  return latest === undefined ? [] : [latest];
}

function chaptersOf(input: SignalInput): (run: Step) => UnitStableId[] {
  const index = input.index;
  if (index !== undefined) return (run) => index.runChapters(run);
  const chapterById = new Map(input.session.chapters.map((chapter) => [chapter.id, chapter]));
  return (run) => runChapters(run, chapterById);
}

// ------------------------------------------------------------ claim lexicon (R10)

/** Success phrases that count anywhere in a clause. */
const SUCCESS_PHRASE =
  /\b(?:all (?:tests|checks)(?: are)? (?:pass(?:ing|ed)?|green)|(?:tests?|checks?|suite|build) (?:pass(?:es|ed)?|(?:is |are )?passing|(?:is |are )?green)|passing tests|everything (?:works|passes|is green)|all green)\b/gi;

/** Completion words count only at the end of a clause ("OAuth implementation complete"), so
 *  "I'm done reading the file" and "next I will complete the setup" are not claims. */
const SUCCESS_STATE = /\b(?:complete|completed|done|finished)\s*$/gi;

const NEGATION_BEFORE = /\b(?:not|never|no|none|cannot|without)\b|n't\b/i;

const NEGATION_AFTER = /^\W*(?:except|but|apart from|other than)\b/i;

/** A clause: text between . ; ! ? and line breaks. */
const CLAUSE = /[^.;!?\n]+/g;

/** [start, end) in UTF-16 code units of the first non-negated success phrase, else of the first
 *  non-negated clause-final completion word (Finding.claimSpan, R25); null when text claims no
 *  success. */
export function matchSuccessClaim(text: string): [number, number] | null {
  // Success phrases ("all checks pass") win over a clause-final completion word ("complete").
  for (const pattern of [SUCCESS_PHRASE, SUCCESS_STATE]) {
    for (const clauseMatch of text.matchAll(CLAUSE)) {
      const clause = clauseMatch[0];
      const base = clauseMatch.index;
      for (const match of clause.matchAll(pattern)) {
        const before = clause.slice(0, match.index);
        const after = clause.slice(match.index + match[0].length);
        if (!NEGATION_BEFORE.test(before) && !NEGATION_AFTER.test(after)) {
          return [base + match.index, base + match.index + match[0].length];
        }
      }
    }
  }
  return null;
}

/** True when some clause of text claims success without a negation (R10). */
export function isSuccessClaim(text: string): boolean {
  return matchSuccessClaim(text) !== null;
}

const PLAN_LEAD = /^\s*plan\b/i;

const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)])\s+\S/gm;

/** A plan message starts with "Plan" or lists at least two items (R25). */
export function isPlanText(text: string): boolean {
  return PLAN_LEAD.test(text) || (text.match(LIST_ITEM) ?? []).length >= 2;
}

/** Turn.planStepId (the first plan message before the turn's first edit) and Turn.claimStepId (the
 *  turn's last success claim) of a turn's steps in order (R25). claim_contradicted checks only
 *  claimStepId. isPlan and isClaim default to isPlanText and isSuccessClaim of the step's text. */
export function turnMarks(
  steps: readonly Step[],
  isPlan: (step: Step) => boolean = (step) => isPlanText(step.text ?? ""),
  isClaim: (step: Step) => boolean = (step) => isSuccessClaim(step.text ?? ""),
): Pick<Turn, "planStepId" | "claimStepId"> {
  const marks: Pick<Turn, "planStepId" | "claimStepId"> = {};
  const firstEdit = steps.find((step) => step.kind === "edit");
  const plan = steps.find(
    (step) =>
      step.kind === "message" && (firstEdit === undefined || step.firstSeq < firstEdit.firstSeq) && isPlan(step),
  );
  if (plan !== undefined) marks.planStepId = plan.id;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step !== undefined && step.kind === "message" && isClaim(step)) {
      marks.claimStepId = step.id;
      break;
    }
  }
  return marks;
}

// ------------------------------------------------------------ the five v1 signals (R11)

const claimContradicted: SignalRule & { readonly id: "claim_contradicted" } = {
  id: "claim_contradicted",
  version: 1,
  severity: "critical",
  title: "Claim contradicted by evidence",
  rationale:
    "The agent's last success claim in a turn is compared with the latest earlier run of each test or check command; a failed run contradicts it.",
  knownFalsePositives: [
    "A claim about a subset of the suite (\"the new tests pass\") while an unrelated run still fails.",
    "Before M1a, reasoning text was stored as assistant messages (packages/agent-codex/src/jsonl.ts:178-189), so a thought can read as a claim.",
  ],
  requires: ["agent_messages", "test_results"],
  evaluate(input) {
    const session = input.session;
    const stepById = input.index?.stepById ?? new Map(session.steps.map((step) => [step.id, step]));
    const chaptersOfRun = chaptersOf(input);
    // Only each turn's claimStepId (its last success claim, set by markTurns) is checked (R25).
    const claimIds = new Set<StepId>();
    for (const turn of session.turns) if (turn.claimStepId !== undefined) claimIds.add(turn.claimStepId);
    // One pass in seq order: the latest run of each command seen so far. With a scan, only the runs with a target and
    // the claim steps are visited.
    const scan = scanOf(input);
    let visit: readonly Step[] = session.steps;
    if (scan !== undefined) {
      const claimPositions: number[] = [];
      for (const id of claimIds) {
        const claim = stepById.get(id);
        const position = claim === undefined ? -1 : scan.steps.indexOf(claim);
        if (position >= 0) claimPositions.push(position);
      }
      const targeted = scan.runs.filter((position) => ((scan.cats[position] ?? 0) & TARGET) !== 0);
      visit = at(scan, merged(targeted, claimPositions.sort((a, b) => a - b)));
    }
    const latestByTarget = new Map<string, Step>();
    const drafts: FindingDraft[] = [];
    for (const step of visit) {
      if (isRun(step) && step.target !== undefined) {
        latestByTarget.set(commandKey(step.target), step);
        continue;
      }
      if (!claimIds.has(step.id)) continue;
      const failed = [...latestByTarget.values()].filter(runFailed).sort((a, b) => runSeq(b) - runSeq(a))[0];
      if (failed === undefined) continue;
      const tests = failed.tests ?? { passed: 0, failed: 0, skipped: 0 };
      const text = step.text ?? "";
      const span = matchSuccessClaim(text);
      drafts.push({
        anchorSeq: step.firstSeq,
        anchorStepId: step.id,
        severity: "critical",
        headline: "Claim contradicted by tests",
        reason: `The agent said "${text}" but ${failed.target ?? "the latest run"} had ${
          tests.failed > 0 ? `${tests.failed} failing test${tests.failed === 1 ? "" : "s"}` : "a non-zero exit"
        }.`,
        stepIds: sortStepIds([step.id, failed.id], stepById),
        chapterIds: chaptersOfRun(failed),
        evidenceSeqs: sortedUnique([runSeq(failed), step.firstSeq]),
        claim: {
          claim: { text, seq: step.firstSeq, tMs: step.tMs, stepId: step.id },
          observed: {
            command: failed.target ?? "",
            passed: tests.passed,
            failed: tests.failed,
            skipped: tests.skipped,
            seq: runSeq(failed),
            tMs: failed.endTMs ?? failed.tMs,
            stepId: failed.id,
          },
        },
        claimStepId: step.id,
        evidenceStepIds: [failed.id],
        ...(span !== null ? { claimSpan: span } : {}),
      });
    }
    return drafts;
  },
};

const failingTests: SignalRule & { readonly id: "failing_tests" } = {
  id: "failing_tests",
  version: 1,
  severity: "warning",
  title: "Failing tests",
  rationale:
    "A test run reported failures. It is critical when the same command's final run in the session also failed, because the failure was never fixed.",
  knownFalsePositives: [
    "Any runner-like stdout is parsed into a test result (apps/desktop/src/main/pipeline/pipeline-runtime.ts:750-753), so a command that prints a test summary it did not run can count.",
  ],
  requires: ["test_results"],
  evaluate(input) {
    const session = input.session;
    const chaptersOfRun = chaptersOf(input);
    const scan = scanOf(input);
    const runs = scan === undefined ? session.steps : at(scan, scan.runs);
    const finalRun = new Map<string, Step>();
    for (const step of runs) {
      if (isRun(step) && step.target !== undefined) finalRun.set(commandKey(step.target), step);
    }
    return runs
      .filter((step) => isRun(step) && step.tests !== undefined && step.tests.failed > 0)
      .map((step) => {
        const tests = step.tests ?? { passed: 0, failed: 0, skipped: 0 };
        const final = step.target !== undefined ? finalRun.get(commandKey(step.target)) : undefined;
        const unresolved = final !== undefined && runFailed(final);
        return {
          anchorSeq: runSeq(step),
          anchorStepId: step.id,
          severity: unresolved ? "critical" : "warning",
          headline: `${tests.failed} failing test${tests.failed === 1 ? "" : "s"}`,
          reason: unresolved
            ? `${step.target ?? "The test command"} still fails in its final run.`
            : `${step.target ?? "The test command"} passed in a later run.`,
          stepIds: [step.id],
          chapterIds: chaptersOfRun(step),
          evidenceSeqs: [runSeq(step)],
        } satisfies FindingDraft;
      });
  },
};

const destructiveCommand: SignalRule & { readonly id: "destructive_command" } = {
  id: "destructive_command",
  version: 1,
  severity: "critical",
  title: "Destructive command",
  rationale: "The command matches a destructive pattern from matchDestructive (packages/contracts/src/security.ts).",
  knownFalsePositives: [
    "SQL verbs match anywhere in the command text, so grep -rn \"DELETE FROM\" matches (packages/contracts/src/security.ts:21-23).",
    "Any rm -rf matches whatever its target, including build output such as dist/.",
  ],
  requires: ["agent_commands"],
  evaluate(input) {
    const scan = scanOf(input);
    return (scan === undefined ? input.session.steps : at(scan, scan.destructive))
      .filter((step) => step.command?.destructivePattern !== undefined)
      .map((step) => ({
        anchorSeq: step.firstSeq,
        anchorStepId: step.id,
        severity: "critical",
        headline: "Destructive command",
        reason: `${step.command?.command ?? ""} matches the ${step.command?.destructivePattern ?? ""} pattern.`,
        stepIds: [step.id],
        chapterIds: [...step.chapterIds],
        evidenceSeqs: [...step.evidenceSeqs],
        matchedPattern: step.command?.destructivePattern ?? "",
      }));
  },
};

const guardrailClamp: SignalRule & { readonly id: "guardrail_clamp" } = {
  id: "guardrail_clamp",
  version: 1,
  severity: "info",
  title: "Guardrail clamp",
  rationale:
    "Jev's guardrails overrode a model value for a change unit. One finding per guardrail row with a warning or critical clamp, at the most severe clamp's severity (destructive_command critical; security, schema, public API and failed-unit clamps warning). Rows whose clamps are all info, including ids this build does not know, raise none and collapse as pipeline noise.",
  knownFalsePositives: [
    "Before M1c, suppression rows were logged as clientKind \"degrade\" with confidence 1 (apps/desktop/src/main/pipeline/jev-stage.ts:146-160), so they read as rule-only.",
    "The security-path patterns match /token/i in tokenizer.ts and \\.env in .env.example (packages/jev-router/src/patterns.ts:11-19).",
  ],
  requires: ["jev_decisions"],
  evaluate(input) {
    const scan = scanOf(input);
    return (scan === undefined ? input.session.steps : at(scan, scan.guards))
      .filter((step) => step.kind === "guardrail" && step.guardrail !== undefined && hasSevereClamp(step))
      .map((step) => {
        const clampIds = step.guardrail?.clampIds ?? [];
        let top = clampIds[0] ?? "";
        for (const id of clampIds) {
          if (severityRank(clampMeta(id).severity) > severityRank(clampMeta(top).severity)) top = id;
        }
        const unitId = step.guardrail?.changeUnitId;
        return {
          anchorSeq: step.firstSeq,
          anchorStepId: step.id,
          severity: clampMeta(top).severity,
          headline: clampMeta(top).label,
          reason: clampIds.map((id) => clampMeta(id).label).join("; "),
          stepIds: [step.id],
          chapterIds: unitId !== undefined && unitId !== "" ? [unitStableId(unitId)] : [...step.chapterIds],
          evidenceSeqs: [step.firstSeq],
          clampId: top,
        } satisfies FindingDraft;
      });
  },
};

const recoveryArc: SignalRule & { readonly id: "recovery_arc" } = {
  id: "recovery_arc",
  version: 1,
  severity: "info",
  title: "Recovery",
  rationale: "A run failed, the agent edited code, and a later run of the same command passed.",
  knownFalsePositives: ["The later run passed because tests were deleted or skipped rather than fixed."],
  requires: ["test_results"],
  evaluate(input) {
    const session = input.session;
    const chaptersOfRun = chaptersOf(input);
    const drafts: FindingDraft[] = [];
    const openFailure = new Map<string, { failed: Step; edits: StepId[] }>();
    // With a scan, only the non-duplicate edits and the runs with a target are visited, in list order.
    const scan = scanOf(input);
    const visit =
      scan === undefined
        ? session.steps
        : at(scan, merged(scan.edits, scan.runs.filter((position) => ((scan.cats[position] ?? 0) & TARGET) !== 0)));
    for (const step of visit) {
      if (step.kind === "edit") {
        if (step.noise !== "duplicate_poll") for (const pending of openFailure.values()) pending.edits.push(step.id);
        continue;
      }
      if (!isRun(step) || step.target === undefined) continue;
      const target = commandKey(step.target);
      if (runFailed(step)) {
        const pending = openFailure.get(target);
        if (pending === undefined || pending.edits.length > 0) openFailure.set(target, { failed: step, edits: [] });
        continue;
      }
      const pending = openFailure.get(target);
      if (pending === undefined || !runPassed(step)) continue;
      if (pending.edits.length === 0) {
        openFailure.delete(target);
        continue;
      }
      openFailure.delete(target);
      drafts.push({
        anchorSeq: runSeq(step),
        anchorStepId: step.id,
        severity: "info",
        headline: "Recovered after edits",
        reason: `${step.target} failed, ${pending.edits.length} edit${pending.edits.length === 1 ? "" : "s"} followed, then it passed.`,
        stepIds: [pending.failed.id, ...pending.edits, step.id],
        // The chapters that owned the failure recovered; the passing run's chapters only when the
        // failed run has none.
        chapterIds: chaptersOfRun(pending.failed.chapterIds.length > 0 ? pending.failed : step),
        evidenceSeqs: sortedUnique([runSeq(pending.failed), runSeq(step)]),
      });
    }
    return drafts;
  },
};

export const SIGNALS: { readonly [K in SignalId]: SignalRule & { readonly id: K } } = {
  claim_contradicted: claimContradicted,
  failing_tests: failingTests,
  destructive_command: destructiveCommand,
  guardrail_clamp: guardrailClamp,
  recovery_arc: recoveryArc,
};

export function signalMeta(id: SignalId): SignalMeta {
  const { evaluate: _evaluate, ...meta } = SIGNALS[id];
  return { ...meta, knownFalsePositives: [...meta.knownFalsePositives], requires: [...meta.requires] };
}

/** Rule rank inside a severity (spec §6.7 FINDING_ORDER). On oauth and api-break, failing_tests is
 *  critical too and anchors earlier, so the rank is what puts the contradiction first. */
export const FINDING_RULE_RANK: { readonly [K in SignalId]: number } = {
  claim_contradicted: 0,
  destructive_command: 1,
  failing_tests: 2,
  guardrail_clamp: 3,
  recovery_arc: 4,
};

/** Severity (critical > warning > info), then FINDING_RULE_RANK, then anchorSeq ascending, then id.
 *  finalize keeps findings in (anchorSeq, id) order (R8); the UI sorts a copy with this for the
 *  initial selection and for the finding a spine row shows. */
export function compareFindings(a: Finding, b: Finding): number {
  return (
    severityRank(b.severity) - severityRank(a.severity) ||
    FINDING_RULE_RANK[a.ruleId] - FINDING_RULE_RANK[b.ruleId] ||
    a.anchorSeq - b.anchorSeq ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

// ------------------------------------------------------------ findings and coverage

export function computeCoverage(
  capabilities: ReadonlySet<Capability>,
  approximateJoins: boolean,
  inferredSteps: number,
): Coverage {
  const present = CAPABILITIES.filter((capability) => capabilities.has(capability));
  const signals: SignalCoverage[] = SIGNAL_IDS.map((id) => {
    const missing = SIGNALS[id].requires.filter((capability) => !capabilities.has(capability));
    return { id, active: missing.length === 0, missing };
  });
  return { capabilities: present, signals, approximateJoins, inferredSteps };
}

/** Evaluates the active signals: findings in (anchorSeq, id) order, the first draft of each id kept.
 *  Signals read the steps and chapters before findings apply (finding ids empty, noise before a
 *  finding clears it); the finalize then attaches findingIds to the steps and chapters each finding
 *  names, un-collapses them, and marks each contradicted claim step with the claim_contradicted
 *  problem. Findings are derived here and never persisted. */
export function evaluateSignals(input: SignalInput, coverage: Coverage): Finding[] {
  const findings = new Map<string, Finding>();
  for (const signal of coverage.signals) {
    if (!signal.active) continue;
    const rule = SIGNALS[signal.id];
    for (const draft of rule.evaluate(input)) {
      const id = findingStableId(rule.id, rule.version, draft.anchorSeq);
      if (findings.has(id)) continue;
      findings.set(id, { id, ruleId: rule.id, ruleVersion: rule.version, ...draft });
    }
  }
  return [...findings.values()].sort((a, b) => a.anchorSeq - b.anchorSeq || a.id.localeCompare(b.id));
}
