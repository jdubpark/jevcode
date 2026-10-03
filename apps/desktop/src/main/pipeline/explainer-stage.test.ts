import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { OVERVIEW_SNAPSHOT_MAX_BYTES, OverviewSnapshotSchema, type ChangeUnit, type ExplainerRecord, type OverviewSnapshot } from "@jevcode/contracts";
import { componentIdFor, languageOf, type ScannedFile, type WorkspaceManifest } from "@jevcode/codebase-map";
import type { ScanOptions, scanPaths, scanRepo } from "@jevcode/codebase-map/node";
import type { extractImports } from "@jevcode/evidence-engine";
import { createFakeNarratorClient, type SessionStoryInput } from "@jevcode/jev-router";
import { openDb } from "@jevcode/storage";
import type { JevcodeDb } from "@jevcode/storage";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EXTRACT_CONCURRENCY,
  FILES_SETTLE_MS,
  NO_NARRATION,
  SCAN_PROGRESS_AFTER_MS,
  SNAPSHOT_WRITE_INTERVAL_MS,
  createExplainerRegistry,
  createExplainerStage,
  type ExplainerLogEvent,
  type ExplainerStage,
  type ExplainerStageDeps,
  type ExplainerStatus,
  type NarrationContext,
  type NarrationSeam,
} from "./explainer-stage.js";
import type { MainSlicer } from "./main-slicer.js";

const REPO_ID = "repo_explainer";
const REPO_ROOT = "/work/fx";
const SESSION = "sess_explainer_1";
const SESSION_2 = "sess_explainer_2";

const BASE_SOURCES: Readonly<Record<string, string>> = {
  "package.json": '{"name":"fx"}',
  "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
  "packages/core/package.json": '{"name":"@fx/core"}',
  "packages/core/src/index.ts": "export const user = 1;\n",
  "packages/db/package.json": '{"name":"@fx/db"}',
  "packages/db/src/index.ts": 'import { user } from "@fx/core";\nimport Database from "better-sqlite3";\nexport const db = user;\n',
};
const MANIFEST: WorkspaceManifest = {
  packageDirs: ["packages/core", "packages/db"],
  appDirs: [],
  packageNames: { ".": "fx", "packages/core": "@fx/core", "packages/db": "@fx/db" },
  descriptions: {},
  entryPoints: {},
};
const CORE = componentIdFor("packages/core");
const DB = componentIdFor("packages/db");

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function createDb(): JevcodeDb {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jevcode-explainer-"));
  dirs.push(dir);
  const db = openDb({ dbPath: path.join(dir, "explainer.db") });
  db.upsertRepository({ id: REPO_ID, path: REPO_ROOT, gitRoot: REPO_ROOT });
  db.createSession({ id: SESSION, repoId: REPO_ID });
  db.createSession({ id: SESSION_2, repoId: REPO_ID });
  return db;
}

function snapshotRows(db: JevcodeDb, sessionId: string): { seq: number; snapshot: OverviewSnapshot }[] {
  return db
    .listEvents(sessionId)
    .filter((event) => event.type === "overview_snapshot")
    .map((event) => ({ seq: event.seq, snapshot: OverviewSnapshotSchema.parse(JSON.parse(event.payloadJson)) }));
}

function scanned(filePath: string, text: string): ScannedFile {
  return { path: filePath, hash: createHash("sha1").update(text).digest("hex"), size: text.length, language: languageOf(filePath) };
}

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    schedule: {
      setTimeout: (fn: () => void, ms: number): unknown => {
        const id = nextId++;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout: (handle: unknown): void => {
        timers.delete(handle as number);
      },
    },
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

interface Harness {
  db: JevcodeDb;
  clock: ReturnType<typeof fakeClock>;
  sources: Record<string, string>;
  calls: { scan: number; scanPaths: string[][]; extract: string[] };
  hints: [string, number][];
  logs: ExplainerLogEvent[];
  statuses: ExplainerStatus[];
  control: {
    gate: Promise<void> | null;
    fail: Error | null;
    afterProgress: ((index: number) => void) | null;
    /** Holds scanPaths (the incremental rebuild) until it resolves. */
    pathsGate: Promise<void> | null;
    /** scanPaths throws this after it parsed the files it read, as a read failure halfway would. */
    pathsFail: Error | null;
    manifest: WorkspaceManifest;
  };
  deps: ExplainerStageDeps;
}

/** A pure fake scan over `sources`, so stage tests control timing, failures and content. */
function harness(overrides: Partial<ExplainerStageDeps> = {}, db: JevcodeDb = createDb()): Harness {
  const clock = fakeClock();
  const sources: Record<string, string> = { ...BASE_SOURCES };
  const calls = { scan: 0, scanPaths: [] as string[][], extract: [] as string[] };
  const hints: [string, number][] = [];
  const logs: ExplainerLogEvent[] = [];
  const statuses: ExplainerStatus[] = [];
  const control: Harness["control"] = { gate: null, fail: null, afterProgress: null, pathsGate: null, pathsFail: null, manifest: MANIFEST };
  const scan: typeof scanRepo = async (_root, options: ScanOptions = {}) => {
    calls.scan += 1;
    if (control.gate !== null) await control.gate;
    options.signal?.throwIfAborted();
    if (control.fail !== null) throw control.fail;
    const entries = Object.entries(sources).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const files = entries.map(([filePath, text]) => scanned(filePath, text));
    for (const [index, file] of files.entries()) {
      await options.visit?.(file, entries[index]?.[1] ?? "");
      options.onProgress?.(index + 1, files.length);
      control.afterProgress?.(index);
    }
    return { files, manifest: control.manifest, partial: false, tsconfig: { paths: {}, baseUrl: null }, totalFiles: files.length };
  };
  const scanPathsFake: typeof scanPaths = async (_root, paths, options = {}) => {
    calls.scanPaths.push([...paths]);
    if (control.pathsGate !== null) await control.pathsGate;
    const files: ScannedFile[] = [];
    const gone: string[] = [];
    for (const filePath of paths) {
      const text = sources[filePath];
      if (text === undefined) {
        gone.push(filePath);
        continue;
      }
      const file = scanned(filePath, text);
      files.push(file);
      await options.visit?.(file, text);
    }
    if (control.pathsFail !== null) throw control.pathsFail;
    return { files, gone };
  };
  const extract: typeof extractImports = async (filePath, source) => {
    calls.extract.push(filePath);
    return { specifiers: [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1] ?? ""), exports: [] };
  };
  const deps: ExplainerStageDeps = {
    db,
    repoRoot: REPO_ROOT,
    sessionId: () => SESSION,
    scan,
    scanPaths: scanPathsFake,
    extract,
    emitRowsAvailable: (sessionId, lastSeq) => hints.push([sessionId, lastSeq]),
    now: clock.now,
    schedule: clock.schedule,
    log: (event) => logs.push(event),
    onStatus: (status) => statuses.push(status),
    ...overrides,
  };
  return { db, clock, sources, calls, hints, logs, statuses, control, deps };
}

