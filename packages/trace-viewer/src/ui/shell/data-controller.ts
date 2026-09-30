import {
  TRACE_ROWS_PAGE_MAX,
  type AgentState,
  type TraceRow,
  type TraceRowsPage,
  type TraceSessionSummary,
} from "@jevcode/contracts";

import { accumulateAll, createTraceState, finalize, type TraceSession, type TraceState } from "../../model/index.js";
import { cursorAfter, type TraceSource } from "../../source.js";
import { TraceSourceError, type TraceChannel, type TraceSourceErrorCode } from "../../sources/errors.js";

export type DataStatus =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "reconnecting"; attempt: number; retryInMs: number }
  | { kind: "error"; channel: TraceChannel; code: TraceSourceErrorCode; message: string };

export interface DataSnapshot {
  summary: TraceSessionSummary | null;
  /** null until the first page folds. */
  session: TraceSession | null;
  status: DataStatus;
  /** nextAfterSeq / lastSeq while paging; 1 once caught up. */
  loadedFraction: number;
  terminal: boolean;
  /** Rows folded so far (TraceState.received); ViewerHost.onReady reports it. */
  rows: number;
}

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface DataControllerOptions {
  source: TraceSource;
  pollMs: number;
  /** Default TRACE_ROWS_PAGE_MAX. */
  pageSize?: number;
  /** Default 4 (spec §7.11 Progressive). */
  maxCommitsPerSecond?: number;
  scheduler?: Scheduler;
  /** Default document.visibilityState === "hidden". */
  isHidden?(): boolean;
}

export const BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 10_000];

/** While catching up, a progressive commit waits at least this many times the previous finalize (see requestCommit). */
export const COMMIT_COST_FACTOR = 4;

export interface DataController {
  start(): void;
  stop(): void;
  retry(): void;
  /** While held, new snapshots queue and the latest applies on release (gesture hold). */
  hold(held: boolean): void;
  notifyVisible(): void;
  subscribe(listener: (snapshot: DataSnapshot) => void): () => void;
  get(): DataSnapshot;
  payloads(seqs: readonly number[]): Promise<TraceRow[]>;
  /** The source clock, epoch ms (TraceSource.now). */
  now(): number;
}

/** Spec §7.10: terminal(state) = completed or failed. */
export function isTerminalState(state: AgentState): boolean {
  return state === "completed" || state === "failed";
}

/** Spec §7.10: starting, running and waiting_decision open in Live. */
export function isLiveState(state: AgentState): boolean {
  return state === "starting" || state === "running" || state === "waiting_decision";
}

/** Spec §10 live tick start; C2-3's Shell measures PERF.liveTick from it (lane 08 D-8 reads the measure). */
export const LIVE_TICK_START = "tv:live-tick-start";

function markLiveTickStart(): void {
  if (typeof performance === "undefined" || typeof performance.mark !== "function") return;
  performance.clearMarks(LIVE_TICK_START);
  performance.mark(LIVE_TICK_START);
}

const EMPTY: DataSnapshot = {
  summary: null,
  session: null,
  status: { kind: "loading" },
  loadedFraction: 0,
  terminal: false,
  rows: 0,
};

function realScheduler(): Scheduler {
  return {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => performance.now(),
  };
}

