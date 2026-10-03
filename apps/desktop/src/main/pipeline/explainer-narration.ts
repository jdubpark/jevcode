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

import type { NarratorAvailability, NarratorCallRecord } from "../../shared/narrator-log.js";
import { blurbFrom, exportIdentifiers } from "./explainer-narration-sources.js";
import { buildNarratorCallRecord } from "./narrator-call-log.js";

export const DESCRIBE_BATCH_SIZE = 20;
export const DESCRIBE_MAX_IN_FLIGHT = 2;
export const NARRATOR_BACKOFF_MS = [30_000, 120_000, 600_000] as const;
/** A changed component is described again only once its new content hash has held this long (spec §6.1). */
export const DESCRIBE_STABLE_MS = 60_000;
/** From a key's second schema-invalid answer on, its batch is halved; a lone component is negative-cached (spec §6.3). */
export const SCHEMA_FAILURES_TO_SPLIT = 2;
/**
 * Until the first schema-valid answer of this instance, this many schema-invalid answers in a row
 * read as a provider fault, not a content refusal: they start the backoff (spec §6.6).
 */
export const SCHEMA_BRAKE_STREAK = 3;
/** The narrative is asked again when at least max(NARRATIVE_MIN_CHANGED, 10%) of components changed (spec §6.1). */
export const NARRATIVE_CHANGE_FRACTION = 0.1;
export const NARRATIVE_MIN_CHANGED = 3;
/** At most one overview narrative call per this interval (spec §6.1). */
export const NARRATIVE_MIN_INTERVAL_MS = 120_000;
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
  /**
   * Synchronous, 0 calls: model purposes and confirmed roles from component_text_cache
   * (NarrationSeam.textFor). While a component's new hash is pending, the text of its last settled
   * hash is shown, so an edit never flickers the caption or the role band (spec §6.4).
   */
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

/** Components whose content hash differs from the base, plus components that are gone. */
export function changedCount(base: ReadonlyMap<string, string>, current: ReadonlyMap<string, string>): number {
  let changed = 0;
  for (const [id, hash] of current) if (base.get(id) !== hash) changed += 1;
  for (const id of base.keys()) if (!current.has(id)) changed += 1;
  return changed;
}

export function changedFraction(base: ReadonlyMap<string, string>, current: ReadonlyMap<string, string>): number {
  return changedCount(base, current) / Math.max(1, current.size);
}

