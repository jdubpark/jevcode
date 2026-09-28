import {
  matchDestructive,
  type EvidenceFact,
  type TraceRow,
  type ValidationResult,
} from "@jevcode/contracts";

import {
  addRowToStep,
  createStep,
  currentTurn,
  setKind,
  touchTurn,
  type FoldState,
  type RowContext,
  type StepDraft,
  type TurnDraft,
} from "./fold-state.js";
import { normalizeCommand, truncateMiddle } from "./format.js";
import { commandKind } from "./registry.js";
import { fileStableId, type DiffState, type Entity, type FileStableId, type Step } from "./types.js";

type CallFact = Extract<EvidenceFact, { type: "command_executed" | "test_result" }>;
type PathFact = Extract<EvidenceFact, { type: "git_hunk" | "file_changed" | "symbol_delta" }>;
type HunkFact = Extract<EvidenceFact, { type: "git_hunk" }>;

const MAX_FAILURES = 20;

function testKind(command: string): "check" | "test" {
  return commandKind(command) === "check" ? "check" : "test";
}

/** The step a command_executed or test_result belongs to: by sourceCallId (observed), else the
 *  latest same-command step in the turn (inferred), else a new repo step. */
function attachCall(state: FoldState, turn: TurnDraft, ctx: RowContext, fact: CallFact): StepDraft {
  const normalized = normalizeCommand(fact.command);
  if (fact.sourceCallId !== undefined) {
    const byCall = state.stepsByCallId.get(fact.sourceCallId);
    if (byCall !== undefined) return byCall;
  }
  const byCommand = turn.commands.get(normalized);
  if (byCommand !== undefined) {
    byCommand.provenance = "inferred";
    return byCommand;
  }
  const kind = fact.type === "test_result" ? testKind(fact.command) : commandKind(fact.command);
  const step = createStep(state, turn, ctx, {
    kind,
    source: fact.type,
    status: "ok",
    actor: "repo",
    target: fact.command,
  });
  const pattern = matchDestructive(fact.command);
  step.command = {
    command: fact.command,
    exitCode: fact.type === "command_executed" ? fact.exitCode : null,
    ...(pattern !== null ? { destructivePattern: pattern.name } : {}),
  };
  turn.commands.set(normalized, step);
  return step;
}

function foldCallFact(state: FoldState, turn: TurnDraft, ctx: RowContext, fact: CallFact): void {
  const step = attachCall(state, turn, ctx, fact);
  if (step.seqs[0] !== ctx.seq) addRowToStep(step, ctx, true);
  else step.evidenceSeqs.push(ctx.seq);
  state.evidence.stepByEvidenceSeq.set(ctx.seq, step);
  if (fact.type !== "test_result") return;
  state.capabilities.add("test_results");
  step.tests = {
    runner: fact.runner,
    passed: fact.passed,
    failed: fact.failed,
    skipped: fact.skipped,
    failures: fact.failures.slice(0, MAX_FAILURES).map((failure) => ({
      file: failure.file,
      testName: failure.testName,
      message: failure.message,
    })),
    resultSeq: ctx.seq,
  };
  setKind(step, testKind(fact.command));
  state.evidence.testRunByKey.set(`${normalizeCommand(fact.command)}\u0000${fact.ts}`, step);
}

function pathOf(fact: PathFact): string {
  return fact.type === "git_hunk" ? fact.file : fact.path;
}

function hunkKey(fact: HunkFact): string {
  return fact.diff !== undefined ? fact.diff.hash : `${fact.added}:${fact.removed}`;
}

function diffState(fact: HunkFact): DiffState {
  const diff = fact.diff;
  if (diff === undefined) return "none";
  if (diff.withheld === "secret_path") return "withheld_secret";
  if (diff.withheld === "not_captured" || diff.text === undefined) return "not_captured";
  return diff.truncated ? "truncated" : "text";
}

function createRepoEditStep(state: FoldState, turn: TurnDraft, ctx: RowContext, fact: PathFact): StepDraft {
  const path = pathOf(fact);
  const step = createStep(state, turn, ctx, {
    kind: "edit",
    source: fact.type,
    status: "ok",
    actor: "repo",
    target: path,
  });
  step.edit = {
    path,
    added: 0,
    removed: 0,
    claimed: false,
    observed: true,
    diff: "none",
    lockfile: false,
    formattingOnly: false,
  };
  step.evidenceSeqs.push(ctx.seq);
  return step;
}

function applyHunk(step: StepDraft, ctx: RowContext, fact: HunkFact): void {
  if (step.edit === undefined) return;
  step.edit.added = fact.added;
  step.edit.removed = fact.removed;
  step.edit.lockfile = step.edit.lockfile || fact.isLockfile;
  step.edit.formattingOnly = fact.isFormattingOnly;
  step.edit.diffSeq = ctx.seq;
  step.edit.diff = diffState(fact);
}

/** Repo facts for a path join the path's latest edit step in the turn; a git_hunk with new
 *  content after that step already holds one starts a new step; an identical git_hunk is a
 *  duplicate_poll step of its own. */
