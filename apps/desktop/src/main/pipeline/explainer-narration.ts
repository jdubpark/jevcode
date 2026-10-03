import { createHash } from "node:crypto";

import { OTHER_ROOT_PATH, componentIdFor } from "@jevcode/codebase-map";
import type { Component, ComponentEdge, NarrativeSentence, NarratorState, OverviewSnapshot, Role } from "@jevcode/contracts";
import {
  NARRATOR_MODEL,
  NarratorUnavailableError,
  citationResolves,
  guardComponents,
  guardSentences,
  mentionsOtherComponent,
  narratorCostUsd,
  plainTextViolation,
} from "@jevcode/jev-router";
import type {
  CitationUniverse,
  ComponentBrief,
  DescribedComponent,
  NarratorClient,
  NarratorResult,
  OverviewNarrativeInput,
} from "@jevcode/jev-router";
import type { JevcodeDb } from "@jevcode/storage";

import { NARRATOR_RECORD_TEXT_MAX } from "../../shared/narrator-log.js";
import type { NarratorAvailability, NarratorCallRecord } from "../../shared/narrator-log.js";
import { blurbFrom, exportIdentifiers } from "./explainer-narration-sources.js";

export const DESCRIBE_BATCH_SIZE = 20;
export const DESCRIBE_MAX_IN_FLIGHT = 2;
export const NARRATOR_BACKOFF_MS = [30_000, 120_000, 600_000] as const;
export const NARRATIVE_CHANGE_FRACTION = 0.1;
export const NARRATIVE_TOP_EDGES = 40;
export const NARRATIVE_MAX_SENTENCES = 8;
export const BRIEF_EDGE_LIMIT = 10;

export interface BriefSources {
  /** Redacted, at most 600 characters (spec §6.2); the narration redacts and clips it again. */
  blurb(component: Component): Promise<string | null>;
  /** Only identifiers reach a brief; the narration filters whatever this returns. */
  exports(component: Component): Promise<string[]>;
}

/** One component_text_cache row (interfaces §2). `purpose: null` is the negative cache. */
export interface CachedText {
  purpose: string | null;
  role: Role;
  model: string;
}

/** What `textFor` hands lane 04's assembleSnapshot; structurally its `ComponentText`. */
export interface ModelText {
  purpose: string;
  role: Role;
  provenance: "model";
}

/** Anything with an id, a name and a content hash: lane 04's ComponentDraft, or a snapshot Component. */
export interface ComponentRef {
  id: string;
  name: string;
  contentHash: string;
}

/**
 * Structurally members of interfaces §5 ExplainerLogEvent (lane 04): one "narrator" event per
 * call, and an "error" event for a storage ("state") or stage refresh ("rebuild") failure.
 */
export type NarrationLogEvent =
  | {
      kind: "narrator";
      question: "describeComponents" | "overviewNarrative" | "sessionStory" | "decisionWhy";
      ms: number;
      accepted: number;
      dropped: number;
      discarded: boolean;
      error?: string;
    }
  | { kind: "error"; where: "state" | "rebuild"; message: string };

export type NarrationState = "off" | "idle" | "describing" | "backoff" | "ready";

export interface NarrationStatus {
  state: NarrationState;
  described: number;
  total: number;
  retryAt: number | null;
}

export interface ExplainerNarrationDeps {
  db: JevcodeDb;
  repoRoot: string;
  narrator: NarratorClient | null;
  /** Default brief sources; onSnapshot may pass per-snapshot sources (N-5 seam). */
  sources: BriefSources;
  /**
   * Lane 04's NarrationContext.refresh: the stage re-assembles the snapshot from textFor and
   * narrative, writes a row only if the content (or the narrator status) changed, and hands the
   * result back through onSnapshot (re-entrant).
   */
  refresh(): void;
  now(): number;
  schedule: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
  log(event: NarrationLogEvent): void;
  recordCall?(record: NarratorCallRecord): void;
  onStatus?(status: NarrationStatus): void;
  /** Why the narrator is null (N-4 switch): "off_no_key" reads as "unavailable"; absent reads as "off". */
  narratorAvailability?(): NarratorAvailability;
}

