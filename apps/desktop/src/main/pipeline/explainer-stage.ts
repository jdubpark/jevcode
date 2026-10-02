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
import { assembleSnapshot, clipText, type ComponentDraft, type ComponentText, type WorkspaceManifest } from "@jevcode/codebase-map";
import type { scanPaths, scanRepo } from "@jevcode/codebase-map/node";
import type { extractImports } from "@jevcode/evidence-engine";
import type { JevcodeDb } from "@jevcode/storage";

import { applyFileChanges, buildOverview, scanRepoModel, type BuiltOverview, type RepoModel } from "./explainer-overview.js";

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
  | { kind: "error"; where: "scan" | "rebuild" | "write" | "state"; message: string };

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
  /** Resolves when no scan or rebuild is in flight. Timers are not awaited. */
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
  let built: BuiltOverview | null = null;
  /** The last full snapshot (sessionId ""): the base of progress and failure rows. */
  let content: { snapshot: OverviewSnapshot; key: string } | null = null;
  /** Key of the snapshot in overview_state; only a full snapshot that was appended as a row gets there. */
  let persistedKey: string | null = null;
  /** What the single row writer writes next: a full snapshot, or a progress or failure snapshot. */
  let latest: { snapshot: OverviewSnapshot; key: string } | null = null;
  let scanning: AbortController | null = null;
  let generation = 0;
  let scanCount = 0;
  let rebuildFailures = 0;
  let scanPromise: Promise<void> = Promise.resolve();
  let rebuildChain: Promise<void> = Promise.resolve();
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
      if (!disposed && built !== null && model !== null) publishOrFail(built, model);
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
      persist(pending.snapshot);
      persistedKey = pending.key;
    }
    try {
      deps.emitRowsAvailable(sessionId, seq);
    } catch (error) {
      deps.log({ kind: "error", where: "write", message: messageOf(error) });
    }
  }

  /** One row per session at start, then on change, at most every 2 s (spec §5.5). */
  function requestWrite(sessionId: string): void {
    if (disposed || latest === null) return;
    const last = written.get(sessionId);
    if (last !== undefined && last.key === latest.key) return;
    if (writeTimers.has(sessionId)) return;
    const wait = last === undefined ? 0 : Math.max(0, last.at + SNAPSHOT_WRITE_INTERVAL_MS - deps.now());
    if (wait === 0) {
      writeNow(sessionId);
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

  function requestWriteForCurrentSession(): void {
    const sessionId = deps.sessionId();
    if (sessionId !== null) requestWrite(sessionId);
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
   * Ruling R3: progress and failure rows carry the previous full snapshot's components (or
   * none) with a new `status.scan`. Their keys are unique per scan step, so the progress path
   * hashes nothing; the 2 s writer decides which of them reach the store.
   */
  function publishScanStatus(scan: OverviewStatus["scan"], key: string): void {
    try {
      const base = content?.snapshot ?? emptySnapshot();
      latest = {
        snapshot: {
          ...base,
          scanId: nextScanId(),
          generatedAt: new Date(deps.now()).toISOString(),
          status: { scan, narrator: narratorState() },
        },
        key,
      };
    } catch (error) {
      deps.log({ kind: "error", where: "rebuild", message: messageOf(error) });
      return;
    }
    requestWriteForCurrentSession();
  }

  function publish(overview: BuiltOverview, repo: RepoModel): void {
    const view = viewOf(overview, repo);
    const scanned = repo.files.size;
    const input = {
      sessionId: "",
      repoRoot: deps.repoRoot,
      scanId: nextScanId(),
      partial: repo.partial,
      drafts: overview.drafts,
      totalFiles: repo.partial ? repo.totalFiles : scanned,
      edges: overview.edges,
      externals: overview.externals,
      text: new Map(narration.textFor(view)),
      narrative: null,
      generatedAt: new Date(deps.now()).toISOString(),
    };
    const ruleOnly = assembleSnapshot(input);
    const narrative = narration.narrative(ruleOnly, view);
    const assembled = narrative === null ? ruleOnly : assembleSnapshot({ ...input, narrative });
    const snapshot: OverviewSnapshot = {
      ...assembled,
      status: {
        scan: { state: "done", scanned, total: input.totalFiles },
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
    latest = content;
    try {
      narration.onSnapshot(content.snapshot, view);
    } catch (error) {
      deps.log({ kind: "error", where: "rebuild", message: messageOf(error) });
    }
    requestWriteForCurrentSession();
  }

  /**
   * Publishes, or turns a failure (a RangeError from assembleSnapshot when the snapshot cannot
   * fit, or a seam error) into a failed status row with the previous components. Never throws.
   */
  function publishOrFail(overview: BuiltOverview, repo: RepoModel): void {
    try {
      publish(overview, repo);
      if (status.phase === "failed") setStatus({ phase: "ready", done: repo.files.size, total: repo.files.size, error: null });
    } catch (error) {
      const message = messageOf(error);
      deps.log({ kind: "error", where: "rebuild", message });
      const total = repo.partial ? repo.totalFiles : repo.files.size;
      setStatus({ phase: "failed", done: repo.files.size, total, error: message });
      publishScanStatus(
        { state: "failed", scanned: repo.files.size, total, error: clipText(message, SCAN_ERROR_MAX) },
        `failed:rebuild:${(rebuildFailures += 1)}`,
      );
    }
  }

  function rebuild(): void {
    if (disposed || model === null) return;
    let overview: BuiltOverview;
    try {
      overview = buildOverview(model);
    } catch (error) {
      deps.log({ kind: "error", where: "rebuild", message: messageOf(error) });
      return;
    }
    built = overview;
    publishOrFail(overview, model);
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
        setStatus({ phase: "ready", done: next.files.size, total: next.files.size, error: null });
        rebuild();
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
      try {
        const changed = await applyFileChanges(deps.repoRoot, target, paths, {
          scanPaths: deps.scanPaths,
          extract,
        });
        if (disposed || targetGeneration !== generation || model !== target) return;
        if (changed) rebuild();
      } catch (error) {
        deps.log({ kind: "error", where: "rebuild", message: messageOf(error) });
      }
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
        await Promise.allSettled([scan, chain]);
        if (scan === scanPromise && chain === rebuildChain) return;
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
      narration.dispose();
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

/** One stage for the open repo; opening another repo disposes the previous stage. */
export function createExplainerRegistry(factory: (repoRoot: string) => ExplainerStage): ExplainerRegistry {
  let active: { repoRoot: string; stage: ExplainerStage } | null = null;
  const ensure = (repoRoot: string): ExplainerStage => {
    if (active !== null && active.repoRoot === repoRoot) return active.stage;
    active?.stage.dispose();
    active = { repoRoot, stage: factory(repoRoot) };
    return active.stage;
  };
  const existing = (repoRoot: string): ExplainerStage | undefined =>
    active !== null && active.repoRoot === repoRoot ? active.stage : undefined;
  return {
    repoOpened: (repoRoot) => ensure(repoRoot).onRepoOpened(),
    repoClosed(repoRoot) {
      if (active === null || active.repoRoot !== repoRoot) return;
      active.stage.dispose();
      active = null;
    },
    sessionStarted: (repoRoot, sessionId) => ensure(repoRoot).onSessionStarted(sessionId),
    filesChanged: (repoRoot, paths) => existing(repoRoot)?.onFilesChanged(paths),
    rescan: (repoRoot) => existing(repoRoot)?.rescan(),
    get: existing,
    dispose() {
      active?.stage.dispose();
      active = null;
    },
  };
}