function foldPathFact(state: FoldState, turn: TurnDraft, ctx: RowContext, fact: PathFact): void {
  const path = pathOf(fact);
  const evidence = state.evidence;
  if (fact.type === "git_hunk") {
    const key = hunkKey(fact);
    if (evidence.lastHunkKey.get(path) === key) {
      const duplicate = createRepoEditStep(state, turn, ctx, fact);
      applyHunk(duplicate, ctx, fact);
      evidence.duplicates.add(duplicate.id);
      evidence.stepByEvidenceSeq.set(ctx.seq, duplicate);
      return;
    }
    evidence.lastHunkKey.set(path, key);
    let step = turn.edits.get(path);
    if (step === undefined || evidence.hunkKeyByStep.has(step.id)) {
      step = createRepoEditStep(state, turn, ctx, fact);
      turn.edits.set(path, step);
    } else {
      addRowToStep(step, ctx, true);
    }
    evidence.hunkKeyByStep.set(step.id, key);
    applyHunk(step, ctx, fact);
    if (step.edit !== undefined) step.edit.observed = true;
    evidence.stepByEvidenceSeq.set(ctx.seq, step);
    return;
  }
  let step = turn.edits.get(path);
  if (step === undefined) {
    step = createRepoEditStep(state, turn, ctx, fact);
    turn.edits.set(path, step);
  } else {
    addRowToStep(step, ctx, true);
  }
  if (step.edit !== undefined) {
    step.edit.observed = true;
    if (fact.type === "file_changed") step.edit.change = fact.kind;
  }
  evidence.stepByEvidenceSeq.set(ctx.seq, step);
}

function foldPointFact(
  state: FoldState,
  turn: TurnDraft,
  ctx: RowContext,
  fact: Extract<EvidenceFact, { type: "dependency_change" | "revert_detected" }>,
): void {
  if (fact.type === "dependency_change") {
    const names = [
      ...fact.added.map((dependency) => `+${dependency.name}`),
      ...fact.removed.map((dependency) => `−${dependency.name}`),
    ];
    const step = createStep(state, turn, ctx, {
      kind: "dependency",
      source: fact.type,
      status: "info",
      target: fact.manifest,
      label: names.join(" "),
    });
    step.evidenceSeqs.push(ctx.seq);
    state.evidence.stepByEvidenceSeq.set(ctx.seq, step);
    return;
  }
  const step = createStep(state, turn, ctx, {
    kind: "revert",
    source: fact.type,
    status: "info",
    target: fact.files.join(", "),
    label: fact.files.length === 1 ? `Reverted ${fact.files[0] ?? ""}` : `Reverted ${fact.files.length} files`,
  });
  step.evidenceSeqs.push(ctx.seq);
  state.evidence.stepByEvidenceSeq.set(ctx.seq, step);
}

export function foldEvidenceFact(state: FoldState, row: TraceRow, fact: EvidenceFact, ctx: RowContext): void {
  if (row.factId !== undefined) {
    state.capabilities.add("fact_links");
    if (!state.evidence.factSeqById.has(row.factId)) state.evidence.factSeqById.set(row.factId, ctx.seq);
  }
  const turn = currentTurn(state, ctx);
  touchTurn(turn, ctx);
  switch (fact.type) {
    case "command_executed":
    case "test_result":
      foldCallFact(state, turn, ctx, fact);
      break;
    case "git_hunk":
    case "file_changed":
    case "symbol_delta":
      foldPathFact(state, turn, ctx, fact);
      break;
    case "dependency_change":
    case "revert_detected":
      foldPointFact(state, turn, ctx, fact);
      break;
  }
}

/** A validation joins the step holding its test_result (same command and ts), else the latest
 *  step in any turn with the same command. It adds evidence; test counts come from test_result. */
export function foldValidation(state: FoldState, validation: ValidationResult, ctx: RowContext): void {
  const evidence = state.evidence;
  if (!evidence.validationSeqById.has(validation.id)) evidence.validationSeqById.set(validation.id, ctx.seq);
  const normalized = normalizeCommand(validation.command);
  let step = evidence.testRunByKey.get(`${normalized}\u0000${validation.ts}`);
  for (let index = state.turns.length - 1; step === undefined && index >= 0; index -= 1) {
    step = state.turns[index]?.commands.get(normalized);
  }
  if (step === undefined) return;
  addRowToStep(step, ctx, true);
  evidence.stepByEvidenceSeq.set(ctx.seq, step);
  if (validation.kind !== "test" && step.kind !== "check") setKind(step, "check");
}

/** Files only in v1. added/removed come from the path's latest hunk (hunks are cumulative
 *  against the base commit); duplicate_poll steps are left out of stepIds. */
export function buildEntities(steps: readonly Step[], duplicates: ReadonlySet<string>): Entity[] {
  const byPath = new Map<string, Entity>();
  for (const step of steps) {
    if (step.kind !== "edit" || step.edit === undefined) continue;
    const edit = step.edit;
    const id: FileStableId = fileStableId(edit.path);
    step.entityIds = [id];
    let entity = byPath.get(edit.path);
    if (entity === undefined) {
      entity = {
        id,
        kind: "file",
        path: edit.path,
        label: truncateMiddle(edit.path, 48),
        added: 0,
        removed: 0,
        claimed: false,
        observed: false,
        stepIds: [],
        chapterIds: [],
      };
      byPath.set(edit.path, entity);
    }
    entity.claimed = entity.claimed || edit.claimed;
    entity.observed = entity.observed || edit.observed;
    if (duplicates.has(step.id)) continue;
    entity.stepIds.push(step.id);
    if (edit.diffSeq !== undefined) {
      entity.added = edit.added;
      entity.removed = edit.removed;
    }
  }
  return [...byPath.values()];
}
