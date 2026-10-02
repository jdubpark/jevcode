import { createHash } from "node:crypto";

import { canonicalJson } from "@jevcode/contracts";
import type {
  ChangeUnit,
  ComponentEdge,
  Decision,
  ExternalDep,
  NarratorState,
  OverviewSnapshot,
  OverviewStatus,
  Role,
} from "@jevcode/contracts";
import {
  assembleSnapshot,
  clipText,
  type AssembleSnapshotInput,
  type ComponentDraft,
  type ComponentText,
  type WorkspaceManifest,
} from "@jevcode/codebase-map";
import type { scanPaths, scanRepo } from "@jevcode/codebase-map/node";
import type { extractImports } from "@jevcode/evidence-engine";
import type { JevcodeDb } from "@jevcode/storage";

import {
  OverviewIndex,
  applyFileChanges,
  hasFileChanges,
  nextTurn,
  runSliced,
  scanRepoModel,
  type BuiltOverview,
  type FileChanges,
  type RepoModel,
} from "./explainer-overview.js";

/** Spec §5.5: at most one snapshot row per session every 2 s. */
export const SNAPSHOT_WRITE_INTERVAL_MS = 2_000;
/** Spec §6.1: a rebuild waits until watcher changes have settled for 500 ms. */
export const FILES_SETTLE_MS = 500;
/** Ruling R3: a scan that runs longer than this writes progress snapshots (through the 2 s writer). */
export const SCAN_PROGRESS_AFTER_MS = 2_000;
/** Ruling R3: `status.scan.error` is at most this long. */
export const SCAN_ERROR_MAX = 200;
/**
 * Most import parses the stage keeps in flight. The desktop import pool runs at most 6 workers
 * with a 256-task queue, so 6 × 4 keeps the queue far from full across overlapping scans.
 */
export const EXTRACT_CONCURRENCY = 24;
/**
 * Spec §6.1 (the stage never blocks ingestion): a full rebuild runs in slices of about this many
 * milliseconds and yields to the event loop between them.
 */
export const REBUILD_SLICE_MS = 12;
/** Edits that can move component boundaries or import resolution rerun the full scan. */
const MANIFEST_CHANGE = /(^|\/)(package\.json|pnpm-workspace\.yaml|tsconfig[^/]*\.json|\.gitignore)$/;

export type ExplainerLogEvent =
  | { kind: "scan"; files: number; partial: boolean; ms: number }
  | {
      kind: "narrator";
      question: "describeComponents" | "overviewNarrative" | "sessionStory" | "decisionWhy";
      ms: number;
      accepted: number;
      dropped: number;
      discarded: boolean;
      error?: string;
    }
  | { kind: "snapshot"; components: number; edges: number; bytes: number }
  | { kind: "error"; where: "scan" | "rebuild" | "write" | "state" | "dispose"; message: string };

/** Scan progress and failure for the Brief (spec §6.1, §6.6); see the lane's spec gap 1. */
export interface ExplainerStatus {
  phase: "idle" | "scanning" | "ready" | "failed";
  done: number;
  total: number;
  error: string | null;
}

/** What lane 05's narration reads: the rule-based overview of the current snapshot. */
export interface OverviewView {
  repoRoot: string;
  drafts: readonly ComponentDraft[];
  roleGuess: ReadonlyMap<string, Role>;
  edges: readonly ComponentEdge[];
  externals: readonly ExternalDep[];
  manifest: WorkspaceManifest;
  exportsOf(componentId: string): readonly string[];
}

export interface NarrationContext {
  repoRoot: string;
  db: JevcodeDb;
  now(): number;
  schedule: ExplainerStageDeps["schedule"];
  log(event: ExplainerLogEvent): void;
  /** Re-assembles the snapshot from the current overview (no rescan); call it when new text lands. */
  refresh(): void;
}

/**
 * The seam lane 05 (N-5) fills (interfaces §5, ruling R4). Lane 04 ships NO_NARRATION: every
 * purpose is null, every role is the rule-based guess, the narrative is null and the narrator
 * status is "unavailable" ("off" when the explainWithModel preference is off).
 */