const stages: ExplainerStage[] = [];
function start(h: Harness): ExplainerStage {
  const stage = createExplainerStage(h.deps);
  stages.push(stage);
  return stage;
}
afterEach(() => {
  while (stages.length > 0) stages.pop()?.dispose();
});

/** Lets pending promise callbacks run without waiting for a gated scan. */
async function flush(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ExplainerStage scan and rows (spec §6.1, §6.5)", () => {
  it("scans on repo open, writes a schema-valid row with a push hint and stores overview_state", async () => {
    const h = harness();
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    const rows = snapshotRows(h.db, SESSION);
    expect(rows).toHaveLength(1);
    const snapshot = rows[0]?.snapshot as OverviewSnapshot;
    expect(snapshot.sessionId).toBe(SESSION);
    expect(snapshot.repoRoot).toBe(REPO_ROOT);
    expect(snapshot.components.map((c) => [c.rootPath, c.roleGuess])).toEqual([
      [".", "config"],
      ["packages/core", "domain"],
      ["packages/db", "storage"],
    ]);
    expect(snapshot.edges.map((e) => [e.from, e.to, e.count])).toEqual([[DB, CORE, 1]]);
    expect(snapshot.externals).toEqual([{ name: "better-sqlite3", usedBy: [{ componentId: DB, count: 1 }] }]);
    expect(snapshot.status).toEqual({ scan: { state: "done", scanned: 6, total: 6 }, narrator: "unavailable" });
    expect(snapshot.counts.totalFiles).toBe(6);
    expect(h.hints).toEqual([[SESSION, rows[0]?.seq]]);
    expect(h.db.getOverviewState(REPO_ROOT)?.snapshot.components).toEqual(snapshot.components);
    expect(stage.status()).toEqual({ phase: "ready", done: 6, total: 6, error: null });
    expect(h.logs.some((event) => event.kind === "scan" && event.files === 6 && !event.partial)).toBe(true);
  });

  it("reports scan progress through onStatus", async () => {
    const h = harness();
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    expect(h.statuses[0]).toEqual({ phase: "scanning", done: 0, total: 0, error: null });
    expect(h.statuses).toContainEqual({ phase: "scanning", done: 3, total: 6, error: null });
    expect(h.statuses[h.statuses.length - 1]?.phase).toBe("ready");
  });

  it("shows the stored map at once on reopen and writes no second row when the scan agrees", async () => {
    const db = createDb();
    const first = start(harness({}, db));
    first.onRepoOpened();
    await first.whenIdle();
    first.dispose();

    const h = harness({ sessionId: () => SESSION_2 }, db);
    const gate = deferred();
    h.control.gate = gate.promise;
    const stage = start(h);
    stage.onRepoOpened();
    expect(snapshotRows(db, SESSION_2)).toHaveLength(1);
    gate.resolve();
    await stage.whenIdle();
    expect(snapshotRows(db, SESSION_2)).toHaveLength(1);
    expect(h.hints).toHaveLength(1);
  });

  it("writes one row per session at session start and never repeats an unchanged snapshot", async () => {
    const h = harness();
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    stage.onSessionStarted(SESSION);
    stage.onSessionStarted(SESSION_2);
    expect(snapshotRows(h.db, SESSION)).toHaveLength(1);
    const second = snapshotRows(h.db, SESSION_2);
    expect(second).toHaveLength(1);
    expect(second[0]?.snapshot.sessionId).toBe(SESSION_2);
    expect(h.calls.scan).toBe(1);
  });

  it("scans on the first session start when the repo-open scan never ran", async () => {
    const h = harness();
    const stage = start(h);
    stage.onSessionStarted(SESSION);
    await stage.whenIdle();
    expect(h.calls.scan).toBe(1);
    expect(snapshotRows(h.db, SESSION)).toHaveLength(1);
  });
});

describe("ExplainerStage turns through the main slicer (lane 07 PL-3 review)", () => {
  it("gives the overview snapshot write, its persist and the published build their turns through the slicer", async () => {
    // A slicer whose budget is never spent: every yield the stage makes is one of its own steps' turns.
    const yields: number[] = [];
    const slicer: MainSlicer = {
      budgetMs: 20,
      turns: 0,
      elapsed: () => 0,
      spent: () => false,
      yield: () => {
        yields.push(yields.length);
        return new Promise<void>((resolve) => setImmediate(resolve));
      },
    };
    const h = harness({ slicer });
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    // In order: the build's turn before its overview, the overview's turn before publishBuilt, and the persist.
    expect(yields.length).toBeGreaterThanOrEqual(3);
    // Same rows and state as before: one schema-valid row and the stored overview.
    expect(snapshotRows(h.db, SESSION)).toHaveLength(1);
    expect(h.db.getOverviewState(REPO_ROOT)?.snapshot.components.length).toBeGreaterThan(0);
  });
});

describe("ExplainerStage scan progress rows (ruling R3)", () => {
  it("writes progress only after 2 s of scanning, at most one row per 2 s, then the done row", async () => {
    const h = harness();
    h.control.afterProgress = () => h.clock.advance(700);
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    // Progress 1..3 lands at 0, 700 and 1,400 ms (under 2 s): no row. Progress 4 at 2,100 ms is
    // the session's first row; 5 (2,800 ms) and 6 (3,500 ms) wait for the writer, which writes
    // 6/6 at 4,100 ms. The done snapshot then waits until 6,100 ms.
    const progress = snapshotRows(h.db, SESSION).map((row) => [row.snapshot.status?.scan, row.snapshot.components.length]);
    expect(progress).toEqual([
      [{ state: "running", scanned: 4, total: 6 }, 0],
      [{ state: "running", scanned: 6, total: 6 }, 0],
    ]);
    expect(h.clock.now()).toBe(4_200);
    h.clock.advance(1_899);
    expect(snapshotRows(h.db, SESSION)).toHaveLength(2);
    h.clock.advance(1);
    const rows = snapshotRows(h.db, SESSION);
    expect(rows).toHaveLength(3);
    expect(rows[2]?.snapshot.status?.scan).toEqual({ state: "done", scanned: 6, total: 6 });
    expect(rows[2]?.snapshot.components).toHaveLength(3);
  });

  it("writes no progress row for a scan under 2 s", async () => {
    const h = harness();
    h.control.afterProgress = () => h.clock.advance((SCAN_PROGRESS_AFTER_MS - 1) / 6);
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    const rows = snapshotRows(h.db, SESSION);
    expect(rows.map((row) => row.snapshot.status?.scan.state)).toEqual(["done"]);
  });

  it("carries the previous snapshot's components in progress rows of a rescan", async () => {
    const h = harness();
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);
    h.control.afterProgress = () => h.clock.advance(SCAN_PROGRESS_AFTER_MS);
    stage.rescan();
    await stage.whenIdle();
    const running = snapshotRows(h.db, SESSION).filter((row) => row.snapshot.status?.scan.state === "running");
    expect(running.length).toBeGreaterThan(0);
    for (const row of running) expect(row.snapshot.components).toHaveLength(3);
  });
});