function statusFromError(error: unknown, channel: TraceChannel): DataStatus {
  if (error instanceof TraceSourceError) {
    return { kind: "error", channel: error.channel, code: error.code, message: error.message };
  }
  return {
    kind: "error",
    channel,
    code: "SOURCE_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

/** Folds with createTraceState/accumulateAll/finalize({live: !terminal, state, throughSeq: cursorAfter(page), nowMs: source.now()}); tags requests with a monotonic generation and drops stale responses. */
export function createDataController(options: DataControllerOptions): DataController {
  const { source, pollMs } = options;
  const pageSize = options.pageSize ?? TRACE_ROWS_PAGE_MAX;
  const minCommitGapMs = 1_000 / (options.maxCommitsPerSecond ?? 4);
  const scheduler = options.scheduler ?? realScheduler();
  const isHidden =
    options.isHidden ?? (() => typeof document !== "undefined" && document.visibilityState === "hidden");
  const listeners = new Set<(snapshot: DataSnapshot) => void>();

  let latest = EMPTY;
  let visible = EMPTY;
  let held = false;
  let running = false;
  let generation = 0;
  let fold: TraceState | null = null;
  let cursor = 0;
  let lastPage: TraceRowsPage | null = null;
  let lastCommitAt = Number.NEGATIVE_INFINITY;
  let lastCommitCostMs = 0;
  let commitTimer: unknown = null;
  let commitCaughtUp = false;
  let pollTimer: unknown = null;
  let yieldTimer: unknown = null;
  let failures = 0;

  function flush(): void {
    if (visible === latest) return;
    visible = latest;
    for (const listener of [...listeners]) listener(visible);
  }

  function emit(next: DataSnapshot): void {
    latest = next;
    if (!held && !isHidden()) flush();
  }

  function clearTimers(): void {
    if (commitTimer !== null) scheduler.clearTimeout(commitTimer);
    if (pollTimer !== null) scheduler.clearTimeout(pollTimer);
    if (yieldTimer !== null) scheduler.clearTimeout(yieldTimer);
    commitTimer = null;
    pollTimer = null;
    yieldTimer = null;
  }

  /** One macrotask, so the host can render and paint the commit a page produced before the next page folds (spec §10 first paint). */
  function yieldToHost(): Promise<void> {
    return new Promise((resolve) => {
      yieldTimer = scheduler.setTimeout(() => {
        yieldTimer = null;
        resolve();
      }, 0);
    });
  }

  function commitNow(caughtUp: boolean): void {
    if (fold === null || lastPage === null) return;
    const page = lastPage;
    const startedAt = scheduler.now();
    const session = finalize(fold, {
      live: !isTerminalState(page.state),
      state: page.state,
      throughSeq: cursor,
      nowMs: source.now(),
    });
    lastCommitAt = scheduler.now();
    lastCommitCostMs = lastCommitAt - startedAt;
    failures = 0;
    emit({
      summary: latest.summary,
      session,
      status: { kind: "ready" },
      loadedFraction:
        caughtUp || page.lastSeq === 0 ? 1 : Math.min(1, (page.nextAfterSeq ?? page.lastSeq) / page.lastSeq),
      terminal: caughtUp && isTerminalState(page.state),
      rows: fold.received,
    });
  }

  function schedulePoll(gen: number, delayMs: number): void {
    if (pollTimer !== null) scheduler.clearTimeout(pollTimer);
    pollTimer = scheduler.setTimeout(() => {
      pollTimer = null;
      void poll(gen);
    }, delayMs);
  }

  function afterCommit(gen: number, caughtUp: boolean): void {
    if (gen !== generation || !caughtUp || lastPage === null) return;
    if (isTerminalState(lastPage.state)) return; // one final apply, then stop
    schedulePoll(gen, pollMs);
  }

  /**
   * Spec §7.11 caps progressive commits at maxCommitsPerSecond. Each commit re-derives the whole
   * session (finalize, then the Shell's index and views), O(rows), so while catching up the gap
   * also grows to COMMIT_COST_FACTOR times the last finalize: re-deriving stays a bounded share of
   * the load instead of O(rows x load time). The caught-up commit waits only the plain cap, and it
   * replaces a pending progressive commit rather than waiting behind it.
   */
  function requestCommit(gen: number, caughtUp: boolean): void {
    commitCaughtUp = caughtUp;
    if (commitTimer !== null) {
      if (!caughtUp) return; // the pending commit publishes the latest fold
      scheduler.clearTimeout(commitTimer);
      commitTimer = null;
    }
    const gapMs = caughtUp ? minCommitGapMs : Math.max(minCommitGapMs, COMMIT_COST_FACTOR * lastCommitCostMs);
    const wait = lastCommitAt + gapMs - scheduler.now();
    if (wait <= 0) {
      commitNow(caughtUp);
      afterCommit(gen, caughtUp);
      return;
    }
    commitTimer = scheduler.setTimeout(() => {
      commitTimer = null;
      if (gen !== generation) return;
      const done = commitCaughtUp;
      commitNow(done);
      afterCommit(gen, done);
    }, wait);
  }

  /** A source that throws synchronously fails like one that rejects. */
  function requestRows(afterSeq: number): Promise<TraceRowsPage> {
    try {
      return source.rows({ afterSeq, limit: pageSize });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async function page(gen: number, first?: Promise<TraceRowsPage>): Promise<void> {
    let pending = first;
    for (;;) {
      const next = await (pending ?? requestRows(cursor));
      pending = undefined;
      if (gen !== generation || fold === null) return;
      if (next.nextAfterSeq !== null) {
        // Pipeline, one request ahead: the next page crosses IPC while this one folds, commits and
        // yields. A superseded generation drops it unread; a failure resurfaces when the loop awaits it.
        pending = requestRows(cursorAfter(next));
        pending.catch(() => undefined);
      }
      if (next.rows.length > 0 && latest.session !== null && latest.loadedFraction >= 1) markLiveTickStart();
      const changed =
        next.rows.length > 0 ||
        lastPage === null ||
        next.state !== lastPage.state ||
        next.lastSeq !== lastPage.lastSeq;
      accumulateAll(fold, next.rows);
      lastPage = next;
      cursor = cursorAfter(next);
      if (next.nextAfterSeq !== null) {
        requestCommit(gen, false);
        await yieldToHost();
        if (gen !== generation) return;
        continue;
      }
      const settled = latest.session !== null && latest.status.kind === "ready" && latest.loadedFraction >= 1;
      if (changed || !settled) {
        requestCommit(gen, true);
      } else if (!isTerminalState(next.state)) {
        schedulePoll(gen, pollMs);
      }
      return;
    }
  }

  async function poll(gen: number, first?: Promise<TraceRowsPage>): Promise<void> {
    try {
      await page(gen, first);
    } catch (error) {
      if (gen !== generation) return;
      if (latest.session === null) {
        emit({ ...latest, status: statusFromError(error, "trace:rows") });
        return;
      }
      failures += 1;
      const retryInMs = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1] ?? 10_000;
      emit({ ...latest, status: { kind: "reconnecting", attempt: failures, retryInMs } });
      schedulePoll(gen, retryInMs);
    }
  }

  async function load(gen: number): Promise<void> {
    let summary: TraceSessionSummary;
    // The first page does not depend on the summary: request both together.
    const firstPage = requestRows(cursor);
    firstPage.catch(() => undefined); // a summary failure abandons it; a page failure resurfaces through page()
    try {
      summary = await source.summary();
    } catch (error) {
      if (gen === generation) emit({ ...latest, status: statusFromError(error, "trace:listSessions") });
      return;
    }
    if (gen !== generation) return;
    fold = createTraceState(summary);
    emit({ ...latest, summary });
    await poll(gen, firstPage);
  }

  function reset(): void {
    clearTimers();
    generation += 1;
    fold = null;
    cursor = 0;
    lastPage = null;
    lastCommitAt = Number.NEGATIVE_INFINITY;
    lastCommitCostMs = 0;
    commitCaughtUp = false;
    failures = 0;
  }

  return {
    start() {
      if (running) return;
      running = true;
      reset();
      void load(generation);
    },
    stop() {
      running = false;
      clearTimers();
      generation += 1;
    },
    retry() {
      if (!running) return;
      if (fold !== null && latest.session !== null) {
        clearTimers();
        generation += 1;
        void poll(generation);
        return;
      }
      reset();
      emit({ ...EMPTY, summary: latest.summary });
      void load(generation);
    },
    hold(next) {
      held = next;
      if (!held && !isHidden()) flush();
    },
    notifyVisible() {
      if (!held && !isHidden()) flush();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: () => visible,
    payloads: (seqs) => source.payloads(seqs),
    now: () => source.now(),
  };
}