export interface NarrationSeam {
  /** Purposes and confirmed roles by component id (lane 05 reads component_text_cache). */
  textFor(view: OverviewView): ReadonlyMap<string, ComponentText>;
  /** The overview narrative to embed, or null. */
  narrative(snapshot: OverviewSnapshot, view: OverviewView): OverviewSnapshot["narrative"];
  /** Called after every rebuild; lane 05 schedules describeComponents and overviewNarrative here. */
  onSnapshot(snapshot: OverviewSnapshot, view: OverviewView): void;
  /** Ruling R4: lane 05's `ExplainerStage.setNarrator` forwards a `NarratorClient | null` here. */
  setNarrator?(narrator: unknown): void;
  /** Ruling R4: the narrator state written to `status.narrator`; absent means "unavailable". */
  narratorStatus?(): NarratorState;
  dispose(): void;
}

export const NO_NARRATION: NarrationSeam = {
  textFor: () => new Map(),
  narrative: () => null,
  onSnapshot: () => {},
  dispose: () => {},
};

export interface ExplainerStageDeps {
  db: JevcodeDb;
  repoRoot: string;
  /** The session whose viewer shows this repo, or null; snapshot rows go there. */
  sessionId: () => string | null;
  scan: typeof scanRepo;
  scanPaths: typeof scanPaths;
  extract: typeof extractImports;
  /** Lane 03 D-1's push hint (trace:rowsAvailable). */
  emitRowsAvailable(sessionId: string, lastSeq: number): void;
  now(): number;
  schedule: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
  log(event: ExplainerLogEvent): void;
  narration?: (ctx: NarrationContext) => NarrationSeam;
  /** The explainWithModel preference (spec E15); false writes narrator "off". Absent reads as on. */
  explainWithModel?(): boolean;
  onStatus?(status: ExplainerStatus): void;
}

export interface ExplainerStage {
  /** Shows the stored map at once, then starts (or keeps) a background scan. */
  onRepoOpened(): void;
  /** Writes the current snapshot row for the session; scans when no scan has run. */
  onSessionStarted(sessionId: string): void;
  /** Queues changed repo-relative paths; the rebuild runs 500 ms after the last change. */
  onFilesChanged(paths: readonly string[]): void;
  /** Lane 07 (S-2) owns this body: story and highlight triggers. */
  onPipelineSync(sync: { sessionId: string; lastSeq: number; changeUnits: ChangeUnit[]; decisions: Decision[] }): void;
  /** overview:rescan (spec §6.6 Retry): aborts a running scan and starts a new one. */
  rescan(): void;
  status(): ExplainerStatus;
  /** Resolves when no scan, rebuild or queued row write is in flight. Timers are not awaited. */
  whenIdle(): Promise<void>;
  dispose(): void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs at most `max` calls of `fn` at once; the rest wait in call order. */
function limitConcurrency<A extends unknown[], R>(fn: (...args: A) => Promise<R>, max: number): (...args: A) => Promise<R> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (...args) => {
    if (active < max) active += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await fn(...args);
    } finally {
      // Hand the slot straight to the next caller, or free it.
      const next = waiting.shift();
      if (next === undefined) active -= 1;
      else next();
    }
  };
}

/** Identity of a snapshot's content: everything except the session, the scan id and the time. */
export function snapshotKey(snapshot: OverviewSnapshot): string {
  return createHash("sha1")
    .update(canonicalJson({ ...snapshot, sessionId: "", scanId: "", generatedAt: "" }))
    .digest("hex");
}