describe("ExplainerStage narrator status (ruling R3, R4)", () => {
  async function narratorOf(overrides: Partial<ExplainerStageDeps>): Promise<string | undefined> {
    const h = harness(overrides);
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    return snapshotRows(h.db, SESSION)[0]?.snapshot.status?.narrator;
  }
  const seam = (narratorStatus?: () => "pending" | "ready"): NarrationSeam => ({
    textFor: () => new Map(),
    narrative: () => null,
    onSnapshot: () => {},
    dispose: () => {},
    ...(narratorStatus === undefined ? {} : { narratorStatus }),
  });

  it("is unavailable under NO_NARRATION", async () => {
    expect(await narratorOf({})).toBe("unavailable");
  });

  it("is off when the explainWithModel preference is off, whatever the seam says", async () => {
    expect(await narratorOf({ explainWithModel: () => false })).toBe("off");
    expect(await narratorOf({ explainWithModel: () => false, narration: () => seam(() => "ready") })).toBe("off");
  });

  it("is the seam's narratorStatus when it has one, else unavailable", async () => {
    expect(await narratorOf({ explainWithModel: () => true, narration: () => seam(() => "pending") })).toBe("pending");
    expect(await narratorOf({ narration: () => seam() })).toBe("unavailable");
  });
});

describe("ExplainerStage incremental rebuilds (spec §5.1, §6.1)", () => {
  it("re-parses only changed files, keeps untouched content hashes, and equals a fresh scan", async () => {
    const h = harness();
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    const before = snapshotRows(h.db, SESSION)[0]?.snapshot as OverviewSnapshot;
    const extractsBefore = h.calls.extract.length;

    h.sources["packages/core/src/index.ts"] = "export const user = 2;\n";
    stage.onFilesChanged(["packages/core/src/index.ts"]);
    h.clock.advance(FILES_SETTLE_MS);
    await stage.whenIdle();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);

    expect(h.calls.scan).toBe(1);
    expect(h.calls.scanPaths).toEqual([["packages/core/src/index.ts"]]);
    expect(h.calls.extract.slice(extractsBefore)).toEqual(["packages/core/src/index.ts"]);
    const rows = snapshotRows(h.db, SESSION);
    expect(rows).toHaveLength(2);
    const after = rows[1]?.snapshot as OverviewSnapshot;
    const hash = (snapshot: OverviewSnapshot, id: string) => snapshot.components.find((c) => c.id === id)?.contentHash;
    expect(hash(after, CORE)).not.toBe(hash(before, CORE));
    expect(hash(after, DB)).toBe(hash(before, DB));

    const fresh = harness({ sessionId: () => SESSION_2 });
    Object.assign(fresh.sources, h.sources);
    const freshStage = start(fresh);
    freshStage.onRepoOpened();
    await freshStage.whenIdle();
    const freshSnapshot = snapshotRows(fresh.db, SESSION_2)[0]?.snapshot as OverviewSnapshot;
    expect(after.components).toEqual(freshSnapshot.components);
    expect(after.edges).toEqual(freshSnapshot.edges);
    expect(after.externals).toEqual(freshSnapshot.externals);
  });

  it("applies added and removed files incrementally and equals a fresh scan", async () => {
    const h = harness();
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    const extractsBefore = h.calls.extract.length;

    h.sources["packages/db/src/extra.ts"] = 'import { user } from "@fx/core";\nimport { z } from "zod";\nexport const extra = user;\n';
    h.sources["packages/core/src/user.ts"] = "export const user = 1;\n";
    delete h.sources["packages/core/src/index.ts"];
    stage.onFilesChanged(["packages/db/src/extra.ts", "packages/core/src/user.ts", "packages/core/src/index.ts"]);
    h.clock.advance(FILES_SETTLE_MS);
    await stage.whenIdle();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);

    expect(h.calls.scan).toBe(1);
    expect(h.calls.extract.slice(extractsBefore).sort()).toEqual(["packages/core/src/user.ts", "packages/db/src/extra.ts"]);
    const after = snapshotRows(h.db, SESSION).at(-1)?.snapshot as OverviewSnapshot;
    const fresh = harness({ sessionId: () => SESSION_2 });
    for (const key of Object.keys(fresh.sources)) delete fresh.sources[key];
    Object.assign(fresh.sources, h.sources);
    const freshStage = start(fresh);
    freshStage.onRepoOpened();
    await freshStage.whenIdle();
    const freshSnapshot = snapshotRows(fresh.db, SESSION_2)[0]?.snapshot as OverviewSnapshot;
    expect(after.components).toEqual(freshSnapshot.components);
    expect(after.edges).toEqual(freshSnapshot.edges);
    expect(after.externals).toEqual(freshSnapshot.externals);
    expect(after.counts).toEqual(freshSnapshot.counts);
    // With its index.ts gone, "@fx/core" resolves to the package's first member file.
    expect(after.edges.map((edge) => [edge.from, edge.to, edge.examples])).toEqual([
      [DB, CORE, ["packages/db/src/extra.ts → packages/core/package.json", "packages/db/src/index.ts → packages/core/package.json"]],
    ]);
  });

  it("waits for changes to settle and writes a changed snapshot at most once per 2 s", async () => {
    const h = harness();
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    expect(snapshotRows(h.db, SESSION)).toHaveLength(1);

    h.sources["packages/core/src/index.ts"] = "export const user = 2;\n";
    stage.onFilesChanged(["packages/core/src/index.ts"]);
    h.clock.advance(FILES_SETTLE_MS - 1);
    await stage.whenIdle();
    expect(h.calls.scanPaths).toHaveLength(0);
    h.clock.advance(1);
    await stage.whenIdle();
    expect(snapshotRows(h.db, SESSION)).toHaveLength(1);

    h.sources["packages/core/src/index.ts"] = "export const user = 3;\n";
    stage.onFilesChanged(["packages/core/src/index.ts"]);
    h.clock.advance(FILES_SETTLE_MS);
    await stage.whenIdle();
    expect(snapshotRows(h.db, SESSION)).toHaveLength(1);

    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS - 2 * FILES_SETTLE_MS - 1);
    expect(snapshotRows(h.db, SESSION)).toHaveLength(1);
    h.clock.advance(1);
    const rows = snapshotRows(h.db, SESSION);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.snapshot.components.find((c) => c.id === CORE)?.contentHash).toBe(
      createHash("sha1")
        .update(
          [
            `packages/core/package.json:${scanned("x", BASE_SOURCES["packages/core/package.json"] as string).hash}`,
            `packages/core/src/index.ts:${scanned("x", "export const user = 3;\n").hash}`,
          ].join("\n"),
        )
        .digest("hex"),
    );
  });

  it("reruns the full scan when a manifest changes", async () => {
    const h = harness();
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    stage.onFilesChanged(["packages/db/package.json"]);
    h.clock.advance(FILES_SETTLE_MS);
    await stage.whenIdle();
    expect(h.calls.scan).toBe(2);
    expect(h.calls.scanPaths).toEqual([]);
  });

  it("yields to the event loop while it builds the overview of a 20,000-file scan", async () => {
    let ticks = 0;
    const at: Record<string, number> = {};
    const h = harness({
      log: (event) => {
        at[event.kind] ??= ticks;
      },
    });
    for (let index = 0; index < 20_000; index += 1) {
      const dir = `packages/core/src/mod-${Math.floor(index / 100)}`;
      h.sources[`${dir}/file-${index % 100}.ts`] = `import { v } from "./file-${(index + 1) % 100}.js";\nimport "@fx/db";\nexport const v${index} = v;\n`;
    }
    const stage = start(h);
    stage.onRepoOpened();
    let beating = true;
    const beat = (): void => {
      ticks += 1;
      if (beating) setImmediate(beat);
    };
    setImmediate(beat);
    await stage.whenIdle();
    beating = false;
    expect(snapshotRows(h.db, SESSION)).toHaveLength(1);
    // The scan's result and its snapshot are separate turns: other callbacks ran in between.
    expect((at["snapshot"] ?? 0) - (at["scan"] ?? 0)).toBeGreaterThan(1);
  }, 60_000);

  it("applies changes that arrive during a scan once the scan finishes", async () => {
    const h = harness();
    const gate = deferred();
    h.control.gate = gate.promise;
    const stage = start(h);
    stage.onRepoOpened();
    stage.onFilesChanged(["packages/db/src/index.ts"]);
    gate.resolve();
    await stage.whenIdle();
    h.clock.advance(FILES_SETTLE_MS);
    await stage.whenIdle();
    expect(h.calls.scanPaths).toEqual([["packages/db/src/index.ts"]]);
  });
});

