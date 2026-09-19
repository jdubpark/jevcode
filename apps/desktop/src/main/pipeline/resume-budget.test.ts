import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { MainToRendererChannels } from "@jevcode/contracts";
import { openDb } from "@jevcode/storage";
import type { JevcodeDb } from "@jevcode/storage";
import { afterEach, describe, expect, it } from "vitest";

import { PipelineRuntime } from "./pipeline-runtime.js";
import type { EmitFn } from "./types.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDb(): JevcodeDb {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jevcode-budget-"));
  tempDirs.push(dir);
  const db = openDb({ dbPath: path.join(dir, "budget.db") });
  db.upsertRepository({ id: "repo_b", path: "/work/b", gitRoot: "/work/b" });
  db.createSession({ id: "sess_budget", repoId: "repo_b" });
  return db;
}

interface Collected {
  channels: Map<string, unknown[]>;
  terminal: string[];
}

function collectEmit(): { emit: EmitFn; collected: Collected } {
  const collected: Collected = { channels: new Map(), terminal: [] };
  const emit: EmitFn = (channel, payload) => {
    const list = collected.channels.get(channel) ?? [];
    list.push(payload);
    collected.channels.set(channel, list);
  };
  return { emit, collected };
}

describe("resume budget", () => {
  it("increments resume_attempts and fails the session on the third resume", async () => {
    const db = createTempDb();
    const { emit, collected } = collectEmit();
    const runtime = new PipelineRuntime({
      db,
      emit,
      evidence: false,
      log: () => {},
      terminal: {
        data: (_sessionId, data) => {
          collected.terminal.push(data);
        },
        ensure: () => {},
      },
    });

    const sessionId = "sess_budget";
    await runtime.startSession({
      sessionId,
      repoId: "repo_b",
      repoPath: "/work/b",
      prompt: "keep running",
      agentMode: "mock",
      mockScript: {
        sessionId,
        repoPath: "/work/b",
        cwd: "/work/b",
        prompt: "keep running",
        entries: [],
      },
    });

    // The claim is set on start.
    expect(db.getSession(sessionId)?.executionClaimTs).not.toBeNull();

    await runtime.resume(sessionId);
    expect(db.getResumeAttempts(sessionId)).toBe(1);
    expect(db.getSession(sessionId)?.state).toBe("running");

    await runtime.resume(sessionId);
    expect(db.getResumeAttempts(sessionId)).toBe(2);
    expect(db.getSession(sessionId)?.state).toBe("running");

    await runtime.resume(sessionId);
    expect(db.getResumeAttempts(sessionId)).toBe(3);
    expect(db.getSession(sessionId)?.state).toBe("failed");
    expect(db.getSession(sessionId)?.executionClaimTs).toBeNull();

    const agentEvents = (collected.channels.get(MainToRendererChannels.agentEvent) ??
      []) as { type: string; error?: string; sessionId: string }[];
    const failed = agentEvents.filter((event) => event.type === "agent_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).toBe("resume budget exhausted");
    expect(failed[0]?.sessionId).toBe(sessionId);

    const agentStates = (collected.channels.get(MainToRendererChannels.agentState) ??
      []) as { state: string }[];
    expect(agentStates.at(-1)?.state).toBe("failed");

    expect(collected.terminal).toContain(
      "[agent] failed: resume budget exhausted",
    );

    db.close();
  });
});
