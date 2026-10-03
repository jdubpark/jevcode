// The steps the Brief and the component Inspector look for (decisions, running steps), found without a scan of the whole
// session on every commit. Pure and React-free.
import type { Step } from "../model/index.js";

/** A diff above this many positions is treated as a new list: the readers rebuild instead of patching. */
export const STEP_DIFF_LIMIT = 64;

let lastDiff: { before: readonly Step[]; after: readonly Step[]; changed: readonly number[] | null } | null = null;

/**
 * The positions at which `after` holds another Step object than `before`, ascending, appended positions included.
 * Finalize keeps an unchanged Step (and an unchanged list) the same object (spec §6.4), so this is what a commit changed;
 * a pointer comparison per position, with no Step read. null when `after` is shorter (a step was removed, so positions
 * shifted) or more than STEP_DIFF_LIMIT positions changed. The last pair is kept, so the readers of one commit share it.
 */
export function changedStepPositions(before: readonly Step[], after: readonly Step[]): readonly number[] | null {
  if (lastDiff !== null && lastDiff.before === before && lastDiff.after === after) return lastDiff.changed;
  let changed: number[] | null = null;
  if (after.length >= before.length && after.length - before.length <= STEP_DIFF_LIMIT) {
    changed = [];
    for (let at = 0; at < before.length; at += 1) {
      if (before[at] === after[at]) continue;
      changed.push(at);
      if (changed.length > STEP_DIFF_LIMIT) break;
    }
    for (let at = before.length; at < after.length; at += 1) changed.push(at);
    if (changed.length > STEP_DIFF_LIMIT) changed = null;
  }
  lastDiff = { before, after, changed };
  return changed;
}

/** The ids at the changed positions of both lists (a step that moved, went or appeared), or null as above. */
export function changedStepIds(before: readonly Step[], after: readonly Step[]): ReadonlySet<string> | null {
  const changed = changedStepPositions(before, after);
  if (changed === null) return null;
  const ids = new Set<string>();
  for (const at of changed) {
    const was = before[at];
    const is = after[at];
    if (was !== undefined) ids.add(was.id);
    if (is !== undefined) ids.add(is.id);
  }
  return ids;
}

export interface StepDigest {
  /** Positions of the steps with a decision, ascending. */
  readonly decisions: readonly number[];
  /** Positions of the running steps that are not decisions, ascending. */
  readonly running: readonly number[];
}

const isDecision = (step: Step): boolean => step.decision !== undefined;
const isRunning = (step: Step): boolean => step.status === "running" && step.kind !== "decision";

const digests = new WeakMap<readonly Step[], StepDigest>();
let latest: { steps: readonly Step[]; digest: StepDigest } | null = null;

function positionsOf(steps: readonly Step[], test: (step: Step) => boolean): number[] {
  const out: number[] = [];
  steps.forEach((step, at) => {
    if (test(step)) out.push(at);
  });
  return out;
}

/** `list` with the changed positions read again from `steps`. */
function patch(list: readonly number[], steps: readonly Step[], changed: readonly number[], test: (step: Step) => boolean): readonly number[] {
  const redo = new Set(changed);
  const added = changed.filter((at) => {
    const step = steps[at];
    return step !== undefined && test(step);
  });
  if (added.length === 0 && !list.some((at) => redo.has(at))) return list;
  return [...list.filter((at) => !redo.has(at)), ...added].sort((a, b) => a - b);
}

/**
 * The digest of a steps list: cached per list, and patched from the previous list's digest at the positions that
 * changed (changedStepPositions), so a commit that changes a few steps reads only those.
 */
export function stepDigest(steps: readonly Step[]): StepDigest {
  const cached = digests.get(steps);
  if (cached !== undefined) return cached;
  const previous = latest;
  const changed = previous === null ? null : changedStepPositions(previous.steps, steps);
  const digest: StepDigest =
    previous === null || changed === null
      ? { decisions: positionsOf(steps, isDecision), running: positionsOf(steps, isRunning) }
      : {
          decisions: patch(previous.digest.decisions, steps, changed, isDecision),
          running: patch(previous.digest.running, steps, changed, isRunning),
        };
  digests.set(steps, digest);
  latest = { steps, digest };
  return digest;
}
