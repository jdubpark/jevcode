import { createHash } from "node:crypto";

import type { Component, ComponentEdge, NarratorState, OverviewSnapshot, Role } from "@jevcode/contracts";
import {
  NARRATOR_MODEL,
  NarratorUnavailableError,
  citationResolves,
  guardComponents,
  guardSentences,
  narratorCostUsd,
} from "@jevcode/jev-router";
import type {
  CitationUniverse,
  ComponentBrief,
  NarratorClient,
  NarratorResult,
  OverviewNarrativeInput,
} from "@jevcode/jev-router";
import type { JevcodeDb } from "@jevcode/storage";

import type { NarratorAvailability, NarratorCallRecord } from "../../shared/narrator-log.js";

export const DESCRIBE_BATCH_SIZE = 20;
export const DESCRIBE_MAX_IN_FLIGHT = 2;
export const NARRATOR_BACKOFF_MS = [30_000, 120_000, 600_000] as const;
export const NARRATIVE_CHANGE_FRACTION = 0.1;
export const NARRATIVE_TOP_EDGES = 40;
export const NARRATIVE_MAX_SENTENCES = 8;
export const BRIEF_EDGE_LIMIT = 10;

export interface BriefSources {
  /** Redacted, at most 600 characters (spec §6.2). */
  blurb(component: Component): Promise<string | null>;
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

/** Anything with an id and a content hash: lane 04's ComponentDraft, or a snapshot Component. */
export interface ComponentRef {
  id: string;
  contentHash: string;
}

/** Structurally the "narrator" member of interfaces §5 ExplainerLogEvent. */
export interface NarrationLogEvent {
  kind: "narrator";
  question: "describeComponents" | "overviewNarrative" | "sessionStory" | "decisionWhy";
  ms: number;
  accepted: number;
  dropped: number;
  discarded: boolean;
  error?: string;
}

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
   * narrative and writes a row only if the content (or the narrator status) changed.
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
  /** Synchronous, 0 calls: the stored narrative while it still applies, else null (NarrationSeam.narrative). */
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

const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");

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
    componentNames: new Set(snapshot.components.map((component) => component.name)),
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

function failureReason(error: unknown): string {
  return error instanceof NarratorUnavailableError ? error.reason : "unavailable";
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
  let callSeq = 0;
  let lastStatusKey = "";
  const inFlight = new Set<string>();
  const controllers = new Set<AbortController>();
  const textMemo = new Map<string, CachedText>();
  const idleWaiters: (() => void)[] = [];

  const keyOf = (component: ComponentRef): string => `${component.id}@${component.contentHash}`;

  function cached(component: ComponentRef): CachedText | undefined {
    const key = keyOf(component);
    const memo = textMemo.get(key);
    if (memo !== undefined) return memo;
    const found = deps.db.getComponentText(deps.repoRoot, component.id, component.contentHash);
    if (found !== undefined) textMemo.set(key, found);
    return found;
  }

  function storeText(component: ComponentRef, text: CachedText): void {
    deps.db.putComponentText(deps.repoRoot, component.id, component.contentHash, text);
    textMemo.set(keyOf(component), text);
  }

  function storedNarrative(): StoredNarrative | null {
    if (stored === undefined) {
      const state = deps.db.getOverviewState(deps.repoRoot);
      stored = state === undefined ? null : { hash: state.narrativeInputsHash, narrative: state.narrative };
    }
    return stored;
  }

  function textFor(components: readonly ComponentRef[]): ReadonlyMap<string, ModelText> {
    const out = new Map<string, ModelText>();
    for (const component of components) {
      const text = cached(component);
      if (text !== undefined && text.purpose !== null) {
        out.set(component.id, { purpose: text.purpose, role: text.role, provenance: "model" });
      }
    }
    return out;
  }

  function narrative(snapshot: OverviewSnapshot): OverviewSnapshot["narrative"] {
    const state = storedNarrative();
    if (state === null) return null;
    if (state.hash !== null && state.hash === narrativeStructureHash(snapshot)) return state.narrative;
    if (state.narrative !== null && narrativeResolves(state.narrative, buildCitationUniverse(snapshot))) {
      return state.narrative;
    }
    return null;
  }

  function applyCached(snapshot: OverviewSnapshot): OverviewSnapshot {
    const withText = applyNarration(snapshot, cached);
    return { ...withText, narrative: narrative(withText) };
  }

  function pendingComponents(snapshot: OverviewSnapshot): Component[] {
    return snapshot.components.filter((component) => cached(component) === undefined);
  }

  function status(): NarrationStatus {
    const total = latest?.components.length ?? 0;
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
      if (!disposed) deps.refresh();
    }, 0);
  }

  function emitStatus(): void {
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
  }

  function busy(): boolean {
    return describeCalls > 0 || narrativeInFlight;
  }

  function settleIdle(): void {
    if (busy()) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  }

  function record(question: Question, batchSize: number, started: number, outcome: Outcome, result: NarratorResult<unknown> | null): void {
    const ms = Math.max(0, Math.round(deps.now() - started));
    deps.log({
      kind: "narrator",
      question,
      ms,
      accepted: outcome.accepted,
      dropped: outcome.dropped,
      discarded: outcome.discarded,
      ...(outcome.error === null ? {} : { error: outcome.error }),
    });
    callSeq += 1;
    const usage = result?.usage ?? null;
    deps.recordCall?.({
      id: `narr_${started.toString(36)}_${callSeq}`,
      ts: new Date(deps.now()).toISOString(),
      repoRoot: deps.repoRoot,
      question,
      model: result?.model ?? NARRATOR_MODEL,
      ms,
      batchSize,
      accepted: outcome.accepted,
      dropped: outcome.dropped,
      discarded: outcome.discarded,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      costUsd: usage === null ? null : narratorCostUsd(usage),
      error: outcome.error,
      reasons: outcome.reasons.slice(0, 40),
    });
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

  function onFailure(question: Question, batchSize: number, started: number, reason: string, result: NarratorResult<unknown> | null): void {
    const now = deps.now();
    if (now >= backoffUntil) backoffLevel = Math.min(backoffLevel + 1, NARRATOR_BACKOFF_MS.length);
    const delay: number = NARRATOR_BACKOFF_MS[backoffLevel - 1] ?? 600_000;
    backoffUntil = now + delay;
    record(question, batchSize, started, { accepted: 0, dropped: batchSize, discarded: true, reasons: [], error: reason }, result);
    armRetry();
  }

  async function briefFor(component: Component, snapshot: OverviewSnapshot, sources: BriefSources): Promise<ComponentBrief> {
    const [blurb, exported] = await Promise.all([
      sources.blurb(component).catch(() => null),
      sources.exports(component).catch(() => [] as string[]),
    ]);
    return buildComponentBrief(component, snapshot, { blurb, exports: exported });
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
    const started = deps.now();
    try {
      const briefs = await Promise.all(batch.map((component) => briefFor(component, snapshot, sources)));
      if (gen !== generation || disposed) return;
      const result = await client.describeComponents(briefs, { signal: controller.signal });
      if (gen !== generation || disposed) return;
      if (!result.schemaValid) {
        onFailure("describeComponents", batch.length, started, "schema", result);
        return;
      }
      const guarded = guardComponents(result.value, buildCitationUniverse(snapshot), batch.map((component) => component.id));
      const byId = new Map(guarded.accepted.map((entry) => [entry.id, entry] as const));
      for (const component of batch) {
        const accepted = byId.get(component.id);
        storeText(
          component,
          accepted === undefined
            ? { purpose: null, role: component.roleGuess, model: result.model }
            : { purpose: accepted.purpose, role: accepted.role, model: result.model },
        );
      }
      onSuccess();
      record(
        "describeComponents",
        batch.length,
        started,
        { accepted: byId.size, dropped: batch.length - byId.size, discarded: guarded.discarded, reasons: guarded.reasons, error: null },
        result,
      );
      if (byId.size > 0) deps.refresh();
    } catch (error) {
      if (gen !== generation || disposed) return;
      onFailure("describeComponents", batch.length, started, failureReason(error), null);
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
    const snapshot = applyNarration(raw, cached);
    const hash = narrativeStructureHash(snapshot);
    const contentHashes = new Map(snapshot.components.map((component) => [component.id, component.contentHash] as const));
    const state = storedNarrative();
    if (state !== null && state.hash === hash) {
      if (baseline === null) baseline = contentHashes;
      if (changedFraction(baseline, contentHashes) <= NARRATIVE_CHANGE_FRACTION) return;
    }
    const gen = generation;
    const controller = new AbortController();
    controllers.add(controller);
    narrativeInFlight = true;
    const started = deps.now();
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
      const result = await client.overviewNarrative(input, { signal: controller.signal });
      if (gen !== generation || disposed) return;
      if (!result.schemaValid) {
        onFailure("overviewNarrative", 1, started, "schema", result);
        return;
      }
      const guarded = guardSentences(result.value, buildCitationUniverse(snapshot), { max: NARRATIVE_MAX_SENTENCES });
      const next: OverviewSnapshot["narrative"] =
        guarded.discarded || guarded.accepted.length === 0 ? null : { sentences: guarded.accepted, provenance: "model" };
      const previous = state?.narrative ?? null;
      baseline = contentHashes;
      stored = { hash, narrative: next };
      deps.db.putOverviewState(deps.repoRoot, { snapshot: { ...snapshot, narrative: next }, narrativeInputsHash: hash, narrative: next });
      onSuccess();
      record(
        "overviewNarrative",
        guarded.total,
        started,
        { accepted: guarded.accepted.length, dropped: guarded.dropped, discarded: guarded.discarded, reasons: guarded.reasons, error: null },
        result,
      );
      if (JSON.stringify(next) !== JSON.stringify(previous)) deps.refresh();
    } catch (error) {
      if (gen !== generation || disposed) return;
      onFailure("overviewNarrative", 1, started, failureReason(error), null);
    } finally {
      controllers.delete(controller);
      if (gen === generation) narrativeInFlight = false;
      pump();
    }
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
          void describe(snapshot, todo.splice(0, DESCRIBE_BATCH_SIZE));
        }
        if (describeCalls === 0) void narrate(snapshot);
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
      if (disposed || next === narrator) return;
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
