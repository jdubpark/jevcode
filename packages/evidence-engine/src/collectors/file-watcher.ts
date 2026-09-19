import { isAbsolute, relative, resolve, sep } from "node:path";

import { watch, type FSWatcher } from "chokidar";

import type { EvidenceFact } from "@jevcode/contracts";

import {
  resolveCollectorConfig,
  sinkFacts,
  type CollectorContext,
  type CollectorOptions,
  type FactSink,
} from "../sink.js";

export type FileChangeKind = "added" | "modified" | "deleted";

export interface FileEventInput {
  path: string;
  kind: FileChangeKind;
}

export class FileEventBuffer {
  private readonly pending = new Map<string, FileEventInput>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly delayMs: number;

  constructor(delayMs = 300) {
    this.delayMs = delayMs;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  enqueue(event: FileEventInput, onFlush: (event: FileEventInput) => void): void {
    const existingTimer = this.timers.get(event.path);
    if (existingTimer) clearTimeout(existingTimer);
    this.pending.set(event.path, event);
    const timer = setTimeout(() => {
      this.timers.delete(event.path);
      const flushed = this.pending.get(event.path);
      this.pending.delete(event.path);
      if (flushed) onFlush(flushed);
    }, this.delayMs);
    this.timers.set(event.path, timer);
  }

  flushAll(onFlush: (event: FileEventInput) => void): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    for (const event of this.pending.values()) {
      onFlush(event);
    }
    this.pending.clear();
  }
}

export function isPathInsideRoot(root: string, absPath: string): boolean {
  const rootResolved = resolve(root);
  const pathResolved = resolve(absPath);
  if (pathResolved === rootResolved) return false;
  const rel = relative(rootResolved, pathResolved);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

export function toRelativePath(root: string, absPath: string): string | null {
  if (!isPathInsideRoot(root, absPath)) return null;
  const rel = relative(resolve(root), resolve(absPath));
  return rel.split(sep).join("/") || null;
}

export interface FileWatcherOptions extends CollectorOptions {
  debounceMs?: number;
  ignoreInitial?: boolean;
}

export interface FileWatcher {
  readonly repoRoot: string;
  readonly sink: FactSink;
  readonly facts: readonly EvidenceFact[];
  readonly violations: number;
  start(): void;
  ready(): Promise<void>;
  handle(absPath: string, kind: FileChangeKind): void;
  stop(): Promise<void>;
}

export function createFileWatcher(
  repoRoot: string,
  opts: FileWatcherOptions = {},
): FileWatcher {
  const cfg = resolveCollectorConfig(repoRoot, opts);
  const ctx: CollectorContext = cfg.ctx;
  const debounceMs = opts.debounceMs ?? 300;
  const ignoreInitial = opts.ignoreInitial ?? true;
  const buffer = new FileEventBuffer(debounceMs);
  let watcher: FSWatcher | null = null;
  let readyPromise: Promise<void> | null = null;
  let violations = 0;

  const emit = (event: FileEventInput): void => {
    const fact: EvidenceFact = {
      type: "file_changed",
      repoId: ctx.repoId,
      sessionId: ctx.sessionId,
      path: event.path,
      kind: event.kind,
      ts: cfg.now(),
    };
    cfg.sink.push(fact);
  };

  return {
    repoRoot,
    sink: cfg.sink,
    get facts(): readonly EvidenceFact[] {
      return sinkFacts(cfg.sink);
    },
    get violations(): number {
      return violations;
    },
    start(): void {
      if (watcher) return;
      watcher = watch(resolve(repoRoot), {
        ignoreInitial,
        ignored: [
          /(^|[\\/])\.git([\\/]|$)/,
          /(^|[\\/])node_modules([\\/]|$)/,
          /(^|[\\/])\.jevcode([\\/]|$)/,
        ],
      });
      watcher.on("add", (path) => this.handle(path, "added"));
      watcher.on("change", (path) => this.handle(path, "modified"));
      watcher.on("unlink", (path) => this.handle(path, "deleted"));
      readyPromise = new Promise<void>((resolveReady) => {
        watcher?.once("ready", () => resolveReady());
      });
    },
    ready(): Promise<void> {
      return readyPromise ?? Promise.resolve();
    },
    handle(absPath: string, kind: FileChangeKind): void {
      const relPath = toRelativePath(repoRoot, absPath);
      if (relPath === null) {
        violations++;
        return;
      }
      buffer.enqueue({ path: relPath, kind }, emit);
    },
    async stop(): Promise<void> {
      const active = watcher;
      watcher = null;
      if (active) await active.close();
      buffer.flushAll(emit);
    },
  };
}
