import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gitCollect: vi.fn(),
  revertCheck: vi.fn(),
  watcherStart: vi.fn(),
  watcherStop: vi.fn(),
  commandObserve: vi.fn(),
  testCollect: vi.fn(() => null),
}));

vi.mock("@jevcode/evidence-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@jevcode/evidence-engine")>();
  return {
    ...actual,
    createTestCollector: vi.fn(() => ({
      sink: { push: () => {} },
      facts: [],
      collect: mocks.testCollect,
    })),
    createGitCollector: vi.fn(() => ({ collect: mocks.gitCollect })),
    createRevertDetector: vi.fn(() => ({
      check: mocks.revertCheck,
      observeReset: vi.fn(),
    })),
    createFileWatcher: vi.fn(() => ({
      start: mocks.watcherStart,
      stop: mocks.watcherStop,
    })),
    createCommandCollector: vi.fn(() => ({ observe: mocks.commandObserve })),
  };
});

import { createTestCollector } from "@jevcode/evidence-engine";

import { createEvidenceSession, isEBADF } from "./evidence-runtime.js";

function makeSession(log?: (message: string) => void) {
  return createEvidenceSession({
    repoId: "repo-1",
    sessionId: "sess-1",
    repoPath: "/tmp/jevcode-evidence-test",
    sink: { push: () => {} },
    log,
  });
}

function ebadfError(): Error {
  return Object.assign(new Error("spawn EBADF"), { code: "EBADF" });
}

describe("createEvidenceSession", () => {
  it("hoists one TestCollector per evidence session", () => {
    const createTestCollectorMock = vi.mocked(createTestCollector);
    const session = makeSession();
    session.observeTestOutput("pnpm test", "Tests  1 passed (1)\n");
    session.observeTestOutput("pnpm test", "Tests  2 passed (2)\n");
    expect(createTestCollectorMock).toHaveBeenCalledTimes(1);
  });

  describe("git poll failures", () => {
    let unhandled: unknown[];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };

    beforeEach(() => {
      unhandled = [];
      process.on("unhandledRejection", onUnhandled);
      vi.useFakeTimers();
      mocks.gitCollect.mockReset();
      mocks.revertCheck.mockReset();
      mocks.watcherStart.mockReset();
      mocks.watcherStop.mockReset();
    });

    afterEach(() => {
      vi.useRealTimers();
      process.removeListener("unhandledRejection", onUnhandled);
    });

    it("handles a rejecting initial collect and keeps polling", async () => {
      mocks.gitCollect.mockRejectedValueOnce(ebadfError());
      mocks.gitCollect.mockResolvedValue([]);
      mocks.revertCheck.mockResolvedValue(null);
      const logs: string[] = [];
      const session = makeSession((message) => logs.push(message));

      await expect(session.start()).resolves.toBeUndefined();
      expect(mocks.watcherStart).toHaveBeenCalledTimes(1);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("spawn EBADF");

      await vi.advanceTimersByTimeAsync(5000);
      expect(mocks.gitCollect).toHaveBeenCalledTimes(2);
      expect(logs).toHaveLength(1);
      expect(unhandled).toEqual([]);
      await session.stop();
    });

    it("catches poll rejections and rate-limits warnings to every 10th failure", async () => {
      mocks.gitCollect.mockRejectedValue(ebadfError());
      mocks.revertCheck.mockResolvedValue(null);
      const logs: string[] = [];
      const session = makeSession((message) => logs.push(message));

      await session.start();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(logs).toEqual([expect.stringContaining("initial git collect")]);

      await vi.advanceTimersByTimeAsync(50_000);
      expect(logs).toHaveLength(2);
      expect(logs[1]).toContain("10 consecutive");
      expect(unhandled).toEqual([]);
      await session.stop();
    });

    it("recovers the failure counter once a poll succeeds", async () => {
      mocks.gitCollect.mockRejectedValueOnce(ebadfError());
      mocks.gitCollect.mockResolvedValue([]);
      mocks.revertCheck.mockResolvedValue(null);
      const logs: string[] = [];
      const session = makeSession((message) => logs.push(message));

      await session.start();
      expect(logs).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(50_000);
      expect(logs).toHaveLength(1);
      expect(unhandled).toEqual([]);
      await session.stop();
    });

    it("stops polling after stop()", async () => {
      mocks.gitCollect.mockResolvedValue([]);
      mocks.revertCheck.mockResolvedValue(null);
      const session = makeSession();

      await session.start();
      await session.stop();
      const calls = mocks.gitCollect.mock.calls.length;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(mocks.gitCollect.mock.calls.length).toBe(calls);
      expect(mocks.watcherStop).toHaveBeenCalledTimes(1);
    });
  });
});

describe("isEBADF", () => {
  it("matches errno-style spawn errors by code", () => {
    expect(isEBADF(Object.assign(new Error("spawn EBADF"), { code: "EBADF" }))).toBe(true);
  });

  it("matches by message when the code is missing", () => {
    expect(isEBADF(new Error("spawn EBADF"))).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(isEBADF(new Error("Command failed: git status"))).toBe(false);
    expect(isEBADF("nope")).toBe(false);
  });
});
