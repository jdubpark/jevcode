import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  Decision,
  EvidenceFact,
  NormalizedAgentEvent,
} from "@jevcode/contracts";
import { parseReplayLine } from "@jevcode/semantic-core";
import type { PipelineRecord } from "@jevcode/semantic-core";
import { openDb } from "@jevcode/storage";
import type { JevcodeDb } from "@jevcode/storage";
import { describe, expect, it } from "vitest";

import type { MockScriptEntry } from "./mock-agent-adapter.js";
import { PlaybackClient, PlaybackLabels, loadPlaybackFixture } from "./playback.js";
import { PipelineRuntime } from "./pipeline-runtime.js";
import type { EmitFn } from "./types.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../",
);

const fixturePath = path.join(repoRoot, "fixtures", "rate-limit");

interface TimelineEntry {
  channel: string;
  kind: string;
  surfaceId?: string;
}

interface SpecEmission {
  surfaceId: string;
  spec: {
    root: string;
    elements: Record<string, { type: string; props?: Record<string, unknown> }>;
  };
}

function parseStream(): PipelineRecord[] {
  const text = readFileSync(path.join(fixturePath, "events.jsonl"), "utf8");
  const records: PipelineRecord[] = [];
  for (const line of text.split("\n").filter((entry) => entry.trim().length > 0)) {
    const record = parseReplayLine(line);
    if (record !== null) records.push(record);
  }
  return records;
}

function isAgentEvent(record: PipelineRecord): record is NormalizedAgentEvent {
  return !("repoId" in record) && !("severity" in record) && !("kind" in record);
}

function isDecision(record: PipelineRecord): record is Decision {
  return "severity" in record;
}

