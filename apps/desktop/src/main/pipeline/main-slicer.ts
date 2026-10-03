/**
 * One cooperative scheduler for the main process's long work (lane 07 PL-3 continuation).
 *
 * Spec §6.1 caps a main-process block at 50 ms. The pipeline's sync pass and the session explainer's fold each
 * yielded with their own setImmediate, so one event-loop turn could run a slice of each (66 ms at 1,459 units,
 * 113 ms at 2,937) while IPC waited. They now share this scheduler:
 *
 * - A task ends its slice with `await slicer.yield()`. Its continuation joins one queue.
 * - One setImmediate per event-loop turn drains the queue. A turn has a budget of MAIN_SLICE_MS: the drain resumes
 *   the first queued continuation, and each time a resumed task yields again it resumes the next one, until the
 *   budget is spent. Continuations that were queued before the turn but not resumed keep their place at the front.
 * - A task checks `spent()` at its slice checks: true once the turn's work, whichever task did it, has used the
 *   budget. It then yields. A continuation queued during a turn waits for a later turn, so a task that yields always
 *   lets the event loop run before it goes on.
 * - Work that starts outside a drain (a timer, an IPC handler) reads `spent()` against the last drain's start, so
 *   it yields at its first check.
 */

export const MAIN_SLICE_MS = 20;

export interface MainSlicer {
  /** The per-turn budget in ms. */
  readonly budgetMs: number;
  /** Drains run so far: one per event-loop turn that resumed queued work. */
  readonly turns: number;
  /** ms since this turn's drain started. */
  elapsed(): number;
  /** True once this turn's budget is spent. */
  spent(): boolean;
  /** Ends the caller's slice: resolves in a later event-loop turn, in queue order. */
  yield(): Promise<void>;
}

export interface MainSlicerOptions {
  budgetMs?: number;
  now?: () => number;
  /** Runs `fn` in a later event-loop turn; default setImmediate. */
  schedule?: (fn: () => void) => void;
}

export function createMainSlicer(options: MainSlicerOptions = {}): MainSlicer {
  const budgetMs = options.budgetMs ?? MAIN_SLICE_MS;
  const now = options.now ?? (() => performance.now());
  const schedule = options.schedule ?? ((fn: () => void) => void setImmediate(fn));
  /** Continuations queued during the current turn, or before it when the drain could not resume them. */
  let queue: (() => void)[] = [];
  /** Continuations the current turn may still resume, in order. */
  let turn: (() => void)[] = [];
  let turnStart = Number.NEGATIVE_INFINITY;
  let turns = 0;
  let scheduled = false;
  /** A continuation this turn resumed has not yielded back yet. */
  let resumed = false;

  const ensureDrain = (): void => {
    if (scheduled || (queue.length === 0 && turn.length === 0)) return;
    scheduled = true;
    schedule(drain);
  };

  /** Resumes the next continuation of this turn while the budget lasts; the rest wait for the next turn. */
  const resumeNext = (): void => {
    resumed = false;
    if (turn.length > 0 && now() - turnStart < budgetMs) {
      const resume = turn.shift();
      if (resume !== undefined) {
        resumed = true;
        resume();
      }
    }
    if (turn.length > 0 && now() - turnStart >= budgetMs) {
      queue = [...turn, ...queue];
      turn = [];
    }
    // A resumed task may finish, or wait on something else, without yielding back: the next turn goes on then.
    ensureDrain();
  };

  function drain(): void {
    scheduled = false;
    turns += 1;
    turnStart = now();
    turn = [...turn, ...queue];
    queue = [];
    resumeNext();
  }

  return {
    budgetMs,
    get turns() {
      return turns;
    },
    elapsed: () => now() - turnStart,
    spent: () => now() - turnStart >= budgetMs,
    yield() {
      return new Promise<void>((resolve) => {
        queue.push(resolve);
        if (resumed) resumeNext();
        else ensureDrain();
      });
    },
  };
}
