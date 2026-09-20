import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DegradeClient } from "@jevcode/jev-router";
import { openDb } from "@jevcode/storage";
import type { JevcodeDb } from "@jevcode/storage";
import { afterEach, describe, expect, it } from "vitest";

import { PipelineRuntime } from "./pipeline-runtime.js";
import type { EmitFn } from "./types.js";
import type {
  ModelSelectionRequest,
  ModelSelectionResult,
} from "./model-selection.js";

const FAKE_SELECTOR = (
  request: ModelSelectionRequest,
): ModelSelectionResult => ({
  modelId: "gpt-5.6-mini",
  reasoningEffort: "low",
  tier: "economy",
  auto: true,
  confidence: 0.6,
  rationale: "fake selector",
  probabilities: { economy: 1 },
  contextTokensEstimate: Math.round(request.prompt.length / 4),
  complexity: { prompt: 0.1, topic: 0.1, work: 0.1 },
});

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../",
);

const FAKE_BIN = path.join(
  repoRoot,
  "apps/desktop/src/test-utils/fake-codex.cjs",
);

const ENV_KEYS = [
  "JEVCODE_CODEX_BIN",
  "JEVCODE_CODEX_MODEL",
  "JEVCODE_CODEX_REASONING_EFFORT",
  "JEVCODE_USAGE_BUDGET",
] as const;

const savedEnv = new Map<string, string | undefined>();

afterEach(() => {
  for (const key of ENV_KEYS) {
    const saved = savedEnv.get(key);
    if (saved === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved;
    }
  }
  savedEnv.clear();
});

function setEnv(key: string, value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function createTempDb(dir: string): JevcodeDb {
  return openDb({ dbPath: path.join(dir, "jevcode-test.db") });
}

function makeRepo(dir: string): { repoId: string; sessionId: string } {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "index.ts"), "export const x = 1;\n");
  writeFileSync(path.join(dir, "util.ts"), "export const y = 2;\n");
  return { repoId: "repo-model-test", sessionId: "sess-model-test" };
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 8000,
  label = "condition",
): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function readFakeCodexArgs(dir: string): {
  model: string | null;
  reasoningEffort: string | null;
} {
  const raw = readFileSync(path.join(dir, "fake-codex-args.json"), "utf8");
  return JSON.parse(raw) as { model: string | null; reasoningEffort: string | null };
}

describe("model auto-resolution in PipelineRuntime (fake codex)", () => {
  it("auto-selects, logs, telemetry-persists, and passes concrete values to the adapter", async () => {
    const dir = path.join(tmpdir(), "jevcode-model-auto");
    rmSync(dir, { recursive: true, force: true });
    const { repoId, sessionId } = makeRepo(dir);
    const db = createTempDb(dir);
    db.upsertRepository({
      id: repoId,
      path: dir,
      gitRoot: dir,
      branch: "test",
      baseCommit: "test",
    });
    db.createSession({ id: sessionId, repoId, prompt: "add rate limiting" });
    db.setPreference("agent.usageBudgetFraction", "0.10");

    setEnv("JEVCODE_CODEX_BIN", FAKE_BIN);
    const logs: string[] = [];
    const runtime = new PipelineRuntime({
      db,
      emit: (() => undefined) as EmitFn,
      evidence: false,
      jevClient: new DegradeClient(),
      modelSelector: FAKE_SELECTOR,
      log: (message) => logs.push(message),
    });

    try {
      await runtime.startSession({
        sessionId,
        repoId,
        repoPath: dir,
        prompt: "add rate limiting",
        agentMode: "codex",
      });

      await waitFor(
        () => existsSync(path.join(dir, "fake-codex-args.json")),
        8000,
        "fake codex args file",
      );
      const received = readFakeCodexArgs(dir);
      expect(received.model).toBe("gpt-5.6-mini");
      expect(received.reasoningEffort).toBe("low");

      expect(
        logs.some(
          (line) =>
            line.includes("session sess-model-test started") &&
            line.includes("agent: codex") &&
            line.includes("model: gpt-5.6-mini") &&
            line.includes("effort: low") &&
            line.includes("auto-selected"),
        ),
      ).toBe(true);

      const events = db.listTelemetry({ sessionId });
      const selected = events.find((event) => event.type === "model_selected");
      expect(selected).toBeDefined();
      expect(selected?.payload).toMatchObject({
        modelId: "gpt-5.6-mini",
        reasoningEffort: "low",
        tier: "economy",
        auto: true,
        confidence: 0.6,
      });
      expect(typeof selected?.payload["rationale"]).toBe("string");
      expect(typeof selected?.payload["contextTokensEstimate"]).toBe("number");
    } finally {
      await runtime.stopSession(sessionId);
      db.close();
    }
  }, 30_000);

  it("bypasses auto selection for explicit model and effort", async () => {
    const dir = path.join(tmpdir(), "jevcode-model-explicit");
    rmSync(dir, { recursive: true, force: true });
    const { repoId, sessionId } = makeRepo(dir);
    const db = createTempDb(dir);
    db.upsertRepository({
      id: repoId,
      path: dir,
      gitRoot: dir,
      branch: "test",
      baseCommit: "test",
    });
    db.createSession({ id: sessionId, repoId, prompt: "add rate limiting" });
    db.setPreference("agent.usageBudgetFraction", "0.10");

    setEnv("JEVCODE_CODEX_BIN", FAKE_BIN);
    const logs: string[] = [];
    const runtime = new PipelineRuntime({
      db,
      emit: (() => undefined) as EmitFn,
      evidence: false,
      jevClient: new DegradeClient(),
      modelSelector: FAKE_SELECTOR,
      log: (message) => logs.push(message),
    });

    try {
      await runtime.startSession({
        sessionId,
        repoId,
        repoPath: dir,
        prompt: "add rate limiting",
        agentMode: "codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      });

      await waitFor(
        () => existsSync(path.join(dir, "fake-codex-args.json")),
        8000,
        "fake codex args file",
      );
      const received = readFakeCodexArgs(dir);
      expect(received.model).toBe("gpt-5.6-sol");
      expect(received.reasoningEffort).toBe("high");
      expect(logs.some((line) => line.includes("auto-selected"))).toBe(false);
      expect(
        db.listTelemetry({ sessionId }).some((event) => event.type === "model_selected"),
      ).toBe(false);
    } finally {
      await runtime.stopSession(sessionId);
      db.close();
    }
  }, 30_000);
});
