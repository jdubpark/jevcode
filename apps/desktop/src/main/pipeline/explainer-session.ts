import {
  OverviewSnapshotSchema,
  isTraceRowType,
  type ChangeUnit,
  type ExplainerRecord,
  type NarrativeSentence,
  type OverviewSnapshot,
  type TraceSessionSummary,
} from "@jevcode/contracts";
import {
  NARRATOR_MODEL,
  NarratorUnavailableError,
  guardDecisionWhy,
  guardSessionStory,
  type NarratorClient,
  type NarratorResult,
  type SessionStoryInput,
} from "@jevcode/jev-router";
import type { JevcodeDb } from "@jevcode/storage";
import { accumulate, createTraceState, finalize, type TraceSession, type TraceState } from "@jevcode/trace-viewer/model";

import type { NarratorCallRecord } from "../../shared/narrator-log.js";
import { SCHEMA_BRAKE_STREAK } from "./explainer-narration.js";
import {
  EXPLAINER_ID_MAX,
  STORY_MIN_INTERVAL_MS,
  STORY_UNIT_THRESHOLD,
  backoffMs,
  computeHighlights,
  decisionWhyInput,
  failingTestFiles,
  failureReason,
  ruleStory,
  sessionStoryInput,
  type HighlightEntry,
} from "./explainer-session-rules.js";
import type { ExplainerLogEvent } from "./explainer-stage.js";
import { buildNarratorCallRecord } from "./narrator-call-log.js";
import type { PipelineSyncSnapshot } from "./types.js";

// The session explainer (spec §6.1, phase C). It folds the current session's trace rows with the
// viewer's model, so every step id it cites is the id the viewer resolves, and writes explainer rows.
// onPipelineSync returns at once; folds run on syncChain, narrator calls one at a time on narration.

const FOLD_PAGE = 2_000;
const CLOSED_UNIT: ReadonlySet<ChangeUnit["status"]> = new Set<ChangeUnit["status"]>(["validated", "failed"]);

type Question = "sessionStory" | "decisionWhy";

interface Outcome {
  accepted: number;
  dropped: number;
  discarded: boolean;
  reasons: readonly string[];
  error: string | null;
}

export interface SessionExplainerDeps {
  db: JevcodeDb;
  repoRoot: string;
  sessionId(): string | null;
  /** Ruling R4: the stage's initialNarrator; setNarrator follows the switch. */
  narrator: NarratorClient | null;
  emitRowsAvailable(sessionId: string, lastSeq: number): void;
  now(): number;
  schedule: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
  log(event: ExplainerLogEvent): void;
  /** N-4's Inspect sink, one record per narrator call (built by buildNarratorCallRecord). */
  recordCall?(record: NarratorCallRecord): void;
  /** Minimum time between story narrations; default STORY_MIN_INTERVAL_MS. */
  storyIntervalMs?: number;
}

export interface SessionExplainer {
  onPipelineSync(sync: PipelineSyncSnapshot): void;
  /** Ruling R4: the stage's setNarrator forwards here. null turns narration off and aborts the call in flight (spec E15). */
  setNarrator(narrator: NarratorClient | null): void;
  /** Resolves once queued syncs and narrator calls have settled (dispose, tests). Timers are not awaited. */
  idle(): Promise<void>;
  dispose(): void;
}

interface Tracked {
  readonly sessionId: string;
  readonly fold: TraceState;
  cursor: number;
  session: TraceSession | null;
  sync: PipelineSyncSnapshot | null;
  seeded: boolean;
  /** Component ids of the first overview snapshot row with components in this session ("new" is against it). */
  initialComponentIds: ReadonlySet<string> | null;
  highlights: HighlightEntry[];
  highlightsKey: string | null;
  readonly seenUnits: Set<string>;
  readonly closedUnits: Set<string>;
  readonly answered: Set<string>;
  testRuns: number;
  terminalTurn: number;
  unitsAtStory: number;
  /** The last written story's input, and whether the narrator answered that input (a failed call did not). */
  storyKey: string | null;
  storyAsked: boolean;
  /** The last written story's sentences and provenance: an identical story is not written again. */
  storyText: string | null;
  storyPending: boolean;
  storyRunning: boolean;
  lastStoryAt: number | null;
  storyTimer: unknown;
  readonly whyQueue: string[];
  readonly whyDone: Set<string>;
  whyRunning: boolean;
  whyTimer: unknown;
}

