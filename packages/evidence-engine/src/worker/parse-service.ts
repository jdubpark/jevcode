import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";

import type { SymbolInfo } from "@jevcode/contracts";

import {
  createTreeSitterBackend,
  languageForPath,
  type TreeSitterBackend,
} from "./parser.js";

export interface ParseService {
  parseFile(filePath: string, source: string): Promise<SymbolInfo[]>;
  dispose(): Promise<void>;
}

export function createInlineParseService(): ParseService {
  let backendPromise: Promise<TreeSitterBackend> | null = null;
  let disposed = false;
  const backend = (): Promise<TreeSitterBackend> => {
    backendPromise ??= createTreeSitterBackend();
    return backendPromise;
  };
  return {
    async parseFile(filePath: string, source: string): Promise<SymbolInfo[]> {
      if (disposed) throw new Error("parse service disposed");
      if (languageForPath(filePath) === null) return [];
      return (await backend()).parse(source, languageForPath(filePath)!);
    },
    async dispose(): Promise<void> {
      disposed = true;
      if (backendPromise) {
        await (await backendPromise).dispose();
      }
    },
  };
}

interface TaskItem {
  id: number;
  filePath: string;
  source: string;
  resolve: (symbols: SymbolInfo[]) => void;
  reject: (error: Error) => void;
  promise: Promise<SymbolInfo[]>;
}

interface WorkerResponse {
  id: number;
  filePath: string;
  symbols?: SymbolInfo[];
  error?: string;
}

export interface AnalysisPoolOptions {
  size?: number;
  workerUrl?: URL;
  maxQueueSize?: number;
}

const DEFAULT_MAX_QUEUE_SIZE = 100;

export class AnalysisPool implements ParseService {
  private readonly workerUrl: URL;
  private readonly maxQueueSize: number;
  private readonly workers: Worker[] = [];
  private readonly busy = new Set<Worker>();
  private readonly queue: number[] = [];
  private readonly tasks = new Map<number, TaskItem>();
  private readonly runningByWorker = new Map<Worker, number>();
  private readonly taskWorker = new Map<number, Worker>();
  private readonly inflightByFile = new Map<string, number>();
  private nextId = 1;
  private disposed = false;

  constructor(options: AnalysisPoolOptions = {}) {
    const size = Math.max(
      1,
      options.size ?? Math.max(1, availableParallelism() - 1),
    );
    this.workerUrl = options.workerUrl ?? new URL("./parse-worker.js", import.meta.url);
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    for (let i = 0; i < size; i++) {
      this.spawnWorker(this.workerUrl);
    }
  }

  get queueDepth(): number {
    return this.queue.length;
  }

  private spawnWorker(workerUrl: URL): void {
    const worker = new Worker(workerUrl, { type: "module" });
    worker.on("message", (response: WorkerResponse) => {
      this.busy.delete(worker);
      this.runningByWorker.delete(worker);
      const task = this.tasks.get(response.id);
      if (!task) {
        this.dispatch();
        return;
      }
      this.tasks.delete(response.id);
      this.taskWorker.delete(response.id);
      if (this.inflightByFile.get(task.filePath) === response.id) {
        this.inflightByFile.delete(task.filePath);
      }
      if (response.error !== undefined) {
        task.reject(new Error(response.error));
      } else {
        task.resolve(response.symbols ?? []);
      }
      this.dispatch();
    });
    worker.on("error", (error: Error) => {
      this.dropWorker(worker, new Error(`analysis worker error: ${error.message}`));
    });
    worker.on("exit", (code: number) => {
      if (!this.disposed) {
        this.dropWorker(
          worker,
          new Error(`analysis worker exited unexpectedly (code ${code})`),
        );
      }
    });
    this.workers.push(worker);
  }

  private dropWorker(worker: Worker, error: Error): void {
    const index = this.workers.indexOf(worker);
    if (index === -1) return;
    this.workers.splice(index, 1);
    this.busy.delete(worker);
    const runningId = this.runningByWorker.get(worker);
    this.runningByWorker.delete(worker);
    if (runningId !== undefined) {
      this.taskWorker.delete(runningId);
      const task = this.tasks.get(runningId);
      this.tasks.delete(runningId);
      if (task !== undefined) {
        if (this.inflightByFile.get(task.filePath) === runningId) {
          this.inflightByFile.delete(task.filePath);
        }
        task.reject(error);
      }
    }
    void worker.terminate();
    if (!this.disposed) {
      this.spawnWorker(this.workerUrl);
    }
    this.dispatch();
  }

  private dispatch(): void {
    while (this.queue.length > 0) {
      const idle = this.workers.find((worker) => !this.busy.has(worker));
      if (!idle) return;
      const id = this.queue.shift();
      if (id === undefined) return;
      const item = this.tasks.get(id);
      if (item === undefined) continue;
      this.busy.add(idle);
      this.runningByWorker.set(idle, id);
      this.taskWorker.set(id, idle);
      idle.postMessage({
        id: item.id,
        filePath: item.filePath,
        source: item.source,
      });
    }
  }

  parseFile(filePath: string, source: string): Promise<SymbolInfo[]> {
    if (this.disposed) return Promise.reject(new Error("analysis pool disposed"));
    if (this.workers.length === 0) {
      return Promise.reject(new Error("no analysis workers available"));
    }
    const inflightId = this.inflightByFile.get(filePath);
    if (inflightId !== undefined && this.queue.includes(inflightId)) {
      const item = this.tasks.get(inflightId);
      if (item !== undefined) {
        item.source = source;
        return item.promise;
      }
    }
    if (this.queue.length >= this.maxQueueSize) {
      return Promise.reject(
        new Error(`analysis pool queue full (${this.maxQueueSize} pending parses)`),
      );
    }
    const id = this.nextId++;
    const item: TaskItem = {
      id,
      filePath,
      source,
      resolve: () => {},
      reject: () => {},
      promise: Promise.resolve([]),
    };
    item.promise = new Promise<SymbolInfo[]>((resolve, reject) => {
      item.resolve = resolve;
      item.reject = reject;
    });
    this.tasks.set(id, item);
    this.queue.push(id);
    this.inflightByFile.set(filePath, id);
    this.dispatch();
    return item.promise;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const worker of this.workers) {
      await worker.terminate();
    }
    this.workers.length = 0;
    for (const [, task] of this.tasks) {
      task.reject(new Error("analysis pool disposed"));
    }
    this.tasks.clear();
    this.queue.length = 0;
    this.inflightByFile.clear();
    this.taskWorker.clear();
    this.runningByWorker.clear();
    this.busy.clear();
  }
}