describe("ExplainerStage failure and lifecycle (spec §6.6)", () => {
  it("logs a failed scan, writes a failed status row with no components, and recovers on rescan", async () => {
    const h = harness();
    h.control.fail = new Error("git ls-files failed");
    const stage = start(h);
    expect(() => stage.onRepoOpened()).not.toThrow();
    await stage.whenIdle();
    expect(stage.status()).toEqual({ phase: "failed", done: 0, total: 0, error: "git ls-files failed" });
    expect(h.logs).toContainEqual({ kind: "error", where: "scan", message: "git ls-files failed" });
    const failed = snapshotRows(h.db, SESSION);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.snapshot.components).toEqual([]);
    expect(failed[0]?.snapshot.status).toEqual({
      scan: { state: "failed", scanned: 0, total: 0, error: "git ls-files failed" },
      narrator: "unavailable",
    });
    expect(h.db.getOverviewState(REPO_ROOT)).toBeUndefined();

    h.control.fail = null;
    stage.rescan();
    await stage.whenIdle();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);
    expect(stage.status().phase).toBe("ready");
    const rows = snapshotRows(h.db, SESSION);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.snapshot.status?.scan.state).toBe("done");
  });

  it("keeps the previous components in a failed row and clips the error to 200 characters", async () => {
    const h = harness();
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    const before = snapshotRows(h.db, SESSION)[0]?.snapshot as OverviewSnapshot;
    h.control.fail = new Error("x".repeat(500));
    stage.rescan();
    await stage.whenIdle();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);
    const failed = snapshotRows(h.db, SESSION)[1]?.snapshot as OverviewSnapshot;
    expect(failed.components).toEqual(before.components);
    expect(failed.status?.scan.state).toBe("failed");
    expect(failed.status?.scan.error).toHaveLength(200);
    expect(h.db.getOverviewState(REPO_ROOT)?.snapshot.status?.scan.state).toBe("done");
  });

  it("logs a failed row write and keeps running", async () => {
    const h = harness({ sessionId: () => "sess_missing" });
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    expect(h.logs.some((event) => event.kind === "error" && event.where === "write")).toBe(true);
    expect(stage.status().phase).toBe("ready");
  });

  it("writes nothing after dispose, even when an in-flight scan finishes", async () => {
    const h = harness();
    const gate = deferred();
    h.control.gate = gate.promise;
    const stage = start(h);
    stage.onRepoOpened();
    stage.dispose();
    gate.resolve();
    await stage.whenIdle();
    expect(snapshotRows(h.db, SESSION)).toHaveLength(0);
    expect(h.hints).toEqual([]);
  });

  it("aborts a running scan on rescan and keeps only the newer result", async () => {
    const h = harness();
    const gate = deferred();
    h.control.gate = gate.promise;
    const stage = start(h);
    stage.onRepoOpened();
    h.control.gate = null;
    stage.rescan();
    gate.resolve();
    await stage.whenIdle();
    expect(h.calls.scan).toBe(2);
    expect(snapshotRows(h.db, SESSION)).toHaveLength(1);
  });
});

describe("ExplainerStage narration seam (interfaces §5, lane 05)", () => {
  it("uses text from the seam, calls onSnapshot, re-publishes on refresh and disposes the seam", async () => {
    let purpose = "Holds the domain types.";
    let context: NarrationContext | null = null;
    const seen: OverviewSnapshot[] = [];
    let disposed = false;
    const narration = (ctx: NarrationContext): NarrationSeam => {
      context = ctx;
      return {
        textFor: () => new Map([[CORE, { purpose, role: "domain" as const, provenance: "model" as const }]]),
        narrative: () => null,
        onSnapshot: (snapshot) => void seen.push(snapshot),
        dispose: () => {
          disposed = true;
        },
      };
    };
    const h = harness({ narration });
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    const first = snapshotRows(h.db, SESSION)[0]?.snapshot.components.find((c) => c.id === CORE);
    expect(first).toMatchObject({ purpose: "Holds the domain types.", provenance: "model", roleGuess: "domain" });
    expect(seen).toHaveLength(1);

    purpose = "Defines users.";
    (context as unknown as NarrationContext).refresh();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);
    const rows = snapshotRows(h.db, SESSION);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.snapshot.components.find((c) => c.id === CORE)?.purpose).toBe("Defines users.");
    stage.dispose();
    expect(disposed).toBe(true);
  });
});

