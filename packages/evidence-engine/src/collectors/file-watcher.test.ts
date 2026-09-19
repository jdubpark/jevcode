import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFileWatcher,
  FileEventBuffer,
  isPathInsideRoot,
  toRelativePath,
} from "./file-watcher.js";

describe("FileEventBuffer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces events per path", () => {
    const buffer = new FileEventBuffer(300);
    const flushed: string[] = [];
    buffer.enqueue({ path: "a.ts", kind: "added" }, (e) =>
      flushed.push(`${e.path}:${e.kind}`),
    );
    vi.advanceTimersByTime(150);
    expect(flushed).toEqual([]);
    vi.advanceTimersByTime(150);
    expect(flushed).toEqual(["a.ts:added"]);
  });

  it("merges same-file events with latest winning", () => {
    const buffer = new FileEventBuffer(300);
    const flushed: string[] = [];
    buffer.enqueue({ path: "a.ts", kind: "added" }, (e) =>
      flushed.push(`${e.path}:${e.kind}`),
    );
    vi.advanceTimersByTime(100);
    buffer.enqueue({ path: "a.ts", kind: "modified" }, (e) =>
      flushed.push(`${e.path}:${e.kind}`),
    );
    vi.advanceTimersByTime(100);
    buffer.enqueue({ path: "a.ts", kind: "deleted" }, (e) =>
      flushed.push(`${e.path}:${e.kind}`),
    );
    vi.advanceTimersByTime(300);
    expect(flushed).toEqual(["a.ts:deleted"]);
  });

  it("does not merge events for different paths", () => {
    const buffer = new FileEventBuffer(300);
    const flushed: string[] = [];
    buffer.enqueue({ path: "a.ts", kind: "modified" }, (e) =>
      flushed.push(`${e.path}:${e.kind}`),
    );
    buffer.enqueue({ path: "b.ts", kind: "modified" }, (e) =>
      flushed.push(`${e.path}:${e.kind}`),
    );
    vi.advanceTimersByTime(300);
    expect(flushed.sort()).toEqual(["a.ts:modified", "b.ts:modified"]);
  });

  it("flushes all pending events on flushAll", () => {
    const buffer = new FileEventBuffer(300);
    const flushed: string[] = [];
    buffer.enqueue({ path: "a.ts", kind: "added" }, (e) =>
      flushed.push(`${e.path}:${e.kind}`),
    );
    buffer.flushAll((e) => flushed.push(`${e.path}:${e.kind}`));
    expect(flushed).toEqual(["a.ts:added"]);
    expect(buffer.pendingCount).toBe(0);
  });
});

describe("path boundary enforcement", () => {
  const root = "/Users/dev/repo";

  it("accepts paths inside the root", () => {
    expect(isPathInsideRoot(root, join(root, "src", "a.ts"))).toBe(true);
    expect(toRelativePath(root, join(root, "src", "a.ts"))).toBe("src/a.ts");
  });

  it("rejects the root itself", () => {
    expect(isPathInsideRoot(root, resolve(root))).toBe(false);
  });

  it("rejects paths outside the root", () => {
    expect(isPathInsideRoot(root, "/Users/dev/other/a.ts")).toBe(false);
    expect(isPathInsideRoot(root, "/etc/passwd")).toBe(false);
  });

  it("rejects traversal attempts", () => {
    expect(isPathInsideRoot(root, join(root, "..", "evil.ts"))).toBe(false);
    expect(toRelativePath(root, join(root, "..", "..", "tmp", "x.ts"))).toBeNull();
  });
});

describe("createFileWatcher", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "jevcode-watcher-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("emits file_changed facts for real filesystem events", async () => {
    const watcher = createFileWatcher(tempDir, {
      repoId: "repo-1",
      sessionId: "sess-1",
      debounceMs: 100,
      ignoreInitial: true,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    watcher.start();
    await watcher.ready();
    try {
      const filePath = join(tempDir, "new-file.ts");
      await writeFile(filePath, "export const x = 1;\n");
      const fact = await waitForFact(watcher, 5000);
      expect(fact).toMatchObject({
        type: "file_changed",
        repoId: "repo-1",
        sessionId: "sess-1",
        path: "new-file.ts",
      });
      // chokidar may deliver add+change bursts for a new file; the buffer
      // merges same-file events within the window with the latest winning
      expect(["added", "modified"]).toContain(fact.kind);

      await writeFile(filePath, "export const x = 2;\n");
      const modified = await waitForKind(watcher, "modified", 5000);
      expect(modified).toMatchObject({ path: "new-file.ts", kind: "modified" });

      await rm(filePath);
      const deleted = await waitForKind(watcher, "deleted", 5000);
      expect(deleted).toMatchObject({ path: "new-file.ts", kind: "deleted" });
    } finally {
      await watcher.stop();
    }
  }, 20000);

  it("rejects events outside the repo root", () => {
    const watcher = createFileWatcher(tempDir, {
      repoId: "repo-1",
      sessionId: "sess-1",
    });
    watcher.handle(join(tempDir, "..", "outside.ts"), "added");
    expect(watcher.violations).toBe(1);
    expect(watcher.facts).toHaveLength(0);
  });
});

function waitForFact(
  watcher: ReturnType<typeof createFileWatcher>,
  timeoutMs: number,
): Promise<{ type: "file_changed"; path: string; kind: string }> {
  return new Promise((resolvePromise, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      const fact = watcher.facts.at(-1);
      if (fact?.type === "file_changed") {
        resolvePromise(fact);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("timed out waiting for file_changed fact"));
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

function waitForKind(
  watcher: ReturnType<typeof createFileWatcher>,
  kind: string,
  timeoutMs: number,
): Promise<{ type: "file_changed"; path: string; kind: string }> {
  return new Promise((resolvePromise, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      const fact = watcher.facts.find(
        (f) => f.type === "file_changed" && f.kind === kind,
      );
      if (fact?.type === "file_changed") {
        resolvePromise(fact);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`timed out waiting for ${kind} fact`));
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}