export interface ExplainerNarration {
  /** Synchronous, 0 calls: model purposes and confirmed roles from component_text_cache (NarrationSeam.textFor). */
  textFor(components: readonly ComponentRef[]): ReadonlyMap<string, ModelText>;
  /** Synchronous, 0 calls: the stored narrative while every sentence still passes the guard for this snapshot, else null. */
  narrative(snapshot: OverviewSnapshot): OverviewSnapshot["narrative"];
  /** textFor plus narrative applied to a finished snapshot (tests and tools). */
  applyCached(snapshot: OverviewSnapshot): OverviewSnapshot;
  /** The stage published this snapshot: describe uncached components, then refresh the narrative if needed. */
  onSnapshot(snapshot: OverviewSnapshot, sources?: BriefSources): void;
  /** null turns every call off and aborts in-flight calls (spec E15). */
  setNarrator(narrator: NarratorClient | null): void;
  /** R3 status.narrator (NarrationSeam.narratorStatus). */
  narratorStatus(): NarratorState;
  status(): NarrationStatus;
  /** Resolves when no call is in flight (tests and smoke). */
  idle(): Promise<void>;
  dispose(): void;
}

type Question = "describeComponents" | "overviewNarrative";

interface Outcome {
  accepted: number;
  dropped: number;
  discarded: boolean;
  reasons: readonly string[];
  error: string | null;
}

interface StoredNarrative {
  hash: string | null;
  narrative: OverviewSnapshot["narrative"];
}

type ReadTarget = "component_text_cache" | "overview_state";

const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");

/** Lane 04's group of the smallest components past the 200 cap. */
const OTHER_COMPONENT_ID = componentIdFor(OTHER_ROOT_PATH);

/** Process-wide, so call record ids stay unique across narration instances (one per repo). */
let recordSeq = 0;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isOtherGroup(component: Component): boolean {
  return component.rootPath === OTHER_ROOT_PATH || component.id === OTHER_COMPONENT_ID;
}

const namesOf = (components: readonly { name: string }[]): ReadonlySet<string> =>
  new Set(components.map((component) => component.name));

/** R3 mapping: off = setting off; unavailable = no key or failure backoff; pending = writing; ready = done. */
export function narratorStateOf(status: NarrationStatus, availability: NarratorAvailability | undefined): NarratorState {
  switch (status.state) {
    case "off":
      return availability === "off_no_key" ? "unavailable" : "off";
    case "backoff":
      return "unavailable";
    case "idle":
    case "describing":
      return "pending";
    case "ready":
      return "ready";
  }
}

export function buildCitationUniverse(snapshot: OverviewSnapshot): CitationUniverse {
  const files = new Set<string>();
  for (const component of snapshot.components) {
    for (const file of component.files) files.add(file);
    for (const file of component.entryPoints) files.add(file);
  }
  return {
    components: new Set(snapshot.components.map((component) => component.id)),
    files,
    decisions: new Set(),
    facts: new Set(),
    steps: new Set(),
    componentNames: namesOf(snapshot.components),
    componentNameById: new Map(snapshot.components.map((component) => [component.id, component.name] as const)),
  };
}

export function buildComponentBrief(
  component: Component,
  snapshot: OverviewSnapshot,
  extras: { blurb: string | null; exports: readonly string[] },
): ComponentBrief {
  const nameById = new Map(snapshot.components.map((entry) => [entry.id, entry.name] as const));
  const edgeList = (edges: readonly ComponentEdge[], other: (edge: ComponentEdge) => string) =>
    [...edges]
      .sort((a, b) => b.count - a.count || other(a).localeCompare(other(b)))
      .slice(0, BRIEF_EDGE_LIMIT)
      .map((edge) => ({ name: nameById.get(other(edge)) ?? other(edge), count: edge.count }));
  return {
    id: component.id,
    name: component.name,
    rootPath: component.rootPath,
    roleGuess: component.roleGuess,
    files: [...new Set([...component.entryPoints, ...component.files])].slice(0, 20),
    exports: extras.exports.slice(0, 15),
    externalDeps: component.externalDeps.slice(0, 8).map((dep) => dep.name),
    edgesIn: edgeList(snapshot.edges.filter((edge) => edge.to === component.id), (edge) => edge.from),
    edgesOut: edgeList(snapshot.edges.filter((edge) => edge.from === component.id), (edge) => edge.to),
    blurb: extras.blurb,
  };
}