describe("ExplainerStage dispose (quit path)", () => {
  it("still disposes the stage when the narration seam's dispose throws, and logs it", async () => {
    const narration = (): NarrationSeam => ({
      ...NO_NARRATION,
      dispose: () => {
        throw new Error("seam stuck");
      },
    });
    const h = harness({ narration });
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    h.sources["packages/core/src/index.ts"] = "export const user = 2;\n";
    stage.onFilesChanged(["packages/core/src/index.ts"]);

    expect(() => stage.dispose()).not.toThrow();
    expect(h.logs).toContainEqual({ kind: "error", where: "dispose", message: "seam stuck" });
    h.clock.advance(FILES_SETTLE_MS + SNAPSHOT_WRITE_INTERVAL_MS);
    stage.onFilesChanged(["packages/db/src/index.ts"]);
    stage.rescan();
    h.clock.advance(FILES_SETTLE_MS + SNAPSHOT_WRITE_INTERVAL_MS);
    await stage.whenIdle();
    expect(h.calls.scanPaths).toEqual([]);
    expect(h.calls.scan).toBe(1);
    expect(snapshotRows(h.db, SESSION)).toHaveLength(1);
  });
});

describe("createExplainerRegistry", () => {
  it("forgets a stage whose dispose throws, logs it, and goes on", () => {
    const made: string[] = [];
    const logs: string[] = [];
    const registry = createExplainerRegistry(
      (repoRoot) => {
        made.push(repoRoot);
        return {
          onRepoOpened: () => {},
          onSessionStarted: () => {},
          onFilesChanged: () => {},
          onPipelineSync: () => {},
          rescan: () => {},
          setNarrator: () => {},
          status: () => ({ phase: "idle", done: 0, total: 0, error: null }),
          whenIdle: async () => {},
          dispose: () => {
            throw new Error(`stuck ${repoRoot}`);
          },
        };
      },
      (message) => logs.push(message),
    );
    registry.repoOpened("/a");
    expect(() => registry.repoClosed("/a")).not.toThrow();
    expect(registry.get("/a")).toBeUndefined();
    registry.repoOpened("/a");
    expect(() => registry.repoOpened("/b")).not.toThrow();
    expect(registry.get("/a")).toBeUndefined();
    expect(registry.get("/b")).toBeDefined();
    expect(() => registry.dispose()).not.toThrow();
    expect(registry.get("/b")).toBeUndefined();
    expect(made).toEqual(["/a", "/a", "/b"]);
    expect(logs).toEqual([
      "explainer stage for /a failed to dispose: stuck /a",
      "explainer stage for /a failed to dispose: stuck /a",
      "explainer stage for /b failed to dispose: stuck /b",
    ]);
  });

  it("keeps one stage for the open repo and ignores calls for other repos", () => {
    const made: string[] = [];
    const calls: string[] = [];
    const registry = createExplainerRegistry((repoRoot) => {
      made.push(repoRoot);
      return {
        onRepoOpened: () => void calls.push(`open ${repoRoot}`),
        onSessionStarted: (sessionId) => void calls.push(`session ${repoRoot} ${sessionId}`),
        onFilesChanged: (paths) => void calls.push(`files ${repoRoot} ${paths.join(",")}`),
        onPipelineSync: () => {},
        rescan: () => void calls.push(`rescan ${repoRoot}`),
        setNarrator: () => {},
        status: () => ({ phase: "idle", done: 0, total: 0, error: null }),
        whenIdle: async () => {},
        dispose: () => void calls.push(`dispose ${repoRoot}`),
      };
    });
    registry.repoOpened("/a");
    registry.sessionStarted("/a", "s1");
    registry.filesChanged("/b", ["x.ts"]);
    registry.rescan("/b");
    registry.filesChanged("/a", ["x.ts"]);
    registry.repoOpened("/b");
    registry.rescan("/b");
    registry.repoClosed("/a");
    registry.dispose();
    expect(made).toEqual(["/a", "/b"]);
    expect(calls).toEqual([
      "open /a",
      "session /a s1",
      "files /a x.ts",
      "dispose /a",
      "open /b",
      "rescan /b",
      "dispose /b",
    ]);
  });
});