/** Spec §6.1: at least max(3, 10%) of components changed since the last narrative. */
export function contentChangedEnough(base: ReadonlyMap<string, string>, current: ReadonlyMap<string, string>): boolean {
  return changedCount(base, current) >= Math.max(NARRATIVE_MIN_CHANGED, NARRATIVE_CHANGE_FRACTION * current.size);
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

const schemaOutcome = (batchSize: number): Outcome => ({
  accepted: 0,
  dropped: batchSize,
  discarded: true,
  reasons: [],
  error: "schema",
});

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
  let wakeTimer: unknown = null;
  let wakeDue = Number.POSITIVE_INFINITY;
  let baseline: ReadonlyMap<string, string> | null = null;
  let stored: StoredNarrative | null | undefined;
  let abandonedNarrative: string | null = null;
  let lastNarrativeAt: number | null = null;
  let lastStatusKey = "";
  const inFlight = new Set<string>();
  /** Components whose batch failed outside the provider call (a bug, not the network); never retried. */
  const abandoned = new Set<string>();
  const controllers = new Set<AbortController>();
  /** Every row read or answered in this instance; it holds an answer even when its DB write failed. */
  const textMemo = new Map<string, CachedText>();
  /** Per component id: the text of its newest settled hash, shown while a newer hash is pending. */
  const lastSettled = new Map<string, CachedText>();
  /** Per component id: the content hash that text belongs to; any other current hash is a change. */
  const settledHash = new Map<string, string>();
  /** Per component id: its current content hash and when it was first seen (the stability clock). */
  const hashSince = new Map<string, { hash: string; at: number }>();
  /** Per id@hash: schema-invalid answers so far, and the batch size cap after a split. */
  const schemaFails = new Map<string, number>();
  const batchCap = new Map<string, number>();
  /** Per narrative structure hash: schema-invalid answers so far. */
  const narrativeSchemaFails = new Map<string, number>();
  /** Whether any schema-valid answer arrived in this instance, and schema-invalid answers since the last one. */
  let validSeen = false;
  let invalidStreak = 0;
  /** Keys negative-cached in memory only, before any valid answer; asked again once one arrives. */
  const provisional = new Set<string>();
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

  function settle(component: ComponentRef, text: CachedText): void {
    lastSettled.set(component.id, text);
    settledHash.set(component.id, component.contentHash);
  }

  /** The row for exactly this id@hash; one that fails the read-side guard is a miss (asked again). */
  function lookup(component: ComponentRef, names: ReadonlySet<string>): CachedText | undefined {
    const row = cachedRow(component);
    if (row === undefined || !cachedTextUsable(row, component.name, names)) return undefined;
    settle(component, row);
    return row;
  }

  /** What is shown: the exact row, else the settled text of the same id while its new hash is pending. */
  function shownText(component: ComponentRef, names: ReadonlySet<string>): CachedText | undefined {
    const exact = lookup(component, names);
    if (exact !== undefined) return exact;
    const previous = lastSettled.get(component.id);
    if (previous === undefined || previous.purpose === null) return undefined;
    return cachedTextUsable(previous, component.name, names) ? previous : undefined;
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

  /** The stored overview's model text is each id's settled text, so a reopen does not flicker either. */
  function seedFrom(snapshot: OverviewSnapshot): void {
    for (const component of snapshot.components) {
      if (component.provenance !== "model" || component.purpose === null || lastSettled.has(component.id)) continue;
      lastSettled.set(component.id, { purpose: component.purpose, role: component.role, model: NARRATOR_MODEL });
      settledHash.set(component.id, component.contentHash);
    }
  }

  function storedNarrative(): StoredNarrative | null {
    if (stored !== undefined) return stored;
    try {
      const state = deps.db.getOverviewState(deps.repoRoot);
      failingReads.delete("overview_state");
      if (state === undefined) {
        stored = null;
      } else {
        stored = { hash: state.narrativeInputsHash, narrative: state.narrative };
        seedFrom(state.snapshot);
      }
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
    storedNarrative();
    const names = namesOf(components);
    const out = new Map<string, ModelText>();
    for (const component of components) {
      const text = shownText(component, names);
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
    storedNarrative();
    const names = namesOf(snapshot.components);
    return applyNarration(snapshot, (component) => shownText(component, names));
  }

  function applyCached(snapshot: OverviewSnapshot): OverviewSnapshot {
    const withText = withCachedText(snapshot);
    return { ...withText, narrative: narrative(withText) };
  }

  function narratable(snapshot: OverviewSnapshot): Component[] {
    return snapshot.components.filter((component) => !isOtherGroup(component));
  }

  /** Components with no settled row for their current hash. */
  function pendingComponents(snapshot: OverviewSnapshot): Component[] {
    const names = namesOf(snapshot.components);
    return narratable(snapshot).filter(
      (component) => !abandoned.has(keyOf(component)) && lookup(component, names) === undefined,
    );
  }

  function trackHashes(snapshot: OverviewSnapshot): void {
    const now = deps.now();
    for (const component of snapshot.components) {
      const since = hashSince.get(component.id);
      if (since === undefined || since.hash !== component.contentHash) {
        hashSince.set(component.id, { hash: component.contentHash, at: now });
      }
    }
  }

  /**
   * When a pending component may be described: at once if it has no settled text in this session
   * (new, or first seen), else once its new hash has held DESCRIBE_STABLE_MS (an agent saving the
   * same file ten times costs one call, not ten).
   */
  function dueAt(component: Component): number {
    const previous = settledHash.get(component.id);
    if (previous === undefined || previous === component.contentHash) return Number.NEGATIVE_INFINITY;
    let since = hashSince.get(component.id);
    if (since === undefined || since.hash !== component.contentHash) {
      since = { hash: component.contentHash, at: deps.now() };
      hashSince.set(component.id, since);
    }
    return since.at + DESCRIBE_STABLE_MS;
  }

  function status(): NarrationStatus {
    storedNarrative();
    const components = latest === null ? [] : narratable(latest);
    const names = latest === null ? new Set<string>() : namesOf(latest.components);
    const total = components.length;
    const described = components.filter(
      (component) => abandoned.has(keyOf(component)) || shownText(component, names) !== undefined,
    ).length;
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

  /** One timer for deferred work (a hash becoming stable, the narrative interval); the earliest wins. */
  function wakeAt(at: number): void {
    if (disposed || at >= wakeDue) return;
    if (wakeTimer !== null) deps.schedule.clearTimeout(wakeTimer);
    wakeDue = at;
    wakeTimer = deps.schedule.setTimeout(() => {
      wakeTimer = null;
      wakeDue = Number.POSITIVE_INFINITY;
      pump();
    }, Math.max(0, at - deps.now()));
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
    const entry = buildNarratorCallRecord({
      id: `narr_${started.toString(36)}_${recordSeq.toString(36)}`,
      at: deps.now(),
      repoRoot: deps.repoRoot,
      question,
      model: result?.model ?? NARRATOR_MODEL,
      ms,
      batchSize,
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

  /** Provider failures only: a rejected call (offline, timeout, rate limit, auth). */
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

  function halve(batch: readonly Component[]): void {
    const cap = Math.max(1, Math.ceil(batch.length / 2));
    for (const component of batch) batchCap.set(keyOf(component), cap);
  }

  /** Memo first (a failed DB write never re-asks the model), then the DB, then one refresh if what is shown changed. */
  function storeAnswers(entries: readonly (readonly [Component, CachedText])[], persist = true): void {
    let shownChanged = false;
    for (const [component, text] of entries) {
      const key = keyOf(component);
      if (text.purpose !== null || (lastSettled.get(component.id)?.purpose ?? null) !== null) shownChanged = true;
      textMemo.set(key, text);
      settle(component, text);
      schemaFails.delete(key);
      batchCap.delete(key);
      provisional.delete(key);
    }
    if (persist) writeTexts(entries);
    if (shownChanged) refreshStage();
  }

  /**
   * A schema-valid answer shows the provider works. The first one undoes the no-purpose rows kept
   * in memory before it, since those refusals may have been the provider's, not the content's.
   */
  function onValidAnswer(): void {
    invalidStreak = 0;
    if (validSeen) return;
    validSeen = true;
    for (const key of provisional) {
      textMemo.delete(key);
      schemaFails.delete(key);
      batchCap.delete(key);
    }
    provisional.clear();
  }

  /**
   * Counts a schema-invalid answer. True means "brake": no valid answer has arrived yet and this is
   * the third invalid one in a row, so it is handled as a provider fault (backoff) instead.
   */
  function schemaBrake(batch: readonly Component[]): boolean {
    invalidStreak += 1;
    if (validSeen || invalidStreak < SCHEMA_BRAKE_STREAK) return false;
    // Still counted, so the next probe tries the components that failed least (no split, no settle).
    for (const component of batch) {
      const key = keyOf(component);
      schemaFails.set(key, (schemaFails.get(key) ?? 0) + 1);
    }
    return true;
  }

  /**
   * Spec §6.3: a schema-invalid answer (a refusal, a cut-off answer) keeps the rule-based value. On a
   * provider that has answered validly it says nothing about the provider being down, so it does not
   * raise the backoff (before that, schemaBrake decides). Each key counts its failures instead: from
   * the second one on, its batch is halved, and a component that fails on its own is negative-cached.
   * Every key is sent at most twice per batch size.
   */
  function onSchemaFailure(batch: readonly Component[], model: string): void {
    let split = false;
    for (const component of batch) {
      const key = keyOf(component);
      const failures = (schemaFails.get(key) ?? 0) + 1;
      schemaFails.set(key, failures);
      if (failures >= SCHEMA_FAILURES_TO_SPLIT) split = true;
    }
    if (!split) return;
    const [only] = batch;
    if (batch.length === 1 && only !== undefined) {
      // Stored only once the provider is known to work; until then it stays in memory (spec §6.6).
      storeAnswers([[only, { purpose: null, role: only.roleGuess, model }]], validSeen);
      if (!validSeen) provisional.add(keyOf(only));
      return;
    }
    halve(batch);
  }

  /**
   * Keys are batched only with keys that failed schema as often, fewest failures first: fresh keys
   * never share a batch with failed ones, and one refusing component cannot hold up the rest.
   */
  function planBatches(due: readonly Component[]): Component[][] {
    const groups = new Map<string, { cap: number; failures: number; members: Component[] }>();
    for (const component of due) {
      const key = keyOf(component);
      const cap = batchCap.get(key) ?? DESCRIBE_BATCH_SIZE;
      const failures = schemaFails.get(key) ?? 0;
      const groupKey = `${failures}:${cap}`;
      let group = groups.get(groupKey);
      if (group === undefined) {
        group = { cap, failures, members: [] };
        groups.set(groupKey, group);
      }
      group.members.push(component);
    }
    const ordered = [...groups.values()].sort((a, b) => a.failures - b.failures || b.cap - a.cap);
    const batches: Component[][] = [];
    for (const group of ordered) {
      for (let start = 0; start < group.members.length; start += group.cap) {
        batches.push(group.members.slice(start, start + group.cap));
      }
    }
    return batches;
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
        if (gen !== generation || disposed) {
          recordAborted("describeComponents", batch.length, started, null);
        } else {
          const reason = failureReason(error);
          // A slow batch may just be too big: halve it before backing off (spec §6.6).
          if (reason === "timeout") halve(batch);
          onFailure("describeComponents", batch.length, started, reason, null);
        }
        return;
      }
      if (gen !== generation || disposed) {
        recordAborted("describeComponents", batch.length, started, result);
        return;
      }
      if (!result.schemaValid) {
        if (schemaBrake(batch)) {
          onFailure("describeComponents", batch.length, started, "schema", result);
          return;
        }
        record("describeComponents", batch.length, started, schemaOutcome(batch.length), result);
        onSchemaFailure(batch, result.model);
        return;
      }
      onValidAnswer();
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
      storeAnswers(
        batch.map((component) => {
          const accepted = byId.get(component.id);
          const text: CachedText =
            accepted === undefined
              ? { purpose: null, role: component.roleGuess, model }
              : { purpose: accepted.purpose, role: accepted.role, model };
          return [component, text] as const;
        }),
      );
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

  /**
   * Spec §6.1: the first narrative; a stored one that no longer passes the guard (a cited file is
   * gone); a new structure (a component added, removed or re-roled); or at least max(3, 10%) of
   * components with a new content hash since the last narrative.
   */
  function narrativeWanted(
    state: StoredNarrative | null,
    hash: string,
    servedBefore: OverviewSnapshot["narrative"],
    contentHashes: ReadonlyMap<string, string>,
  ): boolean {
    if (state === null || state.hash === null) return true;
    if (state.narrative !== null && servedBefore === null) return true;
    if (state.hash !== hash) return true;
    if (baseline === null) baseline = contentHashes;
    return contentChangedEnough(baseline, contentHashes);
  }

  function settleNarrative(
    snapshot: OverviewSnapshot,
    hash: string,
    contentHashes: ReadonlyMap<string, string>,
    next: OverviewSnapshot["narrative"],
    servedBefore: OverviewSnapshot["narrative"],
    persist = true,
  ): void {
    // Memo first: a failed DB write must never send the same structure to the model again.
    baseline = contentHashes;
    stored = { hash, narrative: next };
    narrativeSchemaFails.delete(hash);
    if (persist) writeNarrative(snapshot, hash, next);
    if (JSON.stringify(next) !== JSON.stringify(servedBefore)) refreshStage();
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
    if (!narrativeWanted(state, hash, servedBefore, contentHashes)) return;
    if (lastNarrativeAt !== null && deps.now() < lastNarrativeAt + NARRATIVE_MIN_INTERVAL_MS) {
      wakeAt(lastNarrativeAt + NARRATIVE_MIN_INTERVAL_MS);
      return;
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
      lastNarrativeAt = started;
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
        if (schemaBrake([])) {
          onFailure("overviewNarrative", 1, started, "schema", result);
          return;
        }
        record("overviewNarrative", 1, started, schemaOutcome(1), result);
        const failures = (narrativeSchemaFails.get(hash) ?? 0) + 1;
        narrativeSchemaFails.set(hash, failures);
        // A second schema-invalid answer for the same structure settles it; the narrative shown so far
        // stays. It is stored only once the provider is known to work (spec §6.6).
        if (failures >= SCHEMA_FAILURES_TO_SPLIT) {
          settleNarrative(snapshot, hash, contentHashes, servedBefore, servedBefore, validSeen);
        }
        return;
      }
      onValidAnswer();
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
      settleNarrative(snapshot, hash, contentHashes, next, servedBefore);
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

  function startCalls(snapshot: OverviewSnapshot): void {
    storedNarrative();
    const pending = pendingComponents(snapshot);
    // While a cache read fails, a call could re-ask what is already cached: start nothing (spec §6.4).
    if (failingReads.size > 0) return;
    const now = deps.now();
    const due: Component[] = [];
    let wake = Number.POSITIVE_INFINITY;
    for (const component of pending) {
      if (inFlight.has(keyOf(component))) continue;
      const at = dueAt(component);
      if (at <= now) due.push(component);
      else wake = Math.min(wake, at);
    }
    // Before any valid answer, after an invalid one, it is unclear whether the provider works: probe with
    // one call at a time, so a provider-wide fault costs at most SCHEMA_BRAKE_STREAK calls (spec §6.6).
    const probing = !validSeen && invalidStreak > 0;
    const callsInFlight = (): number => describeCalls + (narrativeInFlight ? 1 : 0);
    for (const batch of planBatches(due)) {
      if (describeCalls >= DESCRIBE_MAX_IN_FLIGHT || (probing && callsInFlight() > 0)) break;
      spawn(describe(snapshot, batch));
    }
    if (wake !== Number.POSITIVE_INFINITY) wakeAt(wake);
    // The narrative waits for every pending component, except those that already failed schema.
    const narrativeAllowed = !probing || callsInFlight() === 0;
    if (narrativeAllowed && pending.every((component) => schemaFails.has(keyOf(component)))) spawn(narrate(snapshot));
  }

  function pump(): void {
    if (disposed) {
      settleIdle();
      return;
    }
    if (narrator !== null && latest !== null) {
      if (deps.now() < backoffUntil) armRetry();
      else startCalls(latest);
    }
    emitStatus();
    settleIdle();
  }

  function clearTimer(handle: unknown): null {
    if (handle !== null) deps.schedule.clearTimeout(handle);
    return null;
  }

  function stopCalls(): void {
    generation += 1;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    describeCalls = 0;
    narrativeInFlight = false;
    inFlight.clear();
    retryTimer = clearTimer(retryTimer);
    wakeTimer = clearTimer(wakeTimer);
    wakeDue = Number.POSITIVE_INFINITY;
  }

  return {
    textFor,
    narrative,
    applyCached,
    onSnapshot(snapshot, sources) {
      if (disposed) return;
      latest = snapshot;
      latestSources = sources ?? deps.sources;
      trackHashes(snapshot);
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
      refreshTimer = clearTimer(refreshTimer);
      settleIdle();
    },
  };
}