/** Process-wide, so call record ids stay unique across explainer instances (one per repo). */
let recordSeq = 0;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbort(error: unknown): boolean {
  return error instanceof NarratorUnavailableError && error.reason === "aborted";
}

/** The narrator input is frozen once built: the guard reads exactly what was sent. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** The "new" baseline: a snapshot's component ids, or null when it has none (a scan still running). */
function componentIdsOf(snapshot: OverviewSnapshot): ReadonlySet<string> | null {
  return snapshot.components.length > 0 ? new Set(snapshot.components.map((component) => component.id)) : null;
}

function countRuns(session: TraceSession): number {
  let runs = 0;
  for (const step of session.steps) if (step.tests !== undefined && step.status !== "running") runs += 1;
  return runs;
}

function lastTerminalTurn(session: TraceSession): number {
  for (let i = session.turns.length - 1; i >= 0; i -= 1) {
    const turn = session.turns[i];
    if (turn !== undefined && (turn.outcome === "completed" || turn.outcome === "failed")) return turn.index;
  }
  return -1;
}

function storyTextOf(sentences: readonly NarrativeSentence[], provenance: "rule" | "model"): string {
  return JSON.stringify([provenance, sentences]);
}

export function createSessionExplainer(deps: SessionExplainerDeps): SessionExplainer {
  const interval = deps.storyIntervalMs ?? STORY_MIN_INTERVAL_MS;
  let narrator = deps.narrator;
  let tracked: Tracked | null = null;
  let disposed = false;
  let syncChain: Promise<void> = Promise.resolve();
  let narration: Promise<void> = Promise.resolve();
  /**
   * The latest unprocessed sync of each session. Per session, not one shared slot: another session's
   * sync must never overwrite the current session's (its agent_completed would be lost). Which session
   * is current is decided when the sync is processed, not when it arrives, so a switch in flight keeps
   * the latest sync of whichever session ends up current.
   */
  const pendingSyncs = new Map<string, PipelineSyncSnapshot>();
  let drainQueued = false;
  let inFlight: AbortController | null = null;
  // One backoff for every call of this explainer (spec §6.6): a provider fault is not per session.
  let failures = 0;
  let retryAt = 0;
  // Lane 05's schema brake: schema-valid answers so far, and schema-invalid ones since the last valid one.
  let validAnswers = 0;
  let invalidStreak = 0;

  const fail = (error: unknown): void => {
    try {
      deps.log({ kind: "error", where: "session", message: messageOf(error) });
    } catch {
      // A failing logger must not break the chains.
    }
  };

  const current = (t: Tracked): boolean => !disposed && tracked === t && deps.sessionId() === t.sessionId;

  /** Runs `task` on the narration chain, then `after`; neither can reject the chain. */
  function enqueue(task: () => Promise<void>, after: () => void): void {
    narration = narration.then(async () => {
      try {
        await task();
      } catch (error) {
        fail(error);
      }
      try {
        after();
      } catch (error) {
        fail(error);
      }
    });
  }

  function release(t: Tracked): void {
    if (t.storyTimer !== null) deps.schedule.clearTimeout(t.storyTimer);
    if (t.whyTimer !== null) deps.schedule.clearTimeout(t.whyTimer);
    t.storyTimer = null;
    t.whyTimer = null;
    t.whyQueue.length = 0;
  }

  function track(sessionId: string): Tracked | null {
    if (tracked !== null && tracked.sessionId === sessionId) return tracked;
    if (tracked !== null) {
      // A session switch: the old session's call can no longer write, so stop paying for it.
      release(tracked);
      inFlight?.abort();
    }
    tracked = null;
    const record = deps.db.getSession(sessionId);
    if (record === undefined) return null;
    const meta: TraceSessionSummary = {
      sessionId,
      repoId: record.repoId,
      repoName: "",
      prompt: record.prompt,
      state: record.state,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      lastEventSeq: record.lastEventSeq,
    };
    tracked = {
      sessionId, fold: createTraceState(meta), cursor: 0, session: null, sync: null, seeded: false,
      initialComponentIds: null, highlights: [], highlightsKey: null, seenUnits: new Set(), closedUnits: new Set(),
      answered: new Set(), testRuns: 0, terminalTurn: -1, unitsAtStory: 0, storyKey: null, storyAsked: false,
      storyText: null, storyPending: false, storyRunning: false, lastStoryAt: null, storyTimer: null, whyQueue: [],
      whyDone: new Set(), whyRunning: false, whyTimer: null,
    };
    return tracked;
  }

  /**
   * Folds the rows after the cursor, 2,000 per page with a yield between pages (spec §6.1). Null when the
   * explainer was disposed (the app quit closes the database next) or the session switched between pages.
   */
  async function advance(t: Tracked): Promise<TraceSession | null> {
    for (;;) {
      const events = deps.db.listEvents(t.sessionId, { fromSeq: t.cursor, limit: FOLD_PAGE });
      for (const event of events) {
        t.cursor = event.seq;
        if (!isTraceRowType(event.type)) continue;
        const payload = JSON.parse(event.payloadJson) as unknown;
        if (event.type === "overview_snapshot" && t.initialComponentIds === null) {
          // The fold drops a snapshot that fails the contract schema (an invalid_row gap), so the baseline does too.
          const parsed = OverviewSnapshotSchema.safeParse(payload);
          if (parsed.success) t.initialComponentIds = componentIdsOf(parsed.data);
        }
        accumulate(t.fold, { seq: event.seq, type: event.type, ts: event.ts, payload });
      }
      if (events.length < FOLD_PAGE) break;
      await yieldToEventLoop();
      if (!current(t)) return null;
    }
    const state = deps.db.getSession(t.sessionId)?.state;
    t.session = finalize(t.fold, { live: true, throughSeq: t.cursor, ...(state !== undefined ? { state } : {}) });
    return t.session;
  }

  /** Spec §6.1: rows only through the event store, each followed by its push hint. */
  function append(t: Tracked, record: ExplainerRecord): void {
    const stored = deps.db.appendEvent(t.sessionId, "explainer", record);
    try {
      deps.emitRowsAvailable(t.sessionId, stored.seq);
    } catch (error) {
      fail(error);
    }
  }

  /** Spec §6.3: one narrator log event and one call record (through lane 05's builder) per call. */
  function record(question: Question, started: number, outcome: Outcome, result: NarratorResult<unknown> | null): void {
    const ms = Math.max(0, Math.round(deps.now() - started));
    try {
      deps.log({
        kind: "narrator",
        question,
        ms,
        accepted: outcome.accepted,
        dropped: outcome.dropped,
        discarded: outcome.discarded,
        ...(outcome.error === null ? {} : { error: outcome.error }),
        ...(outcome.reasons.length > 0 ? { reasons: outcome.reasons.slice(0, 40) } : {}),
      });
    } catch {
      // A failing logger must not lose the call record or the answer.
    }
    recordSeq += 1;
    const entry = buildNarratorCallRecord({
      id: `narr_session_${started.toString(36)}_${recordSeq.toString(36)}`,
      at: deps.now(),
      repoRoot: deps.repoRoot,
      question,
      model: result?.model ?? NARRATOR_MODEL,
      ms,
      batchSize: 1,
      accepted: outcome.accepted,
      dropped: outcome.dropped,
      discarded: outcome.discarded,
      usage: result?.usage ?? null,
      error: outcome.error,
      reasons: outcome.reasons,
    });
    if (entry === null) return;
    try {
      deps.recordCall?.(entry);
    } catch {
      // A failing recorder must not undo the call's result.
    }
  }

  /** A provider fault backs off 30 s, 2 min, 10 min (spec §6.6); switching the narrator off is not one. */
  function failed(error: unknown): void {
    if (isAbort(error)) return;
    failures += 1;
    retryAt = deps.now() + backoffMs(failures);
  }

  function answered(): void {
    failures = 0;
  }

  /**
   * Lane 05's brake (SCHEMA_BRAKE_STREAK): until this explainer has had a schema-valid answer, the
   * third schema-invalid answer in a row reads as a provider fault and backs off. True when braked.
   */
  function schemaAnswer(valid: boolean): boolean {
    if (valid) {
      validAnswers += 1;
      invalidStreak = 0;
      return false;
    }
    invalidStreak += 1;
    return validAnswers === 0 && invalidStreak >= SCHEMA_BRAKE_STREAK;
  }

  function seed(t: Tracked, session: TraceSession, sync: PipelineSyncSnapshot): void {
    t.seeded = true;
    const explainer = session.explainer;
    for (const decisionId of explainer.decisionWhy.keys()) t.whyDone.add(decisionId);
    if (explainer.highlights !== null) {
      const entries = [...explainer.highlights.byComponent.entries()]
        .map(([id, entry]) => ({
          id,
          state: entry.state,
          // Same shape computeHighlights writes: `states` only when more than the strongest state applies.
          ...(entry.states.length > 1 ? { states: [...entry.states] } : {}),
          unitIds: [...entry.unitIds],
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      t.highlightsKey = JSON.stringify(entries);
    }
    if (explainer.story === null) return;
    // Narrated before (an app restart): the events up to now are already in the story.
    t.storyText = storyTextOf(explainer.story.sentences, explainer.story.provenance);
    for (const unit of sync.changeUnits) {
      t.seenUnits.add(unit.id);
      if (CLOSED_UNIT.has(unit.status)) t.closedUnits.add(unit.id);
    }
    for (const decision of sync.decisions) {
      if (decision.status !== "answered" && decision.status !== "delegated") continue;
      t.answered.add(decision.id);
      if (!t.whyDone.has(decision.id)) t.whyQueue.push(decision.id);
    }
    t.testRuns = countRuns(session);
    t.terminalTurn = lastTerminalTurn(session);
    t.unitsAtStory = t.seenUnits.size;
  }

  /** Spec §6.1 triggers (lane "Spec alignment notes"); also queues a why per newly answered decision. */
  function detect(t: Tracked, session: TraceSession, sync: PipelineSyncSnapshot): boolean {
    let trigger = false;
    for (const unit of sync.changeUnits) {
      t.seenUnits.add(unit.id);
      if (CLOSED_UNIT.has(unit.status) && !t.closedUnits.has(unit.id)) {
        t.closedUnits.add(unit.id);
        trigger = true;
      }
    }
    if (t.seenUnits.size - t.unitsAtStory >= STORY_UNIT_THRESHOLD) trigger = true;
    for (const decision of sync.decisions) {
      if ((decision.status === "answered" || decision.status === "delegated") && !t.answered.has(decision.id)) {
        t.answered.add(decision.id);
        if (!t.whyDone.has(decision.id)) t.whyQueue.push(decision.id);
        trigger = true;
      }
    }
    const runs = countRuns(session);
    if (runs > t.testRuns) {
      t.testRuns = runs;
      trigger = true;
    }
    const terminal = lastTerminalTurn(session);
    if (terminal > t.terminalTurn) {
      t.terminalTurn = terminal;
      trigger = true;
    }
    return trigger;
  }

  async function process(sync: PipelineSyncSnapshot): Promise<void> {
    if (disposed || deps.sessionId() !== sync.sessionId) return;
    const t = track(sync.sessionId);
    if (t === null) return;
    const session = await advance(t);
    if (session === null || !current(t)) return;
    t.sync = sync;
    if (!t.seeded) seed(t, session, sync);
    const highlights = computeHighlights({
      units: sync.changeUnits,
      decisions: sync.decisions,
      overview: session.overview,
      initialComponentIds: t.initialComponentIds,
      failingFiles: failingTestFiles(session),
    });
    t.highlights = highlights;
    const key = JSON.stringify(highlights);
    if (key !== t.highlightsKey && (highlights.length > 0 || t.highlightsKey !== null)) {
      append(t, { sessionId: t.sessionId, kind: "highlights", basisSeq: session.loadedThroughSeq, components: highlights });
      t.highlightsKey = key;
    }
    if (detect(t, session, sync)) {
      t.storyPending = true;
      kick(t);
    }
    pumpWhy(t);
  }

  /** Leading edge, then at most one story per interval, with one trailing story within an interval of a trigger. */
  function kick(t: Tracked): void {
    if (!current(t) || !t.storyPending || t.storyRunning || t.storyTimer !== null) return;
    const wait = t.lastStoryAt === null ? 0 : t.lastStoryAt + interval - deps.now();
    if (wait > 0) {
      t.storyTimer = deps.schedule.setTimeout(() => {
        t.storyTimer = null;
        kick(t);
      }, wait);
      return;
    }
    t.storyPending = false;
    t.storyRunning = true;
    enqueue(
      () => story(t),
      () => {
        t.storyRunning = false;
        kick(t);
        pumpWhy(t);
      },
    );
  }

  /** The guarded narration of `input`, or null; `asked` is false when no answer came (a failure or an abort). */
  async function narrateStory(client: NarratorClient, input: SessionStoryInput): Promise<{ sentences: NarrativeSentence[] | null; asked: boolean }> {
    const started = deps.now();
    const controller = new AbortController();
    inFlight = controller;
    try {
      let result: NarratorResult<NarrativeSentence[]>;
      try {
        result = await client.sessionStory(input, { signal: controller.signal });
      } catch (error) {
        failed(error);
        record("sessionStory", started, { accepted: 0, dropped: 0, discarded: false, reasons: [], error: failureReason(error) }, null);
        return { sentences: null, asked: false };
      }
      if (controller.signal.aborted) {
        // Turned off while the answer was on its way (spec E15): recorded, never shown.
        record("sessionStory", started, { accepted: 0, dropped: 0, discarded: true, reasons: [], error: "aborted" }, result);
        return { sentences: null, asked: false };
      }
      if (!result.schemaValid) {
        const braked = schemaAnswer(false);
        if (braked) failed(new NarratorUnavailableError("unavailable", "schema"));
        else answered();
        record("sessionStory", started, { accepted: 0, dropped: 0, discarded: true, reasons: [], error: "schema" }, result);
        return { sentences: null, asked: !braked };
      }
      schemaAnswer(true);
      answered();
      if (result.heuristic === true) {
        record("sessionStory", started, { accepted: 0, dropped: 0, discarded: true, reasons: ["heuristic"], error: null }, result);
        return { sentences: null, asked: true };
      }
      // Guarded against exactly the (frozen) input that was sent.
      const guard = guardSessionStory(result.value, input);
      record(
        "sessionStory",
        started,
        { accepted: guard.accepted.length, dropped: guard.dropped, discarded: guard.discarded, reasons: guard.reasons, error: null },
        result,
      );
      return { sentences: guard.discarded || guard.accepted.length === 0 ? null : guard.accepted, asked: true };
    } finally {
      if (inFlight === controller) inFlight = null;
    }
  }

  async function story(t: Tracked): Promise<void> {
    const session = t.session;
    const sync = t.sync;
    if (session === null || sync === null || !current(t)) return;
    const input = deepFreeze(sessionStoryInput(session, sync.decisions, t.highlights));
    const key = JSON.stringify(input);
    const client = narrator;
    const canCall = client !== null && deps.now() >= retryAt;
    t.unitsAtStory = t.seenUnits.size;
    // Spec §6.1: a story whose input equals the last narrated input is skipped.
    if (key === t.storyKey && (t.storyAsked || !canCall)) return;
    t.lastStoryAt = deps.now();
    const basisSeq = session.loadedThroughSeq;
    const narrated = canCall && client !== null ? await narrateStory(client, input) : { sentences: null, asked: false };
    if (!current(t)) return;
    const provenance = narrated.sentences !== null ? "model" : "rule";
    const sentences = narrated.sentences ?? ruleStory(session, input, sync.changeUnits, t.highlights);
    t.storyKey = key;
    t.storyAsked = narrated.asked;
    if (sentences.length === 0) return;
    const text = storyTextOf(sentences, provenance);
    if (text === t.storyText) return;
    append(t, { sessionId: t.sessionId, kind: "story", sentences, basisSeq, provenance });
    t.storyText = text;
  }

  function armWhyRetry(t: Tracked): void {
    if (t.whyTimer !== null) return;
    t.whyTimer = deps.schedule.setTimeout(() => {
      t.whyTimer = null;
      pumpWhy(t);
    }, Math.max(0, retryAt - deps.now()));
  }

  /** One why at a time, after the story chain; during a backoff the queue waits for its end. */
  function pumpWhy(t: Tracked): void {
    if (!current(t)) return;
    const client = narrator;
    if (client === null) {
      t.whyQueue.length = 0;
      return;
    }
    if (t.whyRunning || t.storyRunning || t.whyQueue.length === 0) return;
    if (deps.now() < retryAt) {
      armWhyRetry(t);
      return;
    }
    const decisionId = t.whyQueue.shift();
    if (decisionId === undefined) return;
    t.whyRunning = true;
    enqueue(
      () => why(t, client, decisionId),
      () => {
        t.whyRunning = false;
        pumpWhy(t);
        kick(t);
      },
    );
  }

  async function why(t: Tracked, client: NarratorClient, decisionId: string): Promise<void> {
    // Settled since it was queued (setNarrator re-queues while a why is in flight): one why per decision.
    if (t.whyDone.has(decisionId)) return;
    const session = t.session;
    const decision = t.sync?.decisions.find((candidate) => candidate.id === decisionId);
    if (session === null || decision === undefined || !current(t)) return;
    const input = decisionWhyInput(session, decision);
    if (input === null || input.nearby.length === 0 || decisionId.length > EXPLAINER_ID_MAX) {
      // Nothing nearby to ground a reason in (or an id the row cannot hold): settled without a call.
      // Not a failure: no backoff, no failure count, never asked again.
      t.whyDone.add(decisionId);
      return;
    }
    deepFreeze(input);
    const started = deps.now();
    const controller = new AbortController();
    inFlight = controller;
    try {
      let result: NarratorResult<NarrativeSentence | null>;
      try {
        result = await client.decisionWhy(input, { signal: controller.signal });
      } catch (error) {
        failed(error);
        // Retried once the backoff ends; an abort waits for the narrator to come back (setNarrator).
        if (!isAbort(error) && narrator !== null && current(t)) t.whyQueue.unshift(decisionId);
        record("decisionWhy", started, { accepted: 0, dropped: 0, discarded: false, reasons: [], error: failureReason(error) }, null);
        return;
      }
      if (controller.signal.aborted) {
        record("decisionWhy", started, { accepted: 0, dropped: 0, discarded: true, reasons: [], error: "aborted" }, result);
        return;
      }
      if (!result.schemaValid) {
        const braked = schemaAnswer(false);
        if (braked) {
          // A provider fault, not this decision's: asked again after the backoff.
          failed(new NarratorUnavailableError("unavailable", "schema"));
          if (narrator !== null && current(t)) t.whyQueue.unshift(decisionId);
        } else {
          answered();
          t.whyDone.add(decisionId);
        }
        record("decisionWhy", started, { accepted: 0, dropped: 0, discarded: true, reasons: [], error: "schema" }, result);
        return;
      }
      schemaAnswer(true);
      answered();
      t.whyDone.add(decisionId);
      // Guarded against exactly the (frozen) input that was sent; a null answer guards as an empty batch.
      const guard = guardDecisionWhy(result.value, input);
      record(
        "decisionWhy",
        started,
        { accepted: guard.accepted.length, dropped: guard.dropped, discarded: guard.discarded, reasons: guard.reasons, error: null },
        result,
      );
      const sentence = guard.discarded ? undefined : guard.accepted[0];
      if (sentence !== undefined && current(t)) append(t, { sessionId: t.sessionId, kind: "decision_why", decisionId, sentence });
    } finally {
      if (inFlight === controller) inFlight = null;
    }
  }

  return {
    onPipelineSync(sync) {
      if (disposed) return;
      // Each sync carries the session's whole unit and decision lists, so a burst folds once per session,
      // for its latest sync; process() skips every session that is not current by then.
      pendingSyncs.set(sync.sessionId, sync);
      if (drainQueued) return;
      drainQueued = true;
      syncChain = syncChain.then(async () => {
        drainQueued = false;
        const batch = [...pendingSyncs.values()];
        pendingSyncs.clear();
        for (const next of batch) {
          try {
            await process(next);
          } catch (error) {
            fail(error);
          }
        }
      });
    },
    setNarrator(next) {
      if (disposed) return;
      narrator = next;
      const t = tracked;
      if (next === null) {
        inFlight?.abort();
        if (t !== null) {
          t.whyQueue.length = 0;
          if (t.whyTimer !== null) deps.schedule.clearTimeout(t.whyTimer);
          t.whyTimer = null;
        }
        return;
      }
      if (t === null) return;
      // Back on: explain the decisions answered while it was off (or whose call it aborted).
      for (const decisionId of t.answered) {
        if (!t.whyDone.has(decisionId) && !t.whyQueue.includes(decisionId)) t.whyQueue.push(decisionId);
      }
      pumpWhy(t);
    },
    async idle() {
      for (;;) {
        const syncs = syncChain;
        const calls = narration;
        await Promise.all([syncs, calls]);
        if (syncs === syncChain && calls === narration) return;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      inFlight?.abort();
      if (tracked !== null) release(tracked);
      tracked = null;
      pendingSyncs.clear();
    },
  };
}