describe("ExplainerStage row and state bounds (M-6 review requirements)", () => {
  it("bounds in-flight import extracts well under the import pool's 256-task queue", async () => {
    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    const extract: typeof extractImports = async () => {
      calls += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return { specifiers: [], exports: [] };
    };
    const text = "export const x = 1;\n";
    const files = Array.from({ length: 600 }, (_, index) => scanned(`src/f${index}.ts`, text));
    // A scan that visits every file at once, the worst case for the pool's queue.
    const scan: typeof scanRepo = async (_root, options: ScanOptions = {}) => {
      await Promise.all(files.map((file) => options.visit?.(file, text)));
      return {
        files,
        manifest: { packageDirs: [], appDirs: [], packageNames: {}, descriptions: {}, entryPoints: {} },
        partial: false,
        tsconfig: { paths: {}, baseUrl: null },
        totalFiles: files.length,
      };
    };
    const h = harness({ scan, extract });
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    expect(EXTRACT_CONCURRENCY).toBeLessThanOrEqual(64);
    expect(peak).toBe(EXTRACT_CONCURRENCY);
    expect(calls).toBe(600);
    expect(snapshotRows(h.db, SESSION)[0]?.snapshot.counts.files).toBe(600);
  });

  it("stores overview_state as the appended snapshot with an empty sessionId", async () => {
    const h = harness();
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    const row = snapshotRows(h.db, SESSION)[0]?.snapshot as OverviewSnapshot;
    expect(h.db.getOverviewState(REPO_ROOT)?.snapshot).toEqual({ ...row, sessionId: "" });
  });

  it("stores no overview_state while no row was appended", async () => {
    const missing = harness({ sessionId: () => "sess_missing" });
    const failing = start(missing);
    failing.onRepoOpened();
    await failing.whenIdle();
    expect(missing.db.getOverviewState(REPO_ROOT)).toBeUndefined();

    const idle = harness({ sessionId: () => null });
    const stage = start(idle);
    stage.onRepoOpened();
    await stage.whenIdle();
    expect(idle.db.getOverviewState(REPO_ROOT)).toBeUndefined();
    stage.onSessionStarted(SESSION);
    expect(snapshotRows(idle.db, SESSION)).toHaveLength(1);
    // overview_state follows its row a turn later (spec §6.1: one write per turn).
    await stage.whenIdle();
    expect(idle.db.getOverviewState(REPO_ROOT)?.snapshot.status?.scan.state).toBe("done");
  });

  it("keeps the last appended overview_state when the store rejects a row (TypeError)", async () => {
    const db = createDb();
    let reject = false;
    const guarded = Object.create(db) as JevcodeDb;
    guarded.appendEvent = (sessionId, type, payload) => {
      if (reject && type === "overview_snapshot") {
        throw new TypeError(`appendEvent(overview_snapshot): payload is 600000 bytes, over the ${OVERVIEW_SNAPSHOT_MAX_BYTES}-byte cap`);
      }
      return db.appendEvent(sessionId, type, payload);
    };
    const h = harness({ db: guarded }, db);
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    const stored = db.getOverviewState(REPO_ROOT)?.snapshot;

    reject = true;
    h.sources["packages/core/src/index.ts"] = "export const user = 2;\n";
    stage.onFilesChanged(["packages/core/src/index.ts"]);
    h.clock.advance(FILES_SETTLE_MS);
    await stage.whenIdle();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);

    expect(h.logs).toContainEqual(expect.objectContaining({ kind: "error", where: "write" }));
    expect(snapshotRows(db, SESSION)).toHaveLength(1);
    expect(db.getOverviewState(REPO_ROOT)?.snapshot).toEqual(stored);
    expect(stage.status().phase).toBe("ready");
  });

  it("stamps status and a 256-character session id within the 2,048 bytes the assembler reserves", async () => {
    const db = createDb();
    const longSession = `sess_${"a".repeat(251)}`;
    db.createSession({ id: longSession, repoId: REPO_ID });
    const h = harness({ sessionId: () => longSession }, db);
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);
    // Control characters escape to six JSON bytes each: the largest a clipped error can get.
    h.control.fail = new Error("\u0001".repeat(500));
    stage.rescan();
    await stage.whenIdle();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);

    const rows = db.listEvents(longSession).filter((event) => event.type === "overview_snapshot");
    expect(rows.map((row) => (JSON.parse(row.payloadJson) as OverviewSnapshot).status?.scan.state)).toEqual(["done", "failed"]);
    for (const row of rows) {
      const { status: _status, ...unstamped } = JSON.parse(row.payloadJson) as OverviewSnapshot;
      const stampBytes = Buffer.byteLength(row.payloadJson) - Buffer.byteLength(JSON.stringify({ ...unstamped, sessionId: "" }));
      expect(stampBytes).toBeGreaterThan(256);
      expect(stampBytes).toBeLessThanOrEqual(2_048);
    }
  });

  it("drops a narrative that cannot fit (RangeError) and writes the rule-based snapshot (spec E10, §6.6)", async () => {
    const oversized = {
      sentences: Array.from({ length: 8 }, () => ({ text: "x".repeat(100_000), citations: [] })),
      provenance: "model",
    } as unknown as OverviewSnapshot["narrative"];
    const narration = (): NarrationSeam => ({
      textFor: () => new Map(),
      narrative: () => oversized,
      onSnapshot: () => {},
      dispose: () => {},
    });
    const h = harness({ narration });
    const stage = start(h);
    expect(() => stage.onRepoOpened()).not.toThrow();
    await stage.whenIdle();
    expect(h.logs).toContainEqual(
      expect.objectContaining({ kind: "error", where: "rebuild", message: expect.stringMatching(/^overview snapshot exceeds/) }),
    );
    expect(stage.status().phase).toBe("ready");
    const rows = snapshotRows(h.db, SESSION);
    expect(rows.map((row) => [row.snapshot.status?.scan.state, row.snapshot.components.length])).toEqual([["done", 3]]);
    expect(rows[0]?.snapshot.narrative).toBeNull();
    expect(h.db.getOverviewState(REPO_ROOT)?.snapshot.components).toHaveLength(3);
  });

  it.each(["textFor", "narrative"] as const)(
    "writes the rule-based snapshot and logs when the seam's %s throws (spec E10, §6.6)",
    async (failing) => {
      const seamError = new Error("component_text_cache: database is locked");
      const narration = (): NarrationSeam => ({
        textFor: () => {
          if (failing === "textFor") throw seamError;
          return new Map([[CORE, { purpose: "Holds the domain types.", role: "domain" as const, provenance: "model" as const }]]);
        },
        narrative: () => {
          if (failing === "narrative") throw seamError;
          return null;
        },
        onSnapshot: () => {},
        dispose: () => {},
      });
      const h = harness({ narration });
      const stage = start(h);
      expect(() => stage.onRepoOpened()).not.toThrow();
      await stage.whenIdle();
      expect(h.logs).toContainEqual({ kind: "error", where: "rebuild", message: seamError.message });
      expect(stage.status().phase).toBe("ready");
      const rows = snapshotRows(h.db, SESSION);
      expect(rows.map((row) => [row.snapshot.status?.scan.state, row.snapshot.components.length])).toEqual([["done", 3]]);
      expect(rows[0]?.snapshot.narrative).toBeNull();
      const core = rows[0]?.snapshot.components.find((c) => c.id === CORE);
      expect(core?.purpose).toBe(failing === "textFor" ? null : "Holds the domain types.");
    },
  );
});