function rootType(spec: SpecEmission["spec"]): string {
  return spec.elements[spec.root]?.type ?? "";
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 10_000,
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

describe("PRD section 58 demo sequence (headless E2E)", () => {
  it("architecture surface -> decision:open -> answer fail-open -> resume -> validation TestMatrix -> completion review", async () => {
    const dir = path.join(repoRoot, "apps/desktop/.test-tmp/demo-e2e");
    rmSync(dir, { recursive: true, force: true });
    const fixture = loadPlaybackFixture(fixturePath);
    const labels = new PlaybackLabels(fixture.labels, fixture.expectedUnits);
    const records = parseStream();
    const firstAgent = records.find(isAgentEvent) as
      | Extract<NormalizedAgentEvent, { type: "agent_started" }>
      | undefined;
    const sessionId = firstAgent?.sessionId ?? "sess-demo";
    const repoId =
      (records.find((record): record is EvidenceFact => "repoId" in record) as
        | EvidenceFact
        | undefined)?.repoId ?? "repo-demo";

    const openIndex = records.findIndex(
      (record) => isDecision(record) && record.status === "open",
    );
    const answeredIndex = records.findIndex(
      (record) => isDecision(record) && record.status === "answered",
    );
    expect(openIndex).toBeGreaterThan(-1);
    expect(answeredIndex).toBeGreaterThan(openIndex);
    const preDecision = records.slice(0, openIndex + 1);
    const continuation = records.slice(answeredIndex + 1);

    const db: JevcodeDb = openDb({ dbPath: path.join(dir, "demo.db") });
    db.upsertRepository({
      id: repoId,
      path: fixturePath,
      gitRoot: fixturePath,
      branch: "demo",
      baseCommit: "demo",
    });
    db.createSession({ id: sessionId, repoId, prompt: firstAgent?.prompt ?? "" });

    const timeline: TimelineEntry[] = [];
    const specs: SpecEmission[] = [];
    const record = (channel: string, kind: string, surfaceId?: string): void => {
      timeline.push({ channel, kind, surfaceId });
    };
    const emit: EmitFn = (channel, payload) => {
      const entry = payload as Record<string, unknown>;
      switch (channel) {
        case "ui:spec":
          specs.push(entry as unknown as SpecEmission);
          record(
            channel,
            rootType((entry["spec"] as SpecEmission["spec"]) ?? { root: "root", elements: {} }),
            String(entry["surfaceId"] ?? ""),
          );
          break;
        case "decision:open":
          record(channel, "open");
          break;
        case "decision:resolved":
          record(channel, "resolved");
          break;
        case "agent:state":
          record(channel, String(entry["state"] ?? ""));
          break;
        case "agent:event":
          record(channel, String(entry["type"] ?? ""));
          break;
        case "validation:update":
          record(channel, "validation");
          break;
        default:
          break;
      }
    };

    const mockScript = {
      sessionId,
      repoPath: fixturePath,
      cwd: fixturePath,
      prompt: firstAgent?.prompt ?? "",
      entries: preDecision.map((entry): MockScriptEntry => {
        if (isAgentEvent(entry)) return { kind: "agent", event: entry };
        return {
          kind: "record",
          record: entry,
          delayMs: isDecision(entry) ? 800 : 0,
        };
      }),
      autoResumeOnDecision: true,
      onDecision: (): MockScriptEntry[] =>
        continuation.map((entry): MockScriptEntry => {
          if (isAgentEvent(entry)) return { kind: "agent", event: entry };
          return { kind: "record", record: entry };
        }),
    };

    const runtime = new PipelineRuntime({
      db,
      emit,
      evidence: false,
      jevClient: new PlaybackClient(labels),
      interruptAgentOnDecision: true,
      log: () => {},
    });
    await runtime.startSession({
      sessionId,
      repoId,
      repoPath: fixturePath,
      prompt: firstAgent?.prompt ?? "",
      agentMode: "mock",
      mockScript,
      mockThreadId: "th-demo-58",
      playbackLabels: labels,
    });

    try {
      await waitFor(
        () => specs.some((entry) => rootType(entry.spec) === "ArchitectureDelta"),
        10_000,
        "architecture surface",
      );
      await waitFor(
        () => timeline.some((entry) => entry.channel === "decision:open"),
        10_000,
        "decision:open",
      );
      await waitFor(
        () =>
          timeline.some(
            (entry) => entry.channel === "agent:state" && entry.kind === "waiting_decision",
          ),
        10_000,
        "waiting_decision state",
      );

      const openDecision = db.listDecisions(sessionId).find(
        (decision) => decision.status === "open",
      );
      expect(openDecision).toBeDefined();
      const structured = await runtime.answerDecision(sessionId, {
        decisionId: openDecision?.id ?? "",
        decision: { redis_failure_policy: "fail_open" },
        evidence: [],
      });
      expect(structured.decision["redis_failure_policy"]).toBe("fail_open");

      await waitFor(
        () =>
          timeline.some(
            (entry) => entry.channel === "decision:resolved",
          ),
        10_000,
        "decision:resolved",
      );
      await waitFor(
        () =>
          timeline.some(
            (entry) =>
              entry.channel === "agent:event" &&
              entry.kind === "agent_message",
          ),
        10_000,
        "agent message after resume",
      );
      await waitFor(
        () => specs.some((entry) => rootType(entry.spec) === "TestMatrix"),
        10_000,
        "validation TestMatrix",
      );
      await waitFor(
        () =>
          timeline.some(
            (entry) => entry.channel === "agent:event" && entry.kind === "agent_completed",
          ),
        10_000,
        "agent_completed",
      );
      await waitFor(
        () =>
          specs.some(
            (entry) =>
              entry.surfaceId === "completion" && rootType(entry.spec) === "TestMatrix",
          ),
        10_000,
        "completion surface",
      );
      await runtime.syncAll();

      const indexOf = (predicate: (entry: TimelineEntry) => boolean): number =>
        timeline.findIndex(predicate);
      const architectureIndex = indexOf(
        (entry) => entry.channel === "ui:spec" && entry.kind === "ArchitectureDelta",
      );
      const decisionOpenIndex = indexOf(
        (entry) => entry.channel === "decision:open",
      );
      const resolvedIndex = indexOf(
        (entry) => entry.channel === "decision:resolved",
      );
      const validationIndex = indexOf(
        (entry) => entry.channel === "ui:spec" && entry.kind === "TestMatrix",
      );
      const agentCompletedIndex = indexOf(
        (entry) =>
          entry.channel === "agent:event" && entry.kind === "agent_completed",
      );
      const completionIndex = indexOf(
        (entry) =>
          entry.channel === "ui:spec" &&
          entry.kind === "TestMatrix" &&
          entry.surfaceId === "completion",
      );
      expect(architectureIndex).toBeGreaterThan(-1);
      expect(decisionOpenIndex).toBeGreaterThan(-1);
      expect(resolvedIndex).toBeGreaterThan(-1);
      expect(validationIndex).toBeGreaterThan(-1);
      expect(agentCompletedIndex).toBeGreaterThan(-1);
      expect(completionIndex).toBeGreaterThan(-1);
      expect(architectureIndex).toBeLessThan(decisionOpenIndex);
      expect(decisionOpenIndex).toBeLessThan(resolvedIndex);
      expect(resolvedIndex).toBeLessThan(validationIndex);
      expect(agentCompletedIndex).toBeLessThan(completionIndex);
      expect(validationIndex).toBeLessThan(completionIndex);

      const answered = db.getDecision(openDecision?.id ?? "");
      expect(answered?.status).toBe("answered");
      expect(answered?.answer?.decision["redis_failure_policy"]).toBe("fail_open");

      const sessionPayload = db.getSession(sessionId);
      expect(sessionPayload?.state).toBe("completed");
    } finally {
      await runtime.stopSession(sessionId);
      db.close();
    }
  }, 90_000);
});