export function createExplainerStage(deps: ExplainerStageDeps): ExplainerStage {
  let disposed = false;
  let model: RepoModel | null = null;
  /** The incremental overview of `model`; null until its full build finishes. */
  let index: OverviewIndex | null = null;
  /** The last published overview and the model it was built from, for refresh(). */
  let built: { overview: BuiltOverview; repo: RepoModel } | null = null;
  /** The last full snapshot (sessionId ""): the base of progress and failure rows. */
  let content: { snapshot: OverviewSnapshot; key: string } | null = null;
  /** Key of the snapshot in overview_state; only a full snapshot that was appended as a row gets there. */
  let persistedKey: string | null = null;
  /** What the single row writer writes next: a full snapshot, or a progress or failure snapshot. */
  let latest: { snapshot: OverviewSnapshot; key: string } | null = null;
  /**
   * The scan state rows carry instead of "done": the progress of a scan past 2 s, or the last
   * failure. It stays until a scan succeeds, so a narration refresh or an incremental rebuild
   * cannot hide a failure (and its Retry) behind a "done" row. `tag` identifies it in row keys.
   */
  let scanState: { scan: OverviewStatus["scan"]; tag: string } | null = null;
  let scanning: AbortController | null = null;
  let generation = 0;
  let scanCount = 0;
  let scanPromise: Promise<void> = Promise.resolve();
  let rebuildChain: Promise<void> = Promise.resolve();
  /** Row appends and overview_state saves, each in a turn of its own (spec §6.1). */
  let writing: Promise<void> = Promise.resolve();
  const queuedWrites = new Set<string>();
  let settleTimer: unknown = null;
  let status: ExplainerStatus = { phase: "idle", done: 0, total: 0, error: null };
  const dirty = new Set<string>();
  const written = new Map<string, { key: string; at: number }>();
  const writeTimers = new Map<string, unknown>();
  // Every scan and rebuild of this stage shares one bound, so overlapping scans cannot flood the pool.
  const extract: typeof deps.extract = limitConcurrency(deps.extract, EXTRACT_CONCURRENCY);

  const narration = (deps.narration ?? (() => NO_NARRATION))({
    repoRoot: deps.repoRoot,
    db: deps.db,
    now: () => deps.now(),
    schedule: deps.schedule,
    log: (event) => deps.log(event),
    refresh: () => {
      const last = built;
      if (!disposed && last !== null) publishBuilt(last.repo, last.overview);
    },
  });

  function setStatus(next: ExplainerStatus): void {
    status = next;
    deps.onStatus?.({ ...next });
  }

  /** Ruling R3: "off" when the preference is off, else the seam's state, else "unavailable". */
  function narratorState(): NarratorState {
    try {
      if (deps.explainWithModel?.() === false) return "off";
      return narration.narratorStatus?.() ?? "unavailable";
    } catch (error) {
      deps.log({ kind: "error", where: "state", message: messageOf(error) });
      return "unavailable";
    }
  }

  function nextScanId(): string {
    return `scan_${deps.now().toString(36)}_${(scanCount += 1)}`;
  }

  function viewOf(overview: BuiltOverview, repo: RepoModel): OverviewView {
    return {
      repoRoot: deps.repoRoot,
      drafts: overview.drafts,
      roleGuess: overview.roleGuess,
      edges: overview.edges,
      externals: overview.externals,
      manifest: repo.manifest,
      exportsOf: (componentId) => overview.exportsByComponent.get(componentId) ?? [],
    };
  }

  function loadStored(): void {
    if (content !== null) return;
    try {
      const stored = deps.db.getOverviewState(deps.repoRoot);
      if (stored !== undefined) {
        content = { snapshot: stored.snapshot, key: snapshotKey(stored.snapshot) };
        persistedKey = content.key;
        latest ??= content;
      }
    } catch (error) {
      deps.log({ kind: "error", where: "state", message: messageOf(error) });
    }
  }

  function persist(snapshot: OverviewSnapshot): void {
    try {
      const previous = deps.db.getOverviewState(deps.repoRoot);
      // Lane 05 owns narrativeInputsHash and the stored narrative; a rule-only snapshot
      // (narrator off) must not erase them.
      deps.db.putOverviewState(deps.repoRoot, {
        snapshot,
        narrativeInputsHash: previous?.narrativeInputsHash ?? null,
        narrative: snapshot.narrative ?? previous?.narrative ?? null,
      });
    } catch (error) {
      deps.log({ kind: "error", where: "state", message: messageOf(error) });
    }
  }

  /**
   * The single row writer: every overview_snapshot row of this stage is appended here, stamped
   * with the real session id (snapshots are assembled with ""). A full snapshot reaches
   * overview_state only after its row was appended, so the stored state always fits the row cap.
   */
  function writeNow(sessionId: string): void {
    if (disposed || latest === null) return;
    const pending = latest;
    const last = written.get(sessionId);
    if (last !== undefined && last.key === pending.key) return;
    let seq: number;
    try {
      seq = deps.db.appendEvent(sessionId, "overview_snapshot", { ...pending.snapshot, sessionId }).seq;
    } catch (error) {
      // TypeError from the store: unknown session, invalid payload or over the 512 KB cap.
      deps.log({ kind: "error", where: "write", message: messageOf(error) });
      return;
    }
    written.set(sessionId, { key: pending.key, at: deps.now() });
    if (pending === content && persistedKey !== pending.key) {
      persistedKey = pending.key;
      const snapshot = pending.snapshot;
      writing = writing.then(async () => {
        await nextTurn();
        if (!disposed) persist(snapshot);
      });
    }
    try {
      deps.emitRowsAvailable(sessionId, seq);
    } catch (error) {
      deps.log({ kind: "error", where: "write", message: messageOf(error) });
    }
  }

  /**
   * One row per session at start, then on change, at most every 2 s (spec §5.5). A rebuild
   * passes `nextTurnOnly`, so the row append does not add to the turn that assembled the snapshot.
   */
  function requestWrite(sessionId: string, nextTurnOnly = false): void {
    if (disposed || latest === null) return;
    const last = written.get(sessionId);
    if (last !== undefined && last.key === latest.key) return;
    if (writeTimers.has(sessionId)) return;
    if (queuedWrites.has(sessionId)) return;
    const wait = last === undefined ? 0 : Math.max(0, last.at + SNAPSHOT_WRITE_INTERVAL_MS - deps.now());
    if (wait === 0 && !nextTurnOnly) {
      writeNow(sessionId);
      return;
    }
    if (wait === 0) {
      queuedWrites.add(sessionId);
      writing = writing.then(async () => {
        await nextTurn();
        queuedWrites.delete(sessionId);
        writeNow(sessionId);
      });
      return;
    }
    writeTimers.set(
      sessionId,
      deps.schedule.setTimeout(() => {
        writeTimers.delete(sessionId);
        writeNow(sessionId);
      }, wait),
    );
  }

  function requestWriteForCurrentSession(nextTurnOnly = false): void {
    const sessionId = deps.sessionId();
    if (sessionId !== null) requestWrite(sessionId, nextTurnOnly);
  }

  /** A snapshot with no components: the base of progress and failure rows before any scan finished. */
  function emptySnapshot(): OverviewSnapshot {
    return assembleSnapshot({
      sessionId: "",
      repoRoot: deps.repoRoot,
      scanId: nextScanId(),
      partial: false,
      drafts: [],
      edges: [],
      externals: [],
      text: new Map(),
      narrative: null,
      generatedAt: new Date(deps.now()).toISOString(),
    });
  }

  /**
   * Ruling R3: progress and failure rows carry the last full snapshot's components (or none)
   * with the scan state. The key joins the state's tag and the content key, so the progress path
   * hashes nothing and republishing unchanged content writes no second row.
   */
  function scanStateRow(state: NonNullable<typeof scanState>): { snapshot: OverviewSnapshot; key: string } {
    const base = content?.snapshot ?? emptySnapshot();
    const narrator = narratorState();
    return {
      snapshot: {
        ...base,
        scanId: nextScanId(),
        generatedAt: new Date(deps.now()).toISOString(),
        status: { scan: state.scan, narrator },
      },
      key: `${state.tag}|${narrator}|${content?.key ?? ""}`,
    };
  }

  /** Makes `scan` the sticky scan state and writes it (through the 2 s writer). */
  function publishScanStatus(scan: OverviewStatus["scan"], tag: string): void {
    scanState = { scan, tag };
    try {
      latest = scanStateRow(scanState);
    } catch (error) {
      deps.log({ kind: "error", where: "rebuild", message: messageOf(error) });
      return;
    }
    requestWriteForCurrentSession();
  }

  /** A narration seam error: logged, and the stage goes on with rule-based data (spec E10, §6.6). */
  function seamFailed(error: unknown): void {
    deps.log({ kind: "error", where: "rebuild", message: messageOf(error) });
  }

  /**
   * Spec E10, E15, §6.6: model text never costs the map. The seam's text is dropped when the
   * snapshot that includes it cannot be assembled (a RangeError when it cannot fit), and the
   * narrative when the seam throws or the snapshot with it cannot be assembled. Only a failure
   * of the rule-only snapshot throws.
   */
  function assembleWithFallback(input: AssembleSnapshotInput, view: OverviewView): OverviewSnapshot {
    let used = input;
    let base: OverviewSnapshot;
    try {
      base = assembleSnapshot(used);
    } catch (error) {
      if (used.text.size === 0) throw error;
      seamFailed(error);
      used = { ...used, text: new Map() };
      base = assembleSnapshot(used);
    }
    let narrative: OverviewSnapshot["narrative"] = null;
    try {
      narrative = narration.narrative(base, view) ?? null;
    } catch (error) {
      seamFailed(error);
    }
    if (narrative === null) return base;
    try {
      return assembleSnapshot({ ...used, narrative });
    } catch (error) {
      seamFailed(error);
      return base;
    }
  }

  function publish(overview: BuiltOverview, repo: RepoModel): void {
    const view = viewOf(overview, repo);
    const scanned = repo.files.size;
    const totalFiles = repo.partial ? repo.totalFiles : scanned;
    let text = new Map<string, ComponentText>();
    try {
      // Lane 05 reads component_text_cache here, so a database error can surface.
      text = new Map(narration.textFor(view));
    } catch (error) {
      seamFailed(error);
    }
    const assembled = assembleWithFallback(
      {
        sessionId: "",
        repoRoot: deps.repoRoot,
        scanId: nextScanId(),
        partial: repo.partial,
        drafts: overview.drafts,
        totalFiles,
        edges: overview.edges,
        totalEdges: overview.totalEdges,
        externals: overview.externals,
        text,
        narrative: null,
        generatedAt: new Date(deps.now()).toISOString(),
      },
      view,
    );
    const snapshot: OverviewSnapshot = {
      ...assembled,
      status: {
        scan: { state: "done", scanned, total: totalFiles },
        narrator: narratorState(),
      },
    };
    const key = snapshotKey(snapshot);
    if (content === null || content.key !== key) {
      content = { snapshot, key };
      deps.log({
        kind: "snapshot",
        components: snapshot.components.length,
        edges: snapshot.edges.length,
        bytes: Buffer.byteLength(JSON.stringify(snapshot)),
      });
    }
    // A running or failed scan keeps its state on the row until a scan succeeds.
    latest = scanState === null ? content : scanStateRow(scanState);
    try {
      narration.onSnapshot(content.snapshot, view);
    } catch (error) {
      seamFailed(error);
    }
    requestWriteForCurrentSession(true);
  }

  /**
   * A rule-based failure (building the overview, or a rule-only snapshot that cannot fit) becomes
   * a failed row with the previous components, which stays until a scan succeeds.
   */
  function buildFailed(repo: RepoModel, error: unknown): void {
    // Nothing left for refresh() to republish until the next rebuild of a changed model.
    built = null;
    const message = messageOf(error);
    deps.log({ kind: "error", where: "rebuild", message });
    const total = repo.partial ? repo.totalFiles : repo.files.size;
    const clipped = clipText(message, SCAN_ERROR_MAX);
    setStatus({ phase: "failed", done: repo.files.size, total, error: message });
    // The same failure again (a refresh of the same model) keeps its key and writes no new row.
    publishScanStatus({ state: "failed", scanned: repo.files.size, total, error: clipped }, `rebuild-failed:${generation}:${clipped}`);
  }

  /** Publishes `overview` of `repo`, unless the model moved on. Never throws. */
  function publishBuilt(repo: RepoModel, overview: BuiltOverview): void {
    if (disposed || model !== repo) return;
    built = { overview, repo };
    try {
      publish(overview, repo);
    } catch (error) {
      buildFailed(repo, error);
    }
  }

  /**
   * The overview of `index` in one turn, its snapshot in the next (spec §6.1: no long block).
   * A failure to build the overview drops the index, so the next change rebuilds it.
   */
  async function publishIndex(repo: RepoModel, current: OverviewIndex, stale: () => boolean): Promise<void> {
    let overview: BuiltOverview;
    try {
      overview = current.overview();
    } catch (error) {
      index = null;
      buildFailed(repo, error);
      return;
    }
    await nextTurn();
    if (!stale()) publishBuilt(repo, overview);
  }

  /**
   * Builds a new index of `repo` in slices of REBUILD_SLICE_MS (spec §6.1) and publishes it.
   * Runs on rebuildChain; a newer scan or dispose cancels it between slices.
   */
  async function fullBuild(repo: RepoModel, buildGeneration: number): Promise<void> {
    const stale = (): boolean => disposed || buildGeneration !== generation || model !== repo;
    if (stale()) return;
    index = null;
    let result: { value: OverviewIndex; yielded: boolean } | null;
    try {
      result = await runSliced(OverviewIndex.steps(repo), { sliceMs: REBUILD_SLICE_MS, cancelled: stale });
    } catch (error) {
      if (!stale()) buildFailed(repo, error);
      return;
    }
    if (result === null || stale()) return;
    index = result.value;
    // The build's last slice ran up to here; the overview gets a turn of its own.
    await nextTurn();
    if (!stale()) await publishIndex(repo, result.value, stale);
  }

  /** The index no longer matches `repo` (it changed without a rebuild): the next rebuild starts over. */
  function dropIndexOf(repo: RepoModel): void {
    if (index?.model === repo) index = null;
  }

  /** An incremental rebuild (spec §6.1: only dirty components are recomputed), else a full one. */
  async function rebuildChanged(repo: RepoModel, changes: FileChanges, buildGeneration: number): Promise<void> {
    const current = index;
    if (current !== null && current.model === repo) {
      let updated: boolean;
      try {
        updated = current.update(changes);
      } catch (error) {
        index = null;
        buildFailed(repo, error);
        return;
      }
      if (updated) {
        await publishIndex(repo, current, () => disposed || buildGeneration !== generation || model !== repo);
        return;
      }
    }
    await fullBuild(repo, buildGeneration);
  }

  function startScan(): void {
    if (disposed) return;
    scanning?.abort();
    const controller = new AbortController();
    scanning = controller;
    const scanGeneration = (generation += 1);
    const started = deps.now();
    let progress = { done: 0, total: 0 };
    setStatus({ phase: "scanning", done: 0, total: 0, error: null });
    scanPromise = scanRepoModel(
      deps.repoRoot,
      { scan: deps.scan, extract },
      {
        signal: controller.signal,
        onProgress: (done, total) => {
          if (disposed || scanGeneration !== generation) return;
          progress = { done, total };
          setStatus({ phase: "scanning", done, total, error: null });
          if (deps.now() - started >= SCAN_PROGRESS_AFTER_MS) {
            publishScanStatus({ state: "running", scanned: done, total }, `running:${scanGeneration}:${done}:${total}`);
          }
        },
      },
    ).then(
      (next) => {
        if (disposed || scanGeneration !== generation) return;
        scanning = null;
        model = next;
        deps.log({ kind: "scan", files: next.files.size, partial: next.partial, ms: deps.now() - started });
        index = null;
        // A scan succeeded: rows say "done" again unless the rebuild below fails.
        scanState = null;
        setStatus({ phase: "ready", done: next.files.size, total: next.files.size, error: null });
        rebuildChain = rebuildChain.then(() => fullBuild(next, scanGeneration));
        if (dirty.size > 0) scheduleSettle();
      },
      (error: unknown) => {
        if (disposed || scanGeneration !== generation) return;
        scanning = null;
        const message = messageOf(error);
        deps.log({ kind: "error", where: "scan", message });
        setStatus({ phase: "failed", done: 0, total: 0, error: message });
        publishScanStatus(
          { state: "failed", scanned: progress.done, total: progress.total, error: clipText(message, SCAN_ERROR_MAX) },
          `failed:${scanGeneration}`,
        );
        // The previous model stays. If it has no index (its build was cancelled by this scan, or
        // a change landed in it while this scan ran), rebuild and publish it, so the map is the
        // last successful scan's, with every change applied to it.
        const previous = model;
        if (previous !== null && index === null) rebuildChain = rebuildChain.then(() => fullBuild(previous, scanGeneration));
        // Changes queued during the scan still apply: incrementally to the previous model, or
        // as a new scan when a manifest changed.
        if (dirty.size > 0) scheduleSettle();
      },
    );
  }

  function applyDirty(): void {
    settleTimer = null;
    if (disposed || dirty.size === 0 || model === null || scanning !== null) return;
    const paths = [...dirty];
    dirty.clear();
    if (paths.some((path) => MANIFEST_CHANGE.test(path))) {
      startScan();
      return;
    }
    const target = model;
    const targetGeneration = generation;
    rebuildChain = rebuildChain.then(async () => {
      let changes: FileChanges;
      try {
        changes = await applyFileChanges(deps.repoRoot, target, paths, { scanPaths: deps.scanPaths, extract });
      } catch (error) {
        // The read may have stopped after some files were parsed into the model.
        dropIndexOf(target);
        deps.log({ kind: "error", where: "rebuild", message: messageOf(error) });
        return;
      }
      if (disposed || targetGeneration !== generation || model !== target) {
        // A rescan started while this batch was read, and the batch is now in the model without
        // its rebuild. A running rescan replaces the model or, when it fails, rebuilds this one.
        dropIndexOf(target);
        // A rescan that already failed kept this model: rebuild it now, so the map shows the batch.
        if (!disposed && model === target && scanning === null) await fullBuild(target, generation);
        return;
      }
      if (hasFileChanges(changes)) await rebuildChanged(target, changes, targetGeneration);
    });
  }

  function scheduleSettle(): void {
    if (settleTimer !== null) deps.schedule.clearTimeout(settleTimer);
    settleTimer = deps.schedule.setTimeout(applyDirty, FILES_SETTLE_MS);
  }

  return {
    onRepoOpened() {
      if (disposed) return;
      loadStored();
      requestWriteForCurrentSession();
      if (scanning === null) startScan();
    },
    onSessionStarted(sessionId) {
      if (disposed) return;
      loadStored();
      requestWrite(sessionId);
      if (model === null && scanning === null) startScan();
    },
    onFilesChanged(paths) {
      if (disposed) return;
      for (const path of paths) {
        if (path !== "") dirty.add(path);
      }
      if (model !== null && scanning === null && dirty.size > 0) scheduleSettle();
    },
    onPipelineSync(_sync) {
      // Lane 07 (S-2): story and highlight triggers.
    },
    rescan() {
      startScan();
    },
    status() {
      return { ...status };
    },
    async whenIdle() {
      for (;;) {
        const scan = scanPromise;
        const chain = rebuildChain;
        const writes = writing;
        await Promise.allSettled([scan, chain, writes]);
        if (scan === scanPromise && chain === rebuildChain && writes === writing) return;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      scanning?.abort();
      scanning = null;
      if (settleTimer !== null) deps.schedule.clearTimeout(settleTimer);
      settleTimer = null;
      for (const handle of writeTimers.values()) deps.schedule.clearTimeout(handle);
      writeTimers.clear();
      // The stage is already stopped; a seam that fails to stop must not fail the caller (repo
      // switch or app quit, which still closes the database).
      try {
        narration.dispose();
      } catch (error) {
        deps.log({ kind: "error", where: "dispose", message: messageOf(error) });
      }
    },
  };
}

export interface ExplainerRegistry {
  repoOpened(repoRoot: string): void;
  repoClosed(repoRoot: string): void;
  sessionStarted(repoRoot: string, sessionId: string): void;
  filesChanged(repoRoot: string, paths: readonly string[]): void;
  /** Ignored unless `repoRoot` is the open repo, so a renderer cannot start a scan elsewhere. */
  rescan(repoRoot: string): void;
  get(repoRoot: string): ExplainerStage | undefined;
  dispose(): void;
}

/**
 * One stage for the open repo; opening another repo disposes the previous stage. The registry
 * forgets a stage before disposing it, and a dispose that throws is logged, so a failed dispose
 * never leaves a dead stage active or stops a repo switch or app quit.
 */
export function createExplainerRegistry(
  factory: (repoRoot: string) => ExplainerStage,
  log: (message: string) => void = () => {},
): ExplainerRegistry {
  let active: { repoRoot: string; stage: ExplainerStage } | null = null;
  const release = (): void => {
    const previous = active;
    active = null;
    if (previous === null) return;
    try {
      previous.stage.dispose();
    } catch (error) {
      log(`explainer stage for ${previous.repoRoot} failed to dispose: ${messageOf(error)}`);
    }
  };
  const ensure = (repoRoot: string): ExplainerStage => {
    if (active !== null && active.repoRoot === repoRoot) return active.stage;
    release();
    const stage = factory(repoRoot);
    active = { repoRoot, stage };
    return stage;
  };
  const existing = (repoRoot: string): ExplainerStage | undefined =>
    active !== null && active.repoRoot === repoRoot ? active.stage : undefined;
  return {
    repoOpened: (repoRoot) => ensure(repoRoot).onRepoOpened(),
    repoClosed(repoRoot) {
      if (active !== null && active.repoRoot === repoRoot) release();
    },
    sessionStarted: (repoRoot, sessionId) => ensure(repoRoot).onSessionStarted(sessionId),
    filesChanged: (repoRoot, paths) => existing(repoRoot)?.onFilesChanged(paths),
    rescan: (repoRoot) => existing(repoRoot)?.rescan(),
    get: existing,
    dispose: release,
  };
}