describe("ExplainerStage failure state (M-6 fix round 1)", () => {
  it("writes a failed row when the overview cannot be built after a scan past 2 s", async () => {
    const h = harness();
    h.control.afterProgress = () => h.clock.advance(700);
    h.control.manifest = Object.defineProperty({ ...MANIFEST }, "packageDirs", {
      get: () => {
        throw new Error("manifest unreadable");
      },
    });
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);

    expect(h.logs).toContainEqual({ kind: "error", where: "rebuild", message: "manifest unreadable" });
    expect(stage.status()).toEqual({ phase: "failed", done: 6, total: 6, error: "manifest unreadable" });
    const rows = snapshotRows(h.db, SESSION);
    expect(rows.map((row) => row.snapshot.status?.scan.state)).toEqual(["running", "running", "failed"]);
    expect(rows[2]?.snapshot.status?.scan).toEqual({ state: "failed", scanned: 6, total: 6, error: "manifest unreadable" });
    expect(rows[2]?.snapshot.components).toEqual([]);
    expect(h.db.getOverviewState(REPO_ROOT)).toBeUndefined();

    h.control.afterProgress = null;
    h.control.manifest = MANIFEST;
    stage.rescan();
    await stage.whenIdle();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);
    expect(snapshotRows(h.db, SESSION).at(-1)?.snapshot.status?.scan.state).toBe("done");
    expect(stage.status().phase).toBe("ready");
  });

  it("keeps a failed scan on every row, through refreshes and incremental rebuilds, until a scan succeeds", async () => {
    let purpose = "Holds the domain types.";
    let context: NarrationContext | null = null;
    const narration = (ctx: NarrationContext): NarrationSeam => {
      context = ctx;
      return {
        textFor: () => new Map([[CORE, { purpose, role: "domain" as const, provenance: "model" as const }]]),
        narrative: () => null,
        onSnapshot: () => {},
        dispose: () => {},
      };
    };
    const h = harness({ narration });
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);
    h.control.fail = new Error("git ls-files failed");
    stage.rescan();
    await stage.whenIdle();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);
    h.control.fail = null;

    purpose = "Defines users.";
    (context as unknown as NarrationContext).refresh();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);
    h.sources["packages/core/src/index.ts"] = "export const user = 2;\n";
    stage.onFilesChanged(["packages/core/src/index.ts"]);
    h.clock.advance(FILES_SETTLE_MS);
    await stage.whenIdle();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);

    const rows = snapshotRows(h.db, SESSION).map((row) => row.snapshot);
    const core = (snapshot: OverviewSnapshot | undefined) => snapshot?.components.find((c) => c.id === CORE);
    expect(rows.map((snapshot) => snapshot.status?.scan.state)).toEqual(["done", "failed", "failed", "failed"]);
    expect(core(rows[2])?.purpose).toBe("Defines users.");
    expect(core(rows[3])?.contentHash).not.toBe(core(rows[2])?.contentHash);
    expect(rows[3]?.status?.scan).toEqual({ state: "failed", scanned: 0, total: 0, error: "git ls-files failed" });
    expect(stage.status().phase).toBe("failed");
    // Failed rows never reach overview_state.
    expect(h.db.getOverviewState(REPO_ROOT)?.snapshot).toEqual({ ...rows[0], sessionId: "" });

    stage.rescan();
    await stage.whenIdle();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);
    await stage.whenIdle();
    const done = snapshotRows(h.db, SESSION).map((row) => row.snapshot);
    expect(done.map((snapshot) => snapshot.status?.scan.state)).toEqual(["done", "failed", "failed", "failed", "done"]);
    expect(core(done[4])?.contentHash).toBe(core(rows[3])?.contentHash);
    expect(stage.status().phase).toBe("ready");
    expect(h.db.getOverviewState(REPO_ROOT)?.snapshot).toEqual({ ...done[4], sessionId: "" });
  });

  it("applies changes queued during a failed rescan to the previous model", async () => {
    const h = harness();
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    const before = snapshotRows(h.db, SESSION)[0]?.snapshot.components.find((c) => c.id === CORE)?.contentHash;
    const gate = deferred();
    h.control.gate = gate.promise;
    h.control.fail = new Error("git ls-files failed");
    stage.rescan();
    h.sources["packages/core/src/index.ts"] = "export const user = 2;\n";
    stage.onFilesChanged(["packages/core/src/index.ts"]);
    gate.resolve();
    await stage.whenIdle();
    expect(stage.status().phase).toBe("failed");

    h.clock.advance(FILES_SETTLE_MS);
    await stage.whenIdle();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);
    expect(h.calls.scanPaths).toEqual([["packages/core/src/index.ts"]]);
    const last = snapshotRows(h.db, SESSION).at(-1)?.snapshot;
    expect(last?.status?.scan.state).toBe("failed");
    expect(last?.components.find((c) => c.id === CORE)?.contentHash).not.toBe(before);
  });
});

describe("ExplainerStage concurrency (M-6 fix round 1)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves no timer and writes nothing after dispose with a row write and a settle pending", async () => {
    // setImmediate stays real: the stage yields a turn between rebuild steps (spec §6.1).
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const h = harness({
      now: () => Date.now(),
      schedule: {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
    });
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    expect(snapshotRows(h.db, SESSION)).toHaveLength(1);

    // A changed snapshot waits for the 2 s writer...
    h.sources["packages/core/src/index.ts"] = "export const user = 2;\n";
    stage.onFilesChanged(["packages/core/src/index.ts"]);
    vi.advanceTimersByTime(FILES_SETTLE_MS);
    await stage.whenIdle();
    // ...and the next change waits to settle.
    h.sources["packages/db/src/index.ts"] = "export const db = 2;\n";
    stage.onFilesChanged(["packages/db/src/index.ts"]);
    expect(vi.getTimerCount()).toBe(2);

    stage.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * SNAPSHOT_WRITE_INTERVAL_MS);
    await stage.whenIdle();
    expect(snapshotRows(h.db, SESSION)).toHaveLength(1);
    expect(h.calls.scanPaths).toEqual([["packages/core/src/index.ts"]]);
    expect(h.hints).toHaveLength(1);
  });

  it("discards an incremental rebuild that finishes while a rescan is in flight", async () => {
    const h = harness();
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);

    const paths = deferred();
    h.control.pathsGate = paths.promise;
    h.sources["packages/core/src/index.ts"] = "export const user = 2;\n";
    stage.onFilesChanged(["packages/core/src/index.ts"]);
    h.clock.advance(FILES_SETTLE_MS);
    await flush();
    expect(h.calls.scanPaths).toEqual([["packages/core/src/index.ts"]]);

    const scan = deferred();
    h.control.gate = scan.promise;
    stage.rescan();
    paths.resolve();
    await flush();
    // The rebuild of the replaced model wrote nothing while the rescan runs.
    expect(snapshotRows(h.db, SESSION)).toHaveLength(1);
    expect(stage.status().phase).toBe("scanning");

    scan.resolve();
    await stage.whenIdle();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);
    const rows = snapshotRows(h.db, SESSION);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.snapshot.status?.scan.state).toBe("done");
    expect(h.calls.scan).toBe(2);
  });

  it("rebuilds from scratch a model a change reached while a failing rescan ran (no stale index)", async () => {
    const h = harness();
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);

    // An add is being read when a rescan starts; the add lands in the model, the rescan fails.
    const paths = deferred();
    h.control.pathsGate = paths.promise;
    h.sources["packages/db/src/new.ts"] = 'import { user } from "@fx/core";\nexport const n = user;\n';
    stage.onFilesChanged(["packages/db/src/new.ts"]);
    h.clock.advance(FILES_SETTLE_MS);
    await flush();
    h.control.fail = new Error("git ls-files failed");
    stage.rescan();
    paths.resolve();
    h.control.pathsGate = null;
    await stage.whenIdle();
    h.control.fail = null;
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);

    // A later edit applies incrementally; the map must equal a fresh scan of the same files.
    h.sources["packages/core/src/index.ts"] = "export const user = 2;\n";
    stage.onFilesChanged(["packages/core/src/index.ts"]);
    h.clock.advance(FILES_SETTLE_MS);
    await stage.whenIdle();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);
    await stage.whenIdle();
    const last = snapshotRows(h.db, SESSION).at(-1)?.snapshot as OverviewSnapshot;
    expect(last.status?.scan.state).toBe("failed");

    const fresh = harness({ sessionId: () => SESSION_2 });
    Object.assign(fresh.sources, h.sources);
    const freshStage = start(fresh);
    freshStage.onRepoOpened();
    await freshStage.whenIdle();
    const reference = snapshotRows(fresh.db, SESSION_2)[0]?.snapshot as OverviewSnapshot;
    expect(last.components).toEqual(reference.components);
    expect(last.edges).toEqual(reference.edges);
    expect(last.counts).toEqual(reference.counts);
    expect(last.components.find((c) => c.id === DB)?.files).toContain("packages/db/src/new.ts");
  });

  it("publishes a batch that lands after a rescan already failed, with no later change", async () => {
    const h = harness();
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);

    const paths = deferred();
    h.control.pathsGate = paths.promise;
    h.sources["packages/db/src/new.ts"] = 'import { user } from "@fx/core";\nexport const n = user;\n';
    stage.onFilesChanged(["packages/db/src/new.ts"]);
    h.clock.advance(FILES_SETTLE_MS);
    await flush();
    // The rescan fails first; the batch's read finishes afterwards.
    h.control.fail = new Error("git ls-files failed");
    stage.rescan();
    await flush();
    expect(stage.status().phase).toBe("failed");
    paths.resolve();
    h.control.pathsGate = null;
    await stage.whenIdle();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);
    await stage.whenIdle();

    const last = snapshotRows(h.db, SESSION).at(-1)?.snapshot as OverviewSnapshot;
    expect(last.status?.scan.state).toBe("failed");
    expect(last.components.find((c) => c.id === DB)?.files).toContain("packages/db/src/new.ts");
    expect([last.counts.files, last.counts.totalFiles]).toEqual([7, 7]);
    expect(last.edges.find((e) => e.from === DB && e.to === CORE)?.count).toBe(2);
  });

  it("rebuilds from scratch after a read that failed halfway parsed files into the model", async () => {
    const h = harness();
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);

    h.sources["packages/db/src/index.ts"] = 'import Database from "better-sqlite3";\nexport const db = 1;\n';
    h.control.pathsFail = new Error("EIO: read failed");
    stage.onFilesChanged(["packages/db/src/index.ts"]);
    h.clock.advance(FILES_SETTLE_MS);
    await stage.whenIdle();
    expect(h.logs).toContainEqual({ kind: "error", where: "rebuild", message: "EIO: read failed" });
    h.control.pathsFail = null;

    h.sources["packages/core/src/index.ts"] = "export const user = 2;\n";
    stage.onFilesChanged(["packages/core/src/index.ts"]);
    h.clock.advance(FILES_SETTLE_MS);
    await stage.whenIdle();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);
    await stage.whenIdle();
    // packages/db no longer imports @fx/core: the edge is gone, as in the parsed model.
    expect(snapshotRows(h.db, SESSION).at(-1)?.snapshot.edges).toEqual([]);
  });

  it("publishes the last successful scan's map when a rescan that cancelled its build fails", async () => {
    let stage: ExplainerStage | null = null;
    let rescanned = false;
    const h = harness({
      log: (event) => {
        if (event.kind !== "scan" || rescanned) return;
        rescanned = true;
        // Runs after the first slice of the 20,000-file build, which then stops.
        setImmediate(() => {
          h.control.fail = new Error("git ls-files failed");
          stage?.rescan();
        });
      },
    });
    for (let index = 0; index < 20_000; index += 1) {
      h.sources[`packages/core/src/mod-${Math.floor(index / 100)}/file-${index % 100}.ts`] = `export const v${index} = ${index};\n`;
    }
    stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);
    await stage.whenIdle();
    expect(rescanned).toBe(true);
    expect(stage.status().phase).toBe("failed");
    const last = snapshotRows(h.db, SESSION).at(-1)?.snapshot as OverviewSnapshot;
    expect(last.status?.scan.state).toBe("failed");
    expect(last.counts.files).toBe(20_006);
    expect(last.components.length).toBeGreaterThan(0);
  }, 60_000);

  it("starts no second scan for a session that starts during a scan, and writes that session a row", async () => {
    let current: string | null = null;
    const h = harness({ sessionId: () => current });
    const gate = deferred();
    h.control.gate = gate.promise;
    const stage = start(h);
    stage.onRepoOpened();
    current = SESSION_2;
    stage.onSessionStarted(SESSION_2);
    expect(h.calls.scan).toBe(1);

    gate.resolve();
    await stage.whenIdle();
    expect(h.calls.scan).toBe(1);
    const rows = snapshotRows(h.db, SESSION_2);
    expect(rows.map((row) => [row.snapshot.sessionId, row.snapshot.status?.scan.state, row.snapshot.components.length])).toEqual([
      [SESSION_2, "done", 3],
    ]);
    expect(snapshotRows(h.db, SESSION)).toHaveLength(0);
  });
});