export function applyNarration(
  snapshot: OverviewSnapshot,
  lookup: (component: Component) => CachedText | undefined,
): OverviewSnapshot {
  return {
    ...snapshot,
    components: snapshot.components.map((component) => {
      const text = lookup(component);
      if (text === undefined || text.purpose === null) return component;
      return { ...component, purpose: text.purpose, role: text.role, provenance: "model" as const };
    }),
  };
}

/** Changes exactly when the component set or a role band changes (spec §6.1). */
export function narrativeStructureHash(snapshot: OverviewSnapshot): string {
  return sha1(snapshot.components.map((component) => `${component.id}:${component.role}`).sort().join("\n"));
}

export function changedFraction(base: ReadonlyMap<string, string>, current: ReadonlyMap<string, string>): number {
  let changed = 0;
  for (const [id, hash] of current) if (base.get(id) !== hash) changed += 1;
  for (const id of base.keys()) if (!current.has(id)) changed += 1;
  return changed / Math.max(1, current.size);
}

export function topEdges(
  snapshot: OverviewSnapshot,
  limit: number = NARRATIVE_TOP_EDGES,
): { from: string; to: string; count: number }[] {
  return [...snapshot.edges]
    .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
    .slice(0, limit)
    .map((edge) => ({ from: edge.from, to: edge.to, count: edge.count }));
}

export function narrativeResolves(
  narrative: NonNullable<OverviewSnapshot["narrative"]>,
  universe: CitationUniverse,
): boolean {
  return narrative.sentences.every((sentence) => sentence.citations.every((citation) => citationResolves(citation, universe)));
}

/**
 * The read side of guardComponents: a cached purpose is served only while it is still plain text
 * and names no other component of the current set. A negative-cache row (no purpose) always is.
 */
function cachedTextUsable(text: CachedText, ownName: string | undefined, names: ReadonlySet<string>): boolean {
  if (text.purpose === null) return true;
  return plainTextViolation(text.purpose) === null && !mentionsOtherComponent(text.purpose, ownName, names);
}

/** The stored narrative re-guarded against the current citation universe; null when any sentence fails. */
function servableNarrative(
  narrative: OverviewSnapshot["narrative"],
  universe: CitationUniverse,
): OverviewSnapshot["narrative"] {
  if (narrative === null) return null;
  const guarded = guardSentences(narrative.sentences, universe, { max: NARRATIVE_MAX_SENTENCES });
  if (guarded.discarded || guarded.dropped > 0 || guarded.accepted.length !== narrative.sentences.length) return null;
  return { sentences: guarded.accepted, provenance: "model" };
}

function failureReason(error: unknown): string {
  return error instanceof NarratorUnavailableError ? error.reason : "unavailable";
}

/** A source that throws (synchronously or not) contributes nothing. */
async function settled<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