describe("ExplainerStage session explainer (lane 07 S-2)", () => {
  it("hands pipeline syncs to the session explainer and forwards setNarrator to it", async () => {
    const h = harness({ initialNarrator: null });
    const ts = "2026-10-02T10:00:00.000Z";
    const file = "packages/core/src/index.ts";
    h.db.appendAgentEvent(SESSION, { type: "agent_started", sessionId: SESSION, prompt: "p", ts });
    h.db.appendEvent(SESSION, "overview_snapshot", {
      sessionId: SESSION, repoRoot: REPO_ROOT, scanId: "scan_1", partial: false,
      counts: { files: 1, components: 1, edges: 0, languages: ["TypeScript"] },
      components: [{
        id: CORE, rootPath: "packages/core", name: "@fx/core", fileCount: 1, files: [file], language: "TypeScript",
        roleGuess: "domain", role: "domain", purpose: null, provenance: "rule", contentHash: "a".repeat(40),
        externalDeps: [], entryPoints: [], importsAnalyzed: true,
      }],
      edges: [], externals: [], narrative: null, generatedAt: ts,
    });
    const unit: ChangeUnit = {
      id: "u1", sessionId: SESSION, title: "Unit", category: "implementation", status: "validated",
      files: [`${REPO_ROOT}/${file}`], symbols: [], interfacesChanged: [], schemaChanges: [], dependencyChanges: [], relatedDecisions: [],
      validationResults: [], evidence: [], createdAt: ts, updatedAt: ts,
    };
    h.db.upsertChangeUnit(unit);
    const stage = start(h);
    const narrator = createFakeNarratorClient({
      sessionStory: [
        (input: unknown) => [{ text: "The agent changed core.", citations: [{ kind: "step", id: (input as SessionStoryInput).recentSteps.at(-1)?.id ?? "" }] }],
      ],
    });
    stage.setNarrator(narrator);
    stage.onPipelineSync({ sessionId: SESSION, lastSeq: h.db.getSession(SESSION)?.lastEventSeq ?? 0, changeUnits: [unit], decisions: [] });

    const explainerRows = (): ExplainerRecord[] =>
      h.db.listEvents(SESSION).filter((event) => event.type === "explainer").map((event) => JSON.parse(event.payloadJson) as ExplainerRecord);
    await vi.waitFor(() => expect(explainerRows().map((row) => row.kind)).toEqual(["highlights", "story"]));
    expect(explainerRows()[0]).toMatchObject({ kind: "highlights", components: [{ id: CORE, state: "changed", unitIds: ["u1"] }] });
    expect(explainerRows()[1]).toMatchObject({ kind: "story", provenance: "model" });
    expect(narrator.calls.map((call) => call.method)).toEqual(["sessionStory"]);
    expect(h.hints.at(-1)?.[0]).toBe(SESSION);
  });
});