export function createExplainerNarration(deps: ExplainerNarrationDeps): ExplainerNarration {
  let narrator = deps.narrator;
  let latest: OverviewSnapshot | null = null;
  let latestSources: BriefSources = deps.sources;
  let disposed = false;
  let generation = 0;
  let describeCalls = 0;
  let narrativeInFlight = false;
  let backoffLevel = 0;
  let backoffUntil = 0;
  let retryTimer: unknown = null;
  let refreshTimer: unknown = null;
  let baseline: ReadonlyMap<string, string> | null = null;
  let stored: StoredNarrative | null | undefined;
  let abandonedNarrative: string | null = null;
  let lastStatusKey = "";
  const inFlight = new Set<string>();
  /** Components whose batch failed outside the provider call (a bug, not the network); never retried. */
  const abandoned = new Set<string>();
  const controllers = new Set<AbortController>();
  /** Every row read or answered in this instance; it holds an answer even when its DB write failed. */
  const textMemo = new Map<string, CachedText>();
  const failingReads = new Set<ReadTarget>();
  const idleWaiters: (() => void)[] = [];

  const keyOf = (component: { id: string; contentHash: string }): string => `${component.id}@${component.contentHash}`;

  /** Storage and refresh failures: logged, never a provider backoff, never a reason to ask again. */
  function logError(where: "state" | "rebuild", message: string): void {
    try {
      deps.log({ kind: "error", where, message: `narration: ${message}` });
    } catch {
      // A failing logger must not break narration.
    }
  }

  /** A broken database fails every lookup; report the first failure of each read until one succeeds. */
  function readFailed(target: ReadTarget, error: unknown): void {
    if (failingReads.has(target)) return;
    failingReads.add(target);
    logError("state", `${target} read failed: ${messageOf(error)}`);
  }

  function cachedRow(component: ComponentRef): CachedText | undefined {
    const key = keyOf(component);
    const memo = textMemo.get(key);
    if (memo !== undefined) return memo;
    let found: CachedText | undefined;
    try {
      found = deps.db.getComponentText(deps.repoRoot, component.id, component.contentHash);
      failingReads.delete("component_text_cache");
    } catch (error) {
      readFailed("component_text_cache", error);
      return undefined;
    }
    if (found !== undefined) textMemo.set(key, found);
    return found;
  }

  /** A cached row that fails the read-side guard is a miss: not served, and asked for again. */
  function lookup(component: ComponentRef, names: ReadonlySet<string>): CachedText | undefined {
    const row = cachedRow(component);
    return row !== undefined && cachedTextUsable(row, component.name, names) ? row : undefined;
  }

  function writeTexts(entries: readonly (readonly [Component, CachedText])[]): void {
    let failed = 0;
    let firstError: unknown = null;
    for (const [component, text] of entries) {
      try {
        deps.db.putComponentText(deps.repoRoot, component.id, component.contentHash, text);
      } catch (error) {
        if (failed === 0) firstError = error;
        failed += 1;
      }
    }
    if (failed > 0) {
      logError("state", `component_text_cache write failed for ${failed} of ${entries.length}: ${messageOf(firstError)}`);
    }
  }

  function storedNarrative(): StoredNarrative | null {
    if (stored !== undefined) return stored;
    try {
      const state = deps.db.getOverviewState(deps.repoRoot);
      failingReads.delete("overview_state");
      stored = state === undefined ? null : { hash: state.narrativeInputsHash, narrative: state.narrative };
      return stored;
    } catch (error) {
      readFailed("overview_state", error);
      return null;
    }
  }

  /**
   * Lane 04's stage is the only writer of stored snapshots: with a stored state, only the narrative
   * columns change. The first narrative of a repo with no stored state stores this snapshot.
   */
  function writeNarrative(snapshot: OverviewSnapshot, hash: string, narrative: OverviewSnapshot["narrative"]): void {
    try {
      const previous = deps.db.getOverviewState(deps.repoRoot);
      deps.db.putOverviewState(
        deps.repoRoot,
        previous === undefined
          ? { snapshot: { ...snapshot, narrative }, narrativeInputsHash: hash, narrative }
          : { snapshot: previous.snapshot, narrativeInputsHash: hash, narrative },
      );
    } catch (error) {
      logError("state", `overview_state write failed: ${messageOf(error)}`);
    }
  }

  function refreshStage(): void {
    try {
      deps.refresh();
    } catch (error) {
      logError("rebuild", `stage refresh failed: ${messageOf(error)}`);
    }
  }

  function textFor(components: readonly ComponentRef[]): ReadonlyMap<string, ModelText> {
    const names = namesOf(components);
    const out = new Map<string, ModelText>();
    for (const component of components) {
      const text = lookup(component, names);
      if (text !== undefined && text.purpose !== null) {
        out.set(component.id, { purpose: text.purpose, role: text.role, provenance: "model" });
      }
    }
    return out;
  }

  function narrative(snapshot: OverviewSnapshot): OverviewSnapshot["narrative"] {
    const state = storedNarrative();
    return state === null ? null : servableNarrative(state.narrative, buildCitationUniverse(snapshot));
  }

  function withCachedText(snapshot: OverviewSnapshot): OverviewSnapshot {
    const names = namesOf(snapshot.components);
    return applyNarration(snapshot, (component) => lookup(component, names));
  }

  function applyCached(snapshot: OverviewSnapshot): OverviewSnapshot {
    const withText = withCachedText(snapshot);
    return { ...withText, narrative: narrative(withText) };
  }

  function narratable(snapshot: OverviewSnapshot): Component[] {
    return snapshot.components.filter((component) => !isOtherGroup(component));
  }

  function pendingComponents(snapshot: OverviewSnapshot): Component[] {
    const names = namesOf(snapshot.components);
    return narratable(snapshot).filter(
      (component) => !abandoned.has(keyOf(component)) && lookup(component, names) === undefined,
    );
  }

  function status(): NarrationStatus {
    const total = latest === null ? 0 : narratable(latest).length;
    const described = latest === null ? 0 : total - pendingComponents(latest).length;
    const now = deps.now();
    let state: NarrationState;
    if (narrator === null) state = "off";
    else if (now < backoffUntil && describeCalls === 0 && !narrativeInFlight) state = "backoff";
    else if (latest === null) state = "idle";
    else if (describeCalls > 0 || narrativeInFlight || described < total) state = "describing";
    else state = "ready";
    return { state, described, total, retryAt: backoffUntil > now ? backoffUntil : null };
  }

  function narratorStatus(): NarratorState {
    return narratorStateOf(status(), deps.narratorAvailability?.());
  }

  let lastNarratorState: NarratorState = narratorStatus();

  /** A status-only change reaches status.narrator through one deferred stage refresh. */
  function requestStatusRefresh(): void {
    if (refreshTimer !== null || disposed) return;
    refreshTimer = deps.schedule.setTimeout(() => {
      refreshTimer = null;
      if (!disposed) refreshStage();
    }, 0);
  }

  function emitStatus(): void {
    try {
      const next = status();
      const key = JSON.stringify(next);
      if (key !== lastStatusKey) {
        lastStatusKey = key;
        deps.onStatus?.(next);
      }
      const state = narratorStateOf(next, deps.narratorAvailability?.());
      if (state !== lastNarratorState) {
        lastNarratorState = state;
        requestStatusRefresh();
      }
    } catch (error) {
      logError("rebuild", `status update failed: ${messageOf(error)}`);
    }
  }

  function busy(): boolean {
    return describeCalls > 0 || narrativeInFlight;
  }

  function settleIdle(): void {
    if (busy()) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  }

  /** One log event and one call record per narrator call (spec §6.3); neither sink can throw into narration. */
  function record(question: Question, batchSize: number, started: number, outcome: Outcome, result: NarratorResult<unknown> | null): void {
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
      });
    } catch {
      // A failing logger must not lose the call record or the answer.
    }
    recordSeq += 1;
    const usage = result?.usage ?? null;
    try {
      deps.recordCall?.({
        id: `narr_${started.toString(36)}_${recordSeq.toString(36)}`,
        ts: new Date(deps.now()).toISOString(),
        repoRoot: deps.repoRoot,
        question,
        // The model name comes from the provider; both fields are capped for Inspect (NarratorCallRecordSchema).
        model: (result?.model ?? NARRATOR_MODEL).slice(0, NARRATOR_RECORD_TEXT_MAX),
        ms,
        batchSize,
        accepted: outcome.accepted,
        dropped: outcome.dropped,
        discarded: outcome.discarded,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        costUsd: usage === null ? null : narratorCostUsd(usage),
        error: outcome.error === null ? null : outcome.error.slice(0, NARRATOR_RECORD_TEXT_MAX),
        reasons: outcome.reasons.slice(0, 40),
      });
    } catch {
      // A failing recorder must not undo the call's result.
    }
  }

  function armRetry(): void {
    if (retryTimer !== null || disposed) return;
    retryTimer = deps.schedule.setTimeout(() => {
      retryTimer = null;
      pump();
    }, Math.max(0, backoffUntil - deps.now()));
  }

  function onSuccess(): void {
    backoffLevel = 0;
    backoffUntil = 0;
  }

  /** Provider failures only: a rejected call or a schema-invalid answer. */
  function onFailure(question: Question, batchSize: number, started: number, reason: string, result: NarratorResult<unknown> | null): void {
    const now = deps.now();
    if (now >= backoffUntil) backoffLevel = Math.min(backoffLevel + 1, NARRATOR_BACKOFF_MS.length);
    const delay: number = NARRATOR_BACKOFF_MS[backoffLevel - 1] ?? 600_000;
    backoffUntil = now + delay;
    record(question, batchSize, started, { accepted: 0, dropped: batchSize, discarded: true, reasons: [], error: reason }, result);
    armRetry();
  }

  /** A call cut off by setNarrator or dispose is still recorded (the provider may bill it), never backed off. */
  function recordAborted(question: Question, batchSize: number, started: number, result: NarratorResult<unknown> | null): void {
    record(question, batchSize, started, { accepted: 0, dropped: batchSize, discarded: true, reasons: [], error: "aborted" }, result);
  }

  /** Redaction, the 600-character clip and the identifier filter apply to every BriefSources (spec §6.2). */
  async function briefFor(component: Component, snapshot: OverviewSnapshot, sources: BriefSources): Promise<ComponentBrief> {
    const [blurb, exported] = await Promise.all([
      settled<unknown>(() => sources.blurb(component), null),
      settled<unknown>(() => sources.exports(component), []),
    ]);
    return buildComponentBrief(component, snapshot, {
      blurb: typeof blurb === "string" ? blurbFrom(blurb) : null,
      exports: Array.isArray(exported) ? exportIdentifiers(exported) : [],
    });
  }

  async function describe(snapshot: OverviewSnapshot, batch: Component[]): Promise<void> {
    const client = narrator;
    if (client === null) return;
    const gen = generation;
    const sources = latestSources;
    const controller = new AbortController();
    controllers.add(controller);
    describeCalls += 1;
    for (const component of batch) inFlight.add(keyOf(component));
    try {
      const briefs = await Promise.all(batch.map((component) => briefFor(component, snapshot, sources)));
      if (gen !== generation || disposed) return;
      const started = deps.now();
      let result: NarratorResult<DescribedComponent[]>;
      try {
        result = await client.describeComponents(briefs, { signal: controller.signal });
      } catch (error) {
        if (gen !== generation || disposed) recordAborted("describeComponents", batch.length, started, null);
        else onFailure("describeComponents", batch.length, started, failureReason(error), null);
        return;
      }
      if (gen !== generation || disposed) {
        recordAborted("describeComponents", batch.length, started, result);
        return;
      }
      if (!result.schemaValid) {
        onFailure("describeComponents", batch.length, started, "schema", result);
        return;
      }
      const guarded = guardComponents(result.value, buildCitationUniverse(snapshot), batch.map((component) => component.id));
      const byId = new Map(guarded.accepted.map((entry) => [entry.id, entry] as const));
      record(
        "describeComponents",
        batch.length,
        started,
        { accepted: byId.size, dropped: batch.length - byId.size, discarded: guarded.discarded, reasons: guarded.reasons, error: null },
        result,
      );
      onSuccess();
      const model = result.model;
      const texts = batch.map((component) => {
        const accepted = byId.get(component.id);
        const text: CachedText =
          accepted === undefined
            ? { purpose: null, role: component.roleGuess, model }
            : { purpose: accepted.purpose, role: accepted.role, model };
        return [component, text] as const;
      });
      // Memo first: a failed DB write must never send the same batch to the model again.
      for (const [component, text] of texts) textMemo.set(keyOf(component), text);
      writeTexts(texts);
      if (byId.size > 0) refreshStage();
    } catch (error) {
      // Only a defect reaches here (sources, guards and sinks are all contained); never retry this batch.
      for (const component of batch) abandoned.add(keyOf(component));
      logError("rebuild", `describe batch failed: ${messageOf(error)}`);
    } finally {
      controllers.delete(controller);
      if (gen === generation) {
        describeCalls -= 1;
        for (const component of batch) inFlight.delete(keyOf(component));
      }
      pump();
    }
  }

  async function narrate(raw: OverviewSnapshot): Promise<void> {
    const client = narrator;
    if (client === null || narrativeInFlight || raw.components.length === 0) return;
    const snapshot = withCachedText(raw);
    const hash = narrativeStructureHash(snapshot);
    if (hash === abandonedNarrative) return;
    const universe = buildCitationUniverse(snapshot);
    const contentHashes = new Map(snapshot.components.map((component) => [component.id, component.contentHash] as const));
    const state = storedNarrative();
    const servedBefore = state === null ? null : servableNarrative(state.narrative, universe);
    // A stored narrative that no longer passes the guard (a cited file is gone) is a miss.
    const stale = state !== null && state.narrative !== null && servedBefore === null;
    if (state !== null && state.hash === hash && !stale) {
      if (baseline === null) baseline = contentHashes;
      if (changedFraction(baseline, contentHashes) <= NARRATIVE_CHANGE_FRACTION) return;
    }
    const gen = generation;
    const controller = new AbortController();
    controllers.add(controller);
    narrativeInFlight = true;
    try {
      const input: OverviewNarrativeInput = {
        components: snapshot.components.map((component) => ({
          id: component.id,
          name: component.name,
          role: component.role,
          purpose: component.purpose,
        })),
        edges: topEdges(snapshot),
      };
      const started = deps.now();
      let result: NarratorResult<NarrativeSentence[]>;
      try {
        result = await client.overviewNarrative(input, { signal: controller.signal });
      } catch (error) {
        if (gen !== generation || disposed) recordAborted("overviewNarrative", 1, started, null);
        else onFailure("overviewNarrative", 1, started, failureReason(error), null);
        return;
      }
      if (gen !== generation || disposed) {
        recordAborted("overviewNarrative", 1, started, result);
        return;
      }
      if (!result.schemaValid) {
        onFailure("overviewNarrative", 1, started, "schema", result);
        return;
      }
      const guarded = guardSentences(result.value, universe, { max: NARRATIVE_MAX_SENTENCES });
      const next: OverviewSnapshot["narrative"] =
        guarded.discarded || guarded.accepted.length === 0 ? null : { sentences: guarded.accepted, provenance: "model" };
      record(
        "overviewNarrative",
        guarded.total,
        started,
        { accepted: guarded.accepted.length, dropped: guarded.dropped, discarded: guarded.discarded, reasons: guarded.reasons, error: null },
        result,
      );
      onSuccess();
      // Memo first: a failed DB write must never send the same structure to the model again.
      baseline = contentHashes;
      stored = { hash, narrative: next };
      writeNarrative(snapshot, hash, next);
      if (JSON.stringify(next) !== JSON.stringify(servedBefore)) refreshStage();
    } catch (error) {
      // Only a defect reaches here; never retry this structure.
      abandonedNarrative = hash;
      logError("rebuild", `overview narrative failed: ${messageOf(error)}`);
    } finally {
      controllers.delete(controller);
      if (gen === generation) narrativeInFlight = false;
      pump();
    }
  }

  /** describe and narrate contain their own failures; this keeps any defect out of unhandled rejections. */
  function spawn(task: Promise<void>): void {
    task.catch((error: unknown) => logError("rebuild", `narration task failed: ${messageOf(error)}`));
  }

  function pump(): void {
    if (disposed) {
      settleIdle();
      return;
    }
    if (narrator !== null && latest !== null) {
      if (deps.now() < backoffUntil) {
        armRetry();
      } else {
        const snapshot = latest;
        const todo = pendingComponents(snapshot).filter((component) => !inFlight.has(keyOf(component)));
        while (describeCalls < DESCRIBE_MAX_IN_FLIGHT && todo.length > 0) {
          spawn(describe(snapshot, todo.splice(0, DESCRIBE_BATCH_SIZE)));
        }
        if (describeCalls === 0) spawn(narrate(snapshot));
      }
    }
    emitStatus();
    settleIdle();
  }

  function stopCalls(): void {
    generation += 1;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    describeCalls = 0;
    narrativeInFlight = false;
    inFlight.clear();
    if (retryTimer !== null) {
      deps.schedule.clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  return {
    textFor,
    narrative,
    applyCached,
    onSnapshot(snapshot, sources) {
      if (disposed) return;
      latest = snapshot;
      latestSources = sources ?? deps.sources;
      pump();
    },
    setNarrator(next) {
      if (disposed) return;
      if (next === narrator) {
        // The reason behind a null narrator can still change (setting off → no key): report it.
        emitStatus();
        return;
      }
      narrator = next;
      stopCalls();
      backoffLevel = 0;
      backoffUntil = 0;
      pump();
    },
    narratorStatus,
    status,
    idle() {
      return busy() ? new Promise<void>((resolve) => idleWaiters.push(resolve)) : Promise.resolve();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopCalls();
      if (refreshTimer !== null) {
        deps.schedule.clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      settleIdle();
    },
  };
}
