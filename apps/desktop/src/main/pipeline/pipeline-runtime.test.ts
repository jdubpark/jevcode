import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  Decision,
  EvidenceFact,
  NormalizedAgentEvent,
} from "@jevcode/contracts";
import { MainToRendererChannels } from "@jevcode/contracts";
import { DegradeClient } from "@jevcode/jev-router";
import type {
  AttentionInput,
  JevClient,
  ProjectionInput,
} from "@jevcode/jev-router";
import { parseReplayLine } from "@jevcode/semantic-core";
import type { PipelineRecord } from "@jevcode/semantic-core";
import { openDb } from "@jevcode/storage";
import type { JevcodeDb } from "@jevcode/storage";
import { describe, expect, it, vi } from "vitest";

import type { MockScriptEntry } from "./mock-agent-adapter.js";
import { MockAgentAdapter } from "./mock-agent-adapter.js";
import { PlaybackClient, PlaybackLabels, loadPlaybackFixture } from "./playback.js";
import { PipelineRuntime } from "./pipeline-runtime.js";
import { notifyCommitted, observeTraceAppends } from "../rows-available.js";
import type { ObservedAppend } from "../rows-available.js";
import { smokeMockScript } from "./smoke-script.js";
import type { EmitFn, SurfaceRecord } from "./types.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../",
);

function fixtureDir(name: string): string {
  return path.join(repoRoot, "fixtures", name);
}

interface Collected {
  channels: Map<string, unknown[]>;
  surfaces: SurfaceRecord[];
}

function collectEmit(): { emit: EmitFn; collected: Collected } {
  const collected: Collected = { channels: new Map(), surfaces: [] };
  const emit: EmitFn = (channel, payload) => {
    const list = collected.channels.get(channel) ?? [];
    list.push(payload);
    collected.channels.set(channel, list);
  };
  return { emit, collected };
}

function createTempDb(dir: string): JevcodeDb {
  return openDb({ dbPath: path.join(dir, "jevcode-test.db") });
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

function parseStream(fixture: string): PipelineRecord[] {
  const text = readFileSync(path.join(fixtureDir(fixture), "events.jsonl"), "utf8");
  const records: PipelineRecord[] = [];
  for (const line of text.split("\n").filter((entry) => entry.trim().length > 0)) {
    const record = parseReplayLine(line);
    if (record !== null) records.push(record);
  }
  return records;
}

function mockScriptFromStream(
  records: readonly PipelineRecord[],
): MockScriptEntry[] {
  const entries: MockScriptEntry[] = [];
  for (const record of records) {
    if (isAgentEvent(record)) {
      entries.push({ kind: "agent", event: record });
    } else {
      entries.push({ kind: "record", record });
    }
  }
  return entries;
}

function isAgentEvent(record: PipelineRecord): record is NormalizedAgentEvent {
  return !("repoId" in record) && !("severity" in record) && !("kind" in record);
}

async function startFixtureSession(
  dir: string,
  fixture: string,
  opts: { jevClient?: DegradeClient | PlaybackClient; playbackLabels?: PlaybackLabels; agentMode?: "replay" | "mock" } = {},
): Promise<{ db: JevcodeDb; runtime: PipelineRuntime; collected: Collected; sessionId: string }> {
  const records = parseStream(fixture);
  const firstAgent = records.find(isAgentEvent) as
    | Extract<NormalizedAgentEvent, { type: "agent_started" }>
    | undefined;
  const firstFact = records.find(
    (record): record is EvidenceFact => "repoId" in record,
  ) as EvidenceFact | undefined;
  const sessionId = firstAgent?.sessionId ?? firstFact?.sessionId ?? "sess-test";
  const repoId = firstFact?.repoId ?? "repo-test";

  rmSync(dir, { recursive: true, force: true });
  const db = createTempDb(dir);
  db.upsertRepository({
    id: repoId,
    path: fixtureDir(fixture),
    gitRoot: fixtureDir(fixture),
    branch: "test",
    baseCommit: "test",
  });
  db.createSession({
    id: sessionId,
    repoId,
    prompt: firstAgent?.prompt ?? "",
  });

  const { emit, collected } = collectEmit();
  const runtime = new PipelineRuntime({
    db,
    emit,
    evidence: false,
    jevClient: opts.jevClient,
    log: () => {},
  });

  await runtime.startSession({
    sessionId,
    repoId,
    repoPath: fixtureDir(fixture),
    prompt: firstAgent?.prompt ?? "",
    agentMode: opts.agentMode ?? "replay",
    playbackLabels: opts.playbackLabels,
  });

  for (const record of records) {
    runtime.ingestPipelineRecord(sessionId, record);
  }
  return { db, runtime, collected, sessionId };
}

describe("PipelineRuntime with MockAgentAdapter over fixtures", () => {
  it("feeds rate-limit agent events through storage + coordinator + degrade client and surfaces units", async () => {
    const dir = path.join(repoRoot, "apps/desktop/.test-tmp/rate-limit-degrade");
    const { db, runtime, collected, sessionId } = await startFixtureSession(
      dir,
      "rate-limit",
      { jevClient: new DegradeClient() },
    );
    try {
      await waitFor(
        () => (collected.channels.get("ui:spec")?.length ?? 0) > 0,
        8000,
        "ui:spec emission",
      );
      await runtime.syncAll();
      const specs = collected.channels.get("ui:spec") ?? [];
      const surfaceIds = specs.map(
        (entry) => (entry as { surfaceId: string }).surfaceId,
      );
      expect(surfaceIds.filter((id) => id.startsWith("changeunit:")).length).toBeGreaterThan(0);

      const agentEvents = db.listAgentEvents(sessionId);
      expect(agentEvents.length).toBeGreaterThan(0);
      expect(agentEvents.some((event) => event.type === "agent_started")).toBe(true);
      expect(agentEvents.some((event) => event.type === "agent_completed")).toBe(true);

      const units = db.listChangeUnits(sessionId);
      expect(units.length).toBeGreaterThanOrEqual(2);

      const facts = db.listEvents(sessionId).filter((event) => event.type === "evidence_fact");
      expect(facts.length).toBeGreaterThan(0);

      const commands = db.listCommands(sessionId);
      expect(commands.length).toBeGreaterThan(0);
      expect(commands.every((command) => typeof command.isDestructive === "boolean")).toBe(true);

      const telemetry = db.listTelemetry({ sessionId });
      expect(telemetry.some((event) => event.type === "agent_event_count")).toBe(true);
      expect(telemetry.some((event) => event.type === "fact_count")).toBe(true);
      expect(telemetry.some((event) => event.type === "surface_shown")).toBe(true);
    } finally {
      await runtime.stopSession(sessionId);
      db.close();
    }
  }, 30_000);

  it("runs the rate-limit stream through the MockAgentAdapter and completes the decision loop", async () => {
    const dir = path.join(repoRoot, "apps/desktop/.test-tmp/rate-limit-mock");
    rmSync(dir, { recursive: true, force: true });
    const fixture = loadPlaybackFixture(fixtureDir("rate-limit"));
    const labels = new PlaybackLabels(fixture.labels, fixture.expectedUnits);
    const records = parseStream("rate-limit");
    const firstAgent = records.find(isAgentEvent) as
      | Extract<NormalizedAgentEvent, { type: "agent_started" }>
      | undefined;
    const sessionId = firstAgent?.sessionId ?? "sess-test";
    const repoId = "repo-test";

    const openIndex = records.findIndex(
      (record) => "severity" in record && record.status === "open",
    );
    const answeredIndex = records.findIndex(
      (record) => "severity" in record && record.status === "answered",
    );
    expect(openIndex).toBeGreaterThan(-1);
    expect(answeredIndex).toBeGreaterThan(openIndex);
    const preDecision = records.slice(0, openIndex + 1);
    const continuation = records.slice(answeredIndex + 1);

    const db = createTempDb(dir);
    db.upsertRepository({
      id: repoId,
      path: fixtureDir("rate-limit"),
      gitRoot: fixtureDir("rate-limit"),
      branch: "test",
      baseCommit: "test",
    });
    db.createSession({ id: sessionId, repoId, prompt: firstAgent?.prompt ?? "" });

    const { emit, collected } = collectEmit();
    const injectedAfterDecision: string[] = [];
    const mockScript = {
      sessionId,
      repoPath: fixtureDir("rate-limit"),
      cwd: fixtureDir("rate-limit"),
      prompt: firstAgent?.prompt ?? "",
      entries: mockScriptFromStream(preDecision),
      autoResumeOnDecision: true,
      onDecision: (): MockScriptEntry[] => {
        injectedAfterDecision.push("sent");
        return mockScriptFromStream(continuation);
      },
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
      repoPath: fixtureDir("rate-limit"),
      prompt: firstAgent?.prompt ?? "",
      agentMode: "mock",
      mockScript,
      playbackLabels: labels,
    });
    try {
      await waitFor(
        () => (collected.channels.get("decision:open")?.length ?? 0) > 0,
        10_000,
        "decision:open",
      );
      const openDecision = db.listDecisions(sessionId)[0];
      expect(openDecision).toBeDefined();
      expect(openDecision?.status).toBe("open");

      await waitFor(
        () =>
          collected.channels
            .get("agent:state")
            ?.some((entry) => (entry as { state: string }).state === "waiting_decision") === true,
        8000,
        "waiting_decision state",
      );

      await runtime.answerDecision(sessionId, {
        decisionId: openDecision?.id ?? "",
        decision: { redis_failure_policy: "fail_open" },
        evidence: [],
      });

      await waitFor(
        () => injectedAfterDecision.length > 0,
        5000,
        "mock adapter decision injection",
      );
      await waitFor(
        () => (collected.channels.get("decision:resolved")?.length ?? 0) > 0,
        8000,
        "decision:resolved",
      );
      await waitFor(
        () => db.getDecision(openDecision?.id ?? "")?.status === "answered",
        5000,
        "answered decision in storage",
      );

      const answered = db.getDecision(openDecision?.id ?? "");
      expect(answered?.status).toBe("answered");
      expect(answered?.answer?.decision["redis_failure_policy"]).toBe("fail_open");

      await waitFor(
        () =>
          collected.channels
            .get("agent:event")
            ?.some((entry) => (entry as { type: string }).type === "agent_completed") === true,
        10_000,
        "agent_completed after resume",
      );
      const agentMessages = collected.channels
        .get("agent:event")
        ?.filter((entry) => (entry as { type: string }).type === "agent_message")
        .map((entry) => (entry as { text: string }).text) ?? [];
      expect(agentMessages.some((text) => text.includes("decision:"))).toBe(true);

      const agentStates = collected.channels.get("agent:state") ?? [];
      expect(
        agentStates.some((entry) => (entry as { state: string }).state === "waiting_decision"),
      ).toBe(true);
      expect(
        agentStates.some((entry) => (entry as { state: string }).state === "running"),
      ).toBe(true);
    } finally {
      await runtime.stopSession(sessionId);
      db.close();
    }
  }, 60_000);

  it("suppresses formatting-only units and never surfaces them (dep-change, playback)", async () => {
    const dir = path.join(repoRoot, "apps/desktop/.test-tmp/dep-change-playback");
    const fixture = loadPlaybackFixture(fixtureDir("dep-change"));
    const labels = new PlaybackLabels(fixture.labels, fixture.expectedUnits);
    const { db, runtime, sessionId } = await startFixtureSession(dir, "dep-change", {
      jevClient: new PlaybackClient(labels),
      playbackLabels: labels,
    });
    try {
      await runtime.syncAll();
      const surfaces = runtime.snapshotSurfaces(sessionId);
      const surfacedSlugs = surfaces.map((surface) => surface.replaySlug);
      expect(surfacedSlugs).toContain("dep-zod-add");
      expect(surfacedSlugs).not.toContain("dep-format-noise");

      const logs = db.listJevDecisions(sessionId);
      const suppression = logs.find((log) => log.clamps.includes("suppress_formatting"));
      expect(suppression).toBeDefined();
    } finally {
      await runtime.stopSession(sessionId);
      db.close();
    }
  }, 30_000);

  it("is idempotent when the same stream is replayed twice", async () => {
    const dir = path.join(repoRoot, "apps/desktop/.test-tmp/rate-limit-idempotent");
    const fixture = loadPlaybackFixture(fixtureDir("rate-limit"));
    const labels = new PlaybackLabels(fixture.labels, fixture.expectedUnits);
    const records = parseStream("rate-limit");
    const firstAgent = records.find(isAgentEvent) as
      | Extract<NormalizedAgentEvent, { type: "agent_started" }>
      | undefined;
    const sessionId = firstAgent?.sessionId ?? "sess-test";

    const db = createTempDb(dir);
    const { emit, collected } = collectEmit();
    const runtime = new PipelineRuntime({
      db,
      emit,
      evidence: false,
      jevClient: new PlaybackClient(labels),
      log: () => {},
    });
    await runtime.startSession({
      sessionId,
      repoId: "repo-test",
      repoPath: fixtureDir("rate-limit"),
      prompt: firstAgent?.prompt ?? "",
      agentMode: "replay",
      playbackLabels: labels,
    });
    try {
      for (const record of records) {
        runtime.ingestPipelineRecord(sessionId, record);
      }
      await runtime.syncAll();
      const unitsAfterFirst = db.listChangeUnits(sessionId).length;
      const specCountAfterFirst = (collected.channels.get("ui:spec") ?? []).length;
      const validationCountAfterFirst = db.listValidations(sessionId).length;

      for (const record of records) {
        runtime.ingestPipelineRecord(sessionId, record);
      }
      await runtime.syncAll();

      expect(db.listChangeUnits(sessionId).length).toBe(unitsAfterFirst);
      expect(db.listValidations(sessionId).length).toBe(validationCountAfterFirst);
      expect((collected.channels.get("ui:spec") ?? []).length).toBe(specCountAfterFirst);

      const rebuild = db.rebuildSession(sessionId);
      expect(rebuild.replayed).toBeGreaterThan(0);
      expect(db.listChangeUnits(sessionId).length).toBe(unitsAfterFirst);
    } finally {
      await runtime.stopSession(sessionId);
      db.close();
    }
  }, 30_000);

  it("emits decision:open then decision:resolved from the answered decision in the stream", async () => {
    const dir = path.join(repoRoot, "apps/desktop/.test-tmp/oauth-decision-stream");
    const fixture = loadPlaybackFixture(fixtureDir("oauth"));
    const labels = new PlaybackLabels(fixture.labels, fixture.expectedUnits);
    const { db, runtime, collected, sessionId } = await startFixtureSession(dir, "oauth", {
      jevClient: new PlaybackClient(labels),
      playbackLabels: labels,
    });
    try {
      await runtime.syncAll();
      expect(collected.channels.get("decision:open")).toBeDefined();
      expect(collected.channels.get("decision:resolved")).toBeDefined();
      const resolved = collected.channels.get("decision:resolved")?.[0] as
        | { answer?: { decision: Record<string, string> } }
        | undefined;
      expect(resolved?.answer?.decision["account_linking_policy"]).toBe("explicit_link");
      void db;
    } finally {
      await runtime.stopSession(sessionId);
      db.close();
    }
  }, 30_000);

  it("emits a completion surface from repository evidence when the agent claims success but a test fails", async () => {
    const dir = path.join(repoRoot, "apps/desktop/.test-tmp/oauth-completion");
    const fixture = loadPlaybackFixture(fixtureDir("oauth"));
    const labels = new PlaybackLabels(fixture.labels, fixture.expectedUnits);
    const { db, runtime, collected, sessionId } = await startFixtureSession(dir, "oauth", {
      jevClient: new PlaybackClient(labels),
      playbackLabels: labels,
    });
    try {
      await waitFor(
        () =>
          collected.channels
            .get("ui:spec")
            ?.some(
              (entry) =>
                (entry as { surfaceId: string }).surfaceId === "completion",
            ) === true,
        10_000,
        "completion surface",
      );
      await runtime.syncAll();
      const completion = collected.channels
        .get("ui:spec")
        ?.find(
          (entry) =>
            (entry as { surfaceId: string }).surfaceId === "completion",
        ) as
        | { spec: { root: string; elements: Record<string, { type: string; props?: Record<string, unknown>; children?: string[] }> } }
        | undefined;
      expect(completion).toBeDefined();
      if (completion === undefined) return;
      const spec = completion.spec;

      const root = spec.elements[spec.root];
      expect(root?.type).toBe("TestMatrix");
      const rootProps = root?.props ?? {};
      const rows = rootProps["rows"] as
        | { name: string; status: string; failed: number }[]
        | undefined;
      expect(rows?.some((row) => row.status === "failed" && row.failed > 0)).toBe(
        true,
      );

      const failureElements = Object.values(spec.elements).filter(
        (element) => element.type === "FailureAnalysis",
      );
      expect(failureElements.length).toBeGreaterThan(0);
      const failureProps = failureElements[0]?.props ?? {};
      const failures = failureProps["failures"] as
        | { file: string; testName: string; message: string }[]
        | undefined;
      expect(
        failures?.some((failure) =>
          failure.testName.includes("links a Google identity"),
        ),
      ).toBe(true);
      expect(
        JSON.stringify(spec).includes("expected null to be 7"),
      ).toBe(true);

      const summaries = Object.values(spec.elements)
        .map((element) => element.props?.["summary"])
        .filter((summary): summary is string => typeof summary === "string");
      expect(
        summaries.some((summary) => summary.includes("failing test(s)")),
      ).toBe(true);

      const snapshots = db.listUiSnapshots(sessionId);
      expect(snapshots.some((snapshot) => snapshot.surfaceId === "completion")).toBe(true);
    } finally {
      await runtime.stopSession(sessionId);
      db.close();
    }
  }, 30_000);
});

describe("MockAgentAdapter decision flow (scripted)", () => {
  it("exposes the codex thread id on the session state", async () => {
    const dir = path.join(repoRoot, "apps/desktop/.test-tmp/mock-thread-id");
    rmSync(dir, { recursive: true, force: true });
    const db = createTempDb(dir);
    const sessionId = "sess-thread-0001";
    db.upsertRepository({
      id: "repo-thread",
      path: dir,
      gitRoot: dir,
      branch: "test",
      baseCommit: "test",
    });
    db.createSession({ id: sessionId, repoId: "repo-thread", prompt: "demo task" });

    const { emit, collected } = collectEmit();
    const mockScript = {
      sessionId,
      repoPath: dir,
      cwd: dir,
      prompt: "demo task",
      entries: [
        {
          kind: "agent" as const,
          event: {
            type: "agent_completed" as const,
            sessionId,
            ts: new Date().toISOString(),
          },
        },
      ],
    };

    const runtime = new PipelineRuntime({
      db,
      emit,
      evidence: false,
      jevClient: new DegradeClient(),
      log: () => {},
    });
    await runtime.startSession({
      sessionId,
      repoId: "repo-thread",
      repoPath: dir,
      prompt: "demo task",
      agentMode: "mock",
      mockScript,
      mockThreadId: "th-demo-123",
    });
    try {
      await waitFor(
        () =>
          collected.channels
            .get("session:state")
            ?.some(
              (entry) =>
                (entry as { agentThreadId?: string }).agentThreadId ===
                "th-demo-123",
            ) === true,
        8000,
        "session:state with agentThreadId",
      );
      const payload = collected.channels
        .get("session:state")
        ?.find(
          (entry) =>
            (entry as { agentThreadId?: string }).agentThreadId === "th-demo-123",
        ) as { agentThreadId?: string };
      expect(payload?.agentThreadId).toBe("th-demo-123");
    } finally {
      await runtime.stopSession(sessionId);
      db.close();
    }
  }, 30_000);

  it("pauses on interrupt and injects records after a decision answer", async () => {
    const dir = path.join(repoRoot, "apps/desktop/.test-tmp/mock-adapter");
    rmSync(dir, { recursive: true, force: true });
    const db = createTempDb(dir);
    const sessionId = "sess-mock-0001";
    db.upsertRepository({
      id: "repo-mock",
      path: dir,
      gitRoot: dir,
      branch: "test",
      baseCommit: "test",
    });
    db.createSession({ id: sessionId, repoId: "repo-mock", prompt: "demo task" });

    const { emit, collected } = collectEmit();
    const decisionRecord: Decision = {
      id: "dec-mock-0001",
      sessionId,
      title: "Fail-open policy",
      context: "What happens when Redis is down?",
      severity: "required",
      options: [
        { id: "fail_open", label: "Fail open", description: "Allow traffic." },
        { id: "fail_closed", label: "Fail closed", description: "Reject traffic." },
      ],
      affectedChangeUnits: [],
      evidence: [],
      status: "open",
    };
    const mockScript = {
      sessionId,
      repoPath: dir,
      cwd: dir,
      prompt: "demo task",
      autoResumeOnDecision: true,
      entries: [
        {
          kind: "agent" as const,
          event: {
            type: "agent_message" as const,
            sessionId,
            role: "assistant" as const,
            text: "Adding the limiter.",
            ts: new Date().toISOString(),
          },
        },
        { kind: "record" as const, record: decisionRecord },
        {
          kind: "agent" as const,
          event: {
            type: "agent_message" as const,
            sessionId,
            role: "assistant" as const,
            text: "Rate limiting shipped.",
            ts: new Date().toISOString(),
          },
        },
        {
          kind: "agent" as const,
          event: {
            type: "agent_completed" as const,
            sessionId,
            ts: new Date().toISOString(),
          },
        },
      ],
      onDecision: () => [
        {
          kind: "agent" as const,
          event: {
            type: "agent_message" as const,
            sessionId,
            role: "assistant" as const,
            text: "Resumed after decision.",
            ts: new Date().toISOString(),
          },
        },
      ],
    };

    const runtime = new PipelineRuntime({
      db,
      emit,
      evidence: false,
      jevClient: new DegradeClient(),
      interruptAgentOnDecision: true,
      log: () => {},
    });
    await runtime.startSession({
      sessionId,
      repoId: "repo-mock",
      repoPath: dir,
      prompt: "demo task",
      agentMode: "mock",
      mockScript,
    });
    try {
      await waitFor(
        () => (collected.channels.get("decision:open")?.length ?? 0) > 0,
        8000,
        "decision:open for scripted decision",
      );
      await runtime.answerDecision(sessionId, {
        decisionId: "dec-mock-0001",
        decision: { redis_failure_policy: "fail_open" },
        evidence: [],
      });
      await waitFor(
        () =>
          collected.channels
            .get("agent:event")
            ?.some(
              (entry) =>
                (entry as { type: string; text?: string }).type === "agent_message" &&
                (entry as { text?: string }).text?.includes("Resumed after decision") === true,
            ) === true,
        8000,
        "resumed agent message",
      );
      expect(collected.channels.get("decision:resolved")?.length ?? 0).toBeGreaterThan(0);
      const decisionRows = db
        .listEvents(sessionId)
        .filter((event) => event.type === "decision")
        .map((event) => JSON.parse(event.payloadJson) as Decision);
      const answered = decisionRows.find(
        (row) => row.id === "dec-mock-0001" && row.status === "answered",
      );
      expect(answered?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(decisionRows.find((row) => row.status === "open")?.ts).toBeUndefined();
      const agentStates = collected.channels.get("agent:state") ?? [];
      expect(
        agentStates.some((entry) => (entry as { state: string }).state === "waiting_decision"),
      ).toBe(true);
    } finally {
      await runtime.stopSession(sessionId);
      db.close();
    }
  }, 30_000);
});

class CountingJevClient implements JevClient {
  attentionCalls = 0;
  projectCalls = 0;

  constructor(private readonly inner: JevClient) {}

  attention(batch: AttentionInput[]): ReturnType<JevClient["attention"]> {
    this.attentionCalls += 1;
    return this.inner.attention(batch);
  }

  project(input: ProjectionInput): ReturnType<JevClient["project"]> {
    this.projectCalls += 1;
    return this.inner.project(input);
  }

  health(): Promise<"ok" | "degraded"> {
    return this.inner.health();
  }
}

describe("PipelineRuntime stability fixes", () => {
  it("serializes concurrent syncs: no duplicate jev calls or duplicate ui:spec per surface", async () => {
    const dir = path.join(repoRoot, "apps/desktop/.test-tmp/rate-limit-concurrent");
    rmSync(dir, { recursive: true, force: true });
    const fixture = loadPlaybackFixture(fixtureDir("rate-limit"));
    const labels = new PlaybackLabels(fixture.labels, fixture.expectedUnits);
    const records = parseStream("rate-limit");
    const firstAgent = records.find(isAgentEvent) as
      | Extract<NormalizedAgentEvent, { type: "agent_started" }>
      | undefined;
    const sessionId = firstAgent?.sessionId ?? "sess-test";

    const db = createTempDb(dir);
    db.upsertRepository({
      id: "repo-test",
      path: fixtureDir("rate-limit"),
      gitRoot: fixtureDir("rate-limit"),
      branch: "test",
      baseCommit: "test",
    });
    db.createSession({ id: sessionId, repoId: "repo-test", prompt: firstAgent?.prompt ?? "" });

    const { emit, collected } = collectEmit();
    const client = new CountingJevClient(new PlaybackClient(labels));
    const runtime = new PipelineRuntime({
      db,
      emit,
      evidence: false,
      jevClient: client,
      log: () => {},
    });
    await runtime.startSession({
      sessionId,
      repoId: "repo-test",
      repoPath: fixtureDir("rate-limit"),
      prompt: firstAgent?.prompt ?? "",
      agentMode: "replay",
      playbackLabels: labels,
    });
    try {
      for (const record of records) {
        runtime.ingestPipelineRecord(sessionId, record);
      }
      // Two overlapping sync waves (debounce + explicit + completion paths).
      await Promise.all([runtime.syncAll(), runtime.syncAll()]);

      const specs = collected.channels.get("ui:spec") ?? [];
      const perSurface = new Map<string, number>();
      for (const spec of specs) {
        const surfaceId = (spec as { surfaceId: string }).surfaceId;
        perSurface.set(surfaceId, (perSurface.get(surfaceId) ?? 0) + 1);
      }
      for (const [surfaceId, count] of perSurface) {
        expect(count, `duplicate ui:spec for ${surfaceId}`).toBe(1);
      }

      // Attention is one batch for the five units; each surfaced unit gets
      // exactly one projection call. A concurrent second sync would double
      // these.
      expect(client.attentionCalls).toBe(1);
      expect(client.projectCalls).toBe(5);
    } finally {
      await runtime.stopSession(sessionId);
      db.close();
    }
  }, 30_000);

  it("isolates failing records: counts them, logs, and keeps ingesting", async () => {
    const dir = path.join(repoRoot, "apps/desktop/.test-tmp/ingest-isolation");
    rmSync(dir, { recursive: true, force: true });
    const db = createTempDb(dir);
    const sessionId = "sess-isolate-0001";
    db.upsertRepository({
      id: "repo-isolate",
      path: dir,
      gitRoot: dir,
      branch: "test",
      baseCommit: "test",
    });
    db.createSession({ id: sessionId, repoId: "repo-isolate", prompt: "demo" });

    const logs: string[] = [];
    const { emit, collected } = collectEmit();
    const runtime = new PipelineRuntime({
      db,
      emit,
      evidence: false,
      jevClient: new DegradeClient(),
      log: (message) => logs.push(message),
    });
    await runtime.startSession({
      sessionId,
      repoId: "repo-isolate",
      repoPath: dir,
      prompt: "demo",
      agentMode: "replay",
    });
    try {
      const ts = "2026-09-19T00:00:00.000Z";
      // Poisoned record: schema-valid but its payload sessionId mismatches
      // the pipeline session, so appendAgentEvent throws.
      runtime.ingestRecord(sessionId, {
        type: "agent_message",
        sessionId: "sess-other",
        role: "assistant",
        text: "boom",
        ts,
      } as NormalizedAgentEvent);
      expect(runtime.getIngestFailures(sessionId)).toBe(1);
      expect(logs.some((message) => message.includes("ingest failed"))).toBe(true);

      // A healthy record still flows through after the failure.
      runtime.ingestRecord(sessionId, {
        type: "agent_message",
        sessionId,
        role: "assistant",
        text: "alive",
        ts,
      } as NormalizedAgentEvent);
      expect(db.listAgentEvents(sessionId)).toHaveLength(1);
      expect(
        collected.channels
          .get("agent:event")
          ?.some((event) => (event as { text?: string }).text === "alive"),
      ).toBe(true);
      expect(runtime.getIngestFailures(sessionId)).toBe(1);
    } finally {
      await runtime.stopSession(sessionId);
      db.close();
    }
  }, 30_000);

  it("plumbs approvalMode through startSession into the adapter's StartSessionInput", async () => {
    const dir = path.join(repoRoot, "apps/desktop/.test-tmp/approval-mode");
    rmSync(dir, { recursive: true, force: true });
    const db = createTempDb(dir);
    const sessionId = "sess-approval-0001";
    db.upsertRepository({
      id: "repo-approval",
      path: dir,
      gitRoot: dir,
      branch: "test",
      baseCommit: "test",
    });
    db.createSession({ id: sessionId, repoId: "repo-approval", prompt: "demo" });

    const { emit } = collectEmit();
    const runtime = new PipelineRuntime({
      db,
      emit,
      evidence: false,
      jevClient: new DegradeClient(),
      log: () => {},
    });
    await runtime.startSession({
      sessionId,
      repoId: "repo-approval",
      repoPath: dir,
      prompt: "demo",
      agentMode: "mock",
      mockScript: {
        sessionId,
        repoPath: dir,
        cwd: dir,
        prompt: "demo",
        entries: [],
      },
      approvalMode: "on-failure",
    });
    try {
      const adapter = runtime.getAdapter(sessionId);
      expect(adapter).toBeInstanceOf(MockAgentAdapter);
      const mock = adapter as MockAgentAdapter;
      expect(mock.lastStartInput?.approvalMode).toBe("on-failure");
    } finally {
      await runtime.stopSession(sessionId);
      db.close();
    }
  }, 30_000);

  it("derives distinct diff surface ids for same-length file lists", async () => {
    const dir = path.join(repoRoot, "apps/desktop/.test-tmp/diff-surface-ids");
    rmSync(dir, { recursive: true, force: true });
    const db = createTempDb(dir);
    const sessionId = "sess-diff-0001";
    db.upsertRepository({
      id: "repo-diff",
      path: dir,
      gitRoot: dir,
      branch: "test",
      baseCommit: "test",
    });
    db.createSession({ id: sessionId, repoId: "repo-diff", prompt: "demo" });

    const { emit, collected } = collectEmit();
    const runtime = new PipelineRuntime({
      db,
      emit,
      evidence: false,
      jevClient: new DegradeClient(),
      log: () => {},
    });
    await runtime.startSession({
      sessionId,
      repoId: "repo-diff",
      repoPath: dir,
      prompt: "demo",
      agentMode: "replay",
    });
    try {
      await runtime.showExactDiff(sessionId, ["a.ts", "b.ts"]);
      await runtime.showExactDiff(sessionId, ["x.ts", "y.ts"]);
      const diffSurfaces = (collected.channels.get("ui:spec") ?? [])
        .map((entry) => entry as { surfaceId: string })
        .filter((entry) => entry.surfaceId.startsWith("diff:"));
      expect(diffSurfaces).toHaveLength(2);
      expect(diffSurfaces[0]?.surfaceId).not.toBe(diffSurfaces[1]?.surfaceId);
    } finally {
      await runtime.stopSession(sessionId);
      db.close();
    }
  }, 30_000);

  it("preserves the failed terminal state when stopping a failed session", async () => {
    const dir = path.join(repoRoot, "apps/desktop/.test-tmp/stop-preserves-failed");
    rmSync(dir, { recursive: true, force: true });
    const db = createTempDb(dir);
    const sessionId = "sess-failed-0001";
    db.upsertRepository({
      id: "repo-failed",
      path: dir,
      gitRoot: dir,
      branch: "test",
      baseCommit: "test",
    });
    db.createSession({ id: sessionId, repoId: "repo-failed", prompt: "demo" });

    const { emit } = collectEmit();
    const runtime = new PipelineRuntime({
      db,
      emit,
      evidence: false,
      jevClient: new DegradeClient(),
      log: () => {},
    });
    await runtime.startSession({
      sessionId,
      repoId: "repo-failed",
      repoPath: dir,
      prompt: "demo",
      agentMode: "mock",
      mockScript: {
        sessionId,
        repoPath: dir,
        cwd: dir,
        prompt: "demo",
        entries: [
          {
            kind: "agent",
            event: {
              type: "agent_failed",
              sessionId,
              error: "boom",
              ts: "2026-09-19T00:00:00.000Z",
            },
          },
        ],
      },
    });
    try {
      await waitFor(
        () => db.getSession(sessionId)?.state === "failed",
        8000,
        "failed session state",
      );
      await runtime.stopSession(sessionId);
      expect(db.getSession(sessionId)?.state).toBe("failed");
      expect(
        db.listAgentEvents(sessionId).some((event) => event.type === "agent_interrupted"),
      ).toBe(false);
    } finally {
      db.close();
    }
  }, 30_000);

  it("defaults a nonzero agent exit while running to failed instead of staying stuck", async () => {
    const dir = path.join(repoRoot, "apps/desktop/.test-tmp/exit-nonzero");
    rmSync(dir, { recursive: true, force: true });
    const db = createTempDb(dir);
    const sessionId = "sess-exit-0001";
    db.upsertRepository({
      id: "repo-exit",
      path: dir,
      gitRoot: dir,
      branch: "test",
      baseCommit: "test",
    });
    db.createSession({ id: sessionId, repoId: "repo-exit", prompt: "demo" });

    const { emit, collected } = collectEmit();
    const runtime = new PipelineRuntime({
      db,
      emit,
      evidence: false,
      jevClient: new DegradeClient(),
      log: () => {},
    });
    await runtime.startSession({
      sessionId,
      repoId: "repo-exit",
      repoPath: dir,
      prompt: "demo",
      agentMode: "mock",
      mockScript: {
        sessionId,
        repoPath: dir,
        cwd: dir,
        prompt: "demo",
        exitCode: 7,
        exitAfterEntries: 1,
        entries: [
          {
            kind: "agent",
            delayMs: 50,
            event: {
              type: "agent_message",
              sessionId,
              role: "assistant",
              text: "working...",
              ts: "2026-09-19T00:00:00.000Z",
            },
          },
        ],
      },
    });
    try {
      await runtime.resume(sessionId);
      await waitFor(
        () => db.getSession(sessionId)?.state === "failed",
        8000,
        "failed after nonzero exit",
      );
      expect(
        collected.channels
          .get("agent:state")
          ?.some((entry) => (entry as { state: string }).state === "failed"),
      ).toBe(true);
    } finally {
      await runtime.stopSession(sessionId);
      db.close();
    }
  }, 30_000);
});

describe("PipelineRuntime honest lifecycle (D10)", () => {
  async function startScripted(
    name: string,
    entries: MockScriptEntry[],
    sink: { ensure(sessionId: string, cwd: string): void } = { ensure: () => {} },
  ): Promise<{
    db: JevcodeDb;
    runtime: PipelineRuntime;
    sessionId: string;
    channels: Map<string, unknown[]>;
  }> {
    const dir = path.join(repoRoot, `apps/desktop/.test-tmp/${name}`);
    rmSync(dir, { recursive: true, force: true });
    const db = createTempDb(dir);
    const sessionId = `sess-${name}`;
    db.upsertRepository({
      id: "repo-lifecycle",
      path: dir,
      gitRoot: dir,
      branch: "test",
      baseCommit: "test",
    });
    db.createSession({ id: sessionId, repoId: "repo-lifecycle", prompt: "demo" });
    const { emit, collected } = collectEmit();
    const runtime = new PipelineRuntime({
      db,
      emit,
      evidence: false,
      jevClient: new DegradeClient(),
      log: () => {},
      terminal: sink,
    });
    await runtime.startSession({
      sessionId,
      repoId: "repo-lifecycle",
      repoPath: dir,
      prompt: "demo",
      agentMode: "mock",
      mockScript: { sessionId, repoPath: dir, cwd: dir, prompt: "demo", entries },
    });
    return { db, runtime, sessionId, channels: collected.channels };
  }

  it("agent events never reach the user's shell (spec E7)", async () => {
    const now = () => new Date().toISOString();
    const writes: string[] = [];
    // A sink that still has data(): before D-5 the runtime wrote agent one-liners through it.
    const sink = {
      ensure: () => {},
      data: (_sessionId: string, data: string) => {
        writes.push(data);
      },
    };
    const sessionId = "sess-shell-separation";
    const { db, runtime, channels } = await startScripted(
      "shell-separation",
      [
        { kind: "agent", event: { type: "agent_message", sessionId, role: "assistant", text: "Reading the router", ts: now() } },
        { kind: "agent", event: { type: "command_started", sessionId, command: "pnpm test", ts: now() } },
        { kind: "agent", event: { type: "command_completed", sessionId, command: "pnpm test", exitCode: 1, stdout: "", stderr: "1 failed", ts: now() } },
        { kind: "terminal", data: "$ pnpm test\r\n" },
        { kind: "agent", event: { type: "file_changed", sessionId, path: "src/router.ts", ts: now() } },
      ],
      sink,
    );
    try {
      await waitFor(
        () => db.listAgentEvents(sessionId).some((event) => event.type === "file_changed"),
        8000,
        "scripted events stored",
      );
      await runtime.syncAll();
      await runtime.stopSession(sessionId);
      expect(writes).toEqual([]);
      expect(channels.get("terminal:data") ?? []).toEqual([]);
      // The Console still has every event: they are trace rows.
      expect(db.listAgentEvents(sessionId).map((event) => event.type)).toEqual(
        expect.arrayContaining(["agent_message", "command_started", "command_completed", "file_changed", "agent_interrupted"]),
      );
    } finally {
      db.close();
    }
  }, 30_000);

  it("stopping a running session records one agent_interrupted, leaves it paused and releases it by default", async () => {
    const { db, runtime, sessionId } = await startScripted("stop-pauses", []);
    try {
      await waitFor(
        () => db.listAgentEvents(sessionId).some((event) => event.type === "agent_started"),
        8000,
        "agent_started stored",
      );
      // Drain the coordinator's debounced rebuild before the db closes.
      await runtime.syncAll();
      await runtime.stopSession(sessionId);

      const events = db.listAgentEvents(sessionId);
      const interrupted = events.filter((event) => event.type === "agent_interrupted");
      expect(interrupted).toHaveLength(1);
      expect(interrupted[0]).toMatchObject({ reason: "stop", sessionId });
      expect(events.some((event) => event.type === "agent_failed")).toBe(false);
      const stored = db.getSession(sessionId);
      expect(stored?.state).toBe("paused");
      expect(stored?.endedAt).toBeNull();
      expect(stored?.executionClaimTs).not.toBeNull();
      // teardown defaults to true (repo close, replay CLI, soak).
      expect(runtime.hasSession(sessionId)).toBe(false);
    } finally {
      db.close();
    }
  }, 30_000);

  function userMessage(sessionId: string, text: string): NormalizedAgentEvent {
    return { type: "agent_message", sessionId, role: "user", text, ts: new Date().toISOString() };
  }

  function messageTexts(db: JevcodeDb, sessionId: string): string[] {
    return db
      .listAgentEvents(sessionId)
      .flatMap((event) => (event.type === "agent_message" ? [event.text] : []));
  }

  it("a stop without teardown keeps the session registered, and resume relaunches the agent", async () => {
    const { db, runtime, sessionId } = await startScripted("stop-resume", []);
    try {
      await waitFor(
        () => db.listAgentEvents(sessionId).some((event) => event.type === "agent_started"),
        8000,
        "agent_started stored",
      );
      await runtime.syncAll();
      await runtime.stopSession(sessionId, { teardown: false });

      expect(runtime.hasSession(sessionId)).toBe(true);
      expect(db.getSession(sessionId)?.state).toBe("paused");
      expect(db.getSession(sessionId)?.endedAt).toBeNull();
      // Stopped: nothing is recorded until the session is resumed.
      runtime.ingestPipelineRecord(sessionId, userMessage(sessionId, "while stopped"));

      const adapter = runtime.getAdapter(sessionId);
      if (adapter === null) throw new Error("mock adapter missing");
      const resume = vi.spyOn(adapter, "resume");
      await runtime.resume(sessionId);

      expect(resume).toHaveBeenCalledTimes(1);
      expect(db.getSession(sessionId)?.state).toBe("running");
      runtime.ingestPipelineRecord(sessionId, userMessage(sessionId, "after resume"));
      expect(messageTexts(db, sessionId)).toEqual(["after resume"]);
      expect(
        db.listAgentEvents(sessionId).filter((event) => event.type === "agent_interrupted"),
      ).toHaveLength(1);
    } finally {
      await runtime.syncAll();
      await runtime.stopSession(sessionId);
      db.close();
    }
  }, 30_000);

  it("an instruction to a session stopped without teardown is recorded", async () => {
    const { db, runtime, sessionId } = await startScripted("stop-instruct", []);
    try {
      await waitFor(
        () => db.listAgentEvents(sessionId).some((event) => event.type === "agent_started"),
        8000,
        "agent_started stored",
      );
      await runtime.syncAll();
      await runtime.stopSession(sessionId, { teardown: false });

      await runtime.sendInstruction(sessionId, {
        id: "instr-after-stop",
        sessionId,
        mode: "queue",
        text: "add the missing test",
      });
      expect(messageTexts(db, sessionId)).toEqual(["add the missing test"]);
    } finally {
      await runtime.syncAll();
      await runtime.stopSession(sessionId);
      db.close();
    }
  }, 30_000);

  it("an agent_interrupted from the adapter pauses the session without ending it", async () => {
    const { db, runtime, sessionId } = await startScripted("interrupt-pauses", [
      {
        kind: "agent",
        event: {
          type: "agent_interrupted",
          sessionId: "sess-interrupt-pauses",
          reason: "interrupt",
          ts: "2026-09-28T10:00:00.000Z",
        },
      },
    ]);
    try {
      await waitFor(
        () => db.getSession(sessionId)?.state === "paused",
        8000,
        "paused after agent_interrupted",
      );
      expect(db.getSession(sessionId)?.endedAt).toBeNull();
    } finally {
      await runtime.syncAll();
      await runtime.stopSession(sessionId);
      db.close();
    }
  }, 30_000);

  it("a steer interruption keeps the session state while the agent relaunches", async () => {
    const { db, runtime, sessionId } = await startScripted("steer-keeps-state", [
      {
        kind: "agent",
        event: {
          type: "agent_interrupted",
          sessionId: "sess-steer-keeps-state",
          reason: "steer",
          ts: "2026-09-28T10:00:00.000Z",
        },
      },
      {
        kind: "agent",
        event: {
          type: "agent_message",
          sessionId: "sess-steer-keeps-state",
          role: "assistant",
          text: "working on the steer",
          ts: "2026-09-28T10:00:01.000Z",
        },
      },
    ]);
    try {
      await waitFor(
        () => db.listAgentEvents(sessionId).some((event) => event.type === "agent_message"),
        8000,
        "message after steer",
      );
      expect(db.getSession(sessionId)?.state).not.toBe("paused");
      expect(db.getSession(sessionId)?.state).not.toBe("failed");
    } finally {
      await runtime.syncAll();
      await runtime.stopSession(sessionId);
      db.close();
    }
  }, 30_000);
});

describe("PipelineRuntime evidence provenance (R2)", () => {
  it("stamps a command completion's callId on its command_executed and test_result facts", async () => {
    const dir = path.join(repoRoot, "apps/desktop/.test-tmp/source-call-id");
    rmSync(dir, { recursive: true, force: true });
    const db = createTempDb(dir);
    // The evidence session watches repoPath; keep the database out of it.
    const repoDir = path.join(dir, "repo");
    mkdirSync(repoDir, { recursive: true });
    const sessionId = "sess-source-call";
    db.upsertRepository({
      id: "repo-source-call",
      path: repoDir,
      gitRoot: repoDir,
      branch: "test",
      baseCommit: "test",
    });
    db.createSession({ id: sessionId, repoId: "repo-source-call", prompt: "demo" });
    const { emit } = collectEmit();
    const runtime = new PipelineRuntime({
      db,
      emit,
      jevClient: new DegradeClient(),
      log: () => {},
    });
    await runtime.startSession({
      sessionId,
      repoId: "repo-source-call",
      repoPath: repoDir,
      prompt: "demo",
      agentMode: "mock",
      mockScript: {
        sessionId,
        repoPath: repoDir,
        cwd: repoDir,
        prompt: "demo",
        entries: [
          {
            kind: "agent",
            event: {
              type: "command_completed",
              sessionId,
              callId: "turn_a:item_7",
              command: "pnpm test",
              exitCode: 1,
              stdout: "Test Files  1 failed (1)\nTests  1 failed | 2 passed (3)\n",
              stderr: "",
              ts: "2026-09-28T10:00:00.000Z",
            },
          },
        ],
      },
    });
    try {
      const facts = (): EvidenceFact[] =>
        db
          .listEvents(sessionId)
          .filter((event) => event.type === "evidence_fact")
          .map((event) => JSON.parse(event.payloadJson) as EvidenceFact);
      await waitFor(
        () => facts().some((fact) => fact.type === "test_result"),
        8000,
        "test_result fact stored",
      );
      // Drain the coordinator's debounced rebuild before the db closes.
      await runtime.syncAll();
      expect(facts().find((fact) => fact.type === "command_executed")).toMatchObject({
        command: "pnpm test",
        exitCode: 1,
        sourceCallId: "turn_a:item_7",
      });
      expect(facts().find((fact) => fact.type === "test_result")).toMatchObject({
        runner: "vitest",
        passed: 2,
        failed: 1,
        sourceCallId: "turn_a:item_7",
      });
    } finally {
      await runtime.stopSession(sessionId);
      db.close();
    }
  }, 30_000);

  it("starts a mock session from mockScriptFor when the input has no script", async () => {
    const dir = path.join(repoRoot, "apps/desktop/.test-tmp/mock-script-for");
    rmSync(dir, { recursive: true, force: true });
    const db = createTempDb(dir);
    const sessionId = "sess-mock-script-for";
    db.upsertRepository({ id: "repo-msf", path: dir, gitRoot: dir, branch: "test", baseCommit: "test" });
    db.createSession({ id: sessionId, repoId: "repo-msf", prompt: "demo" });
    const { emit } = collectEmit();
    const mockScriptFor = vi.fn((input: { sessionId: string; repoPath: string; prompt: string }) => ({
      sessionId: input.sessionId,
      repoPath: input.repoPath,
      cwd: input.repoPath,
      prompt: input.prompt,
      entries: [
        {
          kind: "agent" as const,
          event: { type: "agent_message" as const, sessionId: input.sessionId, role: "assistant" as const, text: "from mockScriptFor", ts: new Date().toISOString() },
        },
      ],
    }));
    const runtime = new PipelineRuntime({ db, emit, evidence: false, jevClient: new DegradeClient(), log: () => {}, mockScriptFor });
    try {
      await runtime.startSession({ sessionId, repoId: "repo-msf", repoPath: dir, prompt: "demo", agentMode: "mock" });
      await waitFor(
        () => db.listAgentEvents(sessionId).some((event) => event.type === "agent_message" && event.text === "from mockScriptFor"),
        8000,
        "scripted message stored",
      );
      expect(mockScriptFor).toHaveBeenCalledTimes(1);
      await runtime.syncAll();
      await runtime.stopSession(sessionId);
    } finally {
      db.close();
    }
  }, 30_000);
});

describe("PipelineRuntime repo file hook (console-explainer M-6)", () => {
  async function startWithHook(name: string, hook: (repoPath: string, paths: readonly string[]) => void) {
    const dir = path.join(repoRoot, `apps/desktop/.test-tmp/${name}`);
    rmSync(dir, { recursive: true, force: true });
    const db = createTempDb(dir);
    const sessionId = `sess-${name}`;
    const repoId = `repo-${name}`;
    db.upsertRepository({ id: repoId, path: dir, gitRoot: dir, branch: "test", baseCommit: "test" });
    db.createSession({ id: sessionId, repoId, prompt: "demo" });
    const runtime = new PipelineRuntime({
      db,
      emit: collectEmit().emit,
      evidence: false,
      jevClient: new DegradeClient(),
      log: () => {},
      onRepoFilesChanged: hook,
    });
    await runtime.startSession({ sessionId, repoId, repoPath: dir, prompt: "demo", agentMode: "replay" });
    const ts = "2026-10-02T10:00:00.000Z";
    runtime.ingestRecord(sessionId, { type: "file_changed", repoId, sessionId, path: "src/a.ts", kind: "modified", ts });
    runtime.ingestRecord(sessionId, {
      type: "git_hunk",
      repoId,
      sessionId,
      file: "src/b.ts",
      added: 1,
      removed: 0,
      isFormattingOnly: false,
      isConfigOnly: false,
      isLockfile: false,
      ts,
    });
    return { db, runtime, sessionId, dir };
  }

  it("forwards file_changed facts with the session's repo path", async () => {
    const calls: [string, string[]][] = [];
    const { db, runtime, sessionId, dir } = await startWithHook("explainer-hook", (repoPath, paths) => {
      calls.push([repoPath, [...paths]]);
    });
    try {
      expect(calls).toEqual([[dir, ["src/a.ts"]]]);
    } finally {
      await runtime.stopSession(sessionId);
      db.close();
    }
  });

  it("keeps ingesting when the hook throws", async () => {
    const { db, runtime, sessionId } = await startWithHook("explainer-hook-throws", () => {
      throw new Error("boom");
    });
    try {
      expect(db.listEvents(sessionId).filter((event) => event.type === "evidence_fact")).toHaveLength(2);
      expect(runtime.getIngestFailures(sessionId)).toBe(0);
    } finally {
      await runtime.stopSession(sessionId);
      db.close();
    }
  });
});

describe("PipelineRuntime turn-end batch (lane 03 D-6, PL-2)", () => {
  it("hints each turn-end row once it is committed, the last hint carrying the last row's seq", async () => {
    const dir = path.join(repoRoot, "apps/desktop/.test-tmp/turn-end-batch");
    rmSync(dir, { recursive: true, force: true });
    const db = createTempDb(dir);
    const sessionId = "sess-turn-end";
    db.upsertRepository({ id: "repo-te", path: dir, gitRoot: dir, branch: "test", baseCommit: "test" });
    db.createSession({ id: sessionId, repoId: "repo-te", prompt: "demo" });

    // What index.ts wires: committed trace rows → hints.
    const batches: Array<{ events: readonly ObservedAppend[]; inTransaction: boolean }> = [];
    const hints: Array<{ seq: number; inTransaction: boolean }> = [];
    observeTraceAppends(db, (events) => {
      batches.push({ events, inTransaction: db.inTransaction });
      notifyCommitted({ notify: (_sessionId, seq) => hints.push({ seq, inTransaction: db.inTransaction }) }, events);
    });
    let completionWritten = false;
    const upsertUiSnapshot = db.upsertUiSnapshot.bind(db);
    db.upsertUiSnapshot = ((id, snapshot) => {
      const stored = upsertUiSnapshot(id, snapshot);
      if (snapshot.surfaceId === "completion") completionWritten = true;
      return stored;
    }) as typeof db.upsertUiSnapshot;

    const { emit } = collectEmit();
    const runtime = new PipelineRuntime({
      db,
      emit,
      evidence: false,
      jevClient: new DegradeClient(),
      log: () => {},
      mockScriptFor: (input) => smokeMockScript(input, { steps: 3, spacingMs: 1 }),
    });
    try {
      await runtime.startSession({ sessionId, repoId: "repo-te", repoPath: dir, prompt: "demo", agentMode: "mock" });
      await waitFor(() => completionWritten, 15_000, "completion surface written");
      await runtime.syncAll();

      // Every Jev decision row was reported once, after its own commit: no transaction holds a turn end's rows back.
      const jevSeqs = db.listEvents(sessionId).filter((event) => event.type === "jev_decision").map((event) => event.seq);
      const reported = batches.flatMap((batch) => batch.events.map((event) => event.seq));
      expect(jevSeqs.length).toBeGreaterThan(0);
      expect(jevSeqs.every((seq) => reported.filter((candidate) => candidate === seq).length === 1)).toBe(true);
      expect(batches.every((batch) => !batch.inTransaction)).toBe(true);
      // The hint for the last trace row carries its seq.
      const lastSeq = Math.max(...reported);
      expect(hints.filter((hint) => hint.seq === lastSeq)).toEqual([{ seq: lastSeq, inTransaction: false }]);
      await runtime.stopSession(sessionId);
    } finally {
      db.close();
    }
  }, 30_000);
});

describe("PipelineRuntime sync passes write as they go (lane 03 PL-2; D-6 review I-1, I-2)", () => {
  /**
   * The smoke script played without its waits. Its records stay 1 s apart, wider than the coordinator's 500 ms batch
   * window, so each step lands in its own unit however the mock's real-time agent_started falls.
   */
  function quickSmokeScript(input: Parameters<typeof smokeMockScript>[0]): ReturnType<typeof smokeMockScript> {
    const script = smokeMockScript(input, { steps: 3, spacingMs: 1_000 });
    return { ...script, entries: script.entries.map((entry) => ({ ...entry, delayMs: 1 })) };
  }

  /** What a session's rows say, keyed by file so two runs of the same script compare. */
  function rowSummary(db: JevcodeDb, sessionId: string): {
    jevDecisions: string[];
    labeledUnits: string[];
    unitSurfaces: string[];
    completionSnapshots: number;
  } {
    const units = db.listChangeUnits(sessionId);
    const fileOf = new Map(units.map((unit) => [unit.id, unit.files.join(",")]));
    const jevDecisions = new Set<string>();
    const unitSurfaces = new Set<string>();
    let completionSnapshots = 0;
    for (const event of db.listEvents(sessionId, { limit: 10_000 })) {
      const payload = JSON.parse(event.payloadJson) as { changeUnitId?: string; pass?: string; surfaceId?: string };
      if (event.type === "jev_decision") jevDecisions.add(`${fileOf.get(payload.changeUnitId ?? "") ?? "?"} ${payload.pass ?? "?"}`);
      if (event.type === "ui_snapshot" && payload.surfaceId === "completion") completionSnapshots += 1;
      else if (event.type === "ui_snapshot") unitSurfaces.add(fileOf.get(payload.changeUnitId ?? "") ?? "?");
    }
    const labeledUnits = units
      .filter((unit) => unit.status !== "superseded")
      .map((unit) => `${unit.files.join(",")} ${unit.category} ${String(unit.importance)} ${String(unit.relevance)}`);
    return {
      jevDecisions: [...jevDecisions].sort(),
      labeledUnits: labeledUnits.sort(),
      unitSurfaces: [...unitSurfaces].sort(),
      completionSnapshots,
    };
  }

  async function runTurnEnd(
    name: string,
    arm: (db: JevcodeDb) => void = () => {},
    inspect: (db: JevcodeDb, collected: Collected, sessionId: string) => void = () => {},
  ): Promise<ReturnType<typeof rowSummary>> {
    const dir = path.join(repoRoot, "apps/desktop/.test-tmp", name);
    rmSync(dir, { recursive: true, force: true });
    const db = createTempDb(dir);
    const sessionId = "sess-pass-rows";
    db.upsertRepository({ id: "repo-pr", path: dir, gitRoot: dir, branch: "test", baseCommit: "test" });
    db.createSession({ id: sessionId, repoId: "repo-pr", prompt: "demo" });
    arm(db);
    const { emit, collected } = collectEmit();
    const runtime = new PipelineRuntime({
      db,
      emit,
      evidence: false,
      jevClient: new DegradeClient(),
      log: () => {},
      mockScriptFor: quickSmokeScript,
    });
    try {
      await runtime.startSession({ sessionId, repoId: "repo-pr", repoPath: dir, prompt: "demo", agentMode: "mock" });
      await waitFor(() => db.getSession(sessionId)?.state === "completed", 15_000, "turn end");
      await waitFor(
        () => db.listEvents(sessionId, { limit: 10_000 }).some((event) => event.type === "ui_snapshot" && event.payloadJson.includes('"surfaceId":"completion"')),
        15_000,
        "completion surface",
      );
      // The pass after the turn end, as the next debounce or answer would run it.
      await runtime.syncAll();
      inspect(db, collected, sessionId);
      return rowSummary(db, sessionId);
    } finally {
      await runtime.stopSession(sessionId);
      db.close();
    }
  }

  it("loses no row when a write throws once in a turn-end pass: the next pass writes what it did not", async () => {
    const clean = await runTurnEnd("pass-rows-clean");
    let thrown = 0;
    const failing = await runTurnEnd("pass-rows-throw", (db) => {
      const upsertUiSnapshot = db.upsertUiSnapshot.bind(db);
      db.upsertUiSnapshot = ((id, snapshot) => {
        if (thrown === 0) {
          thrown += 1;
          throw new Error("disk full");
        }
        return upsertUiSnapshot(id, snapshot);
      }) as typeof db.upsertUiSnapshot;
    });

    expect(thrown).toBe(1);
    // Three steps, three units, each answered in pass A and pass B and shown on its own surface.
    expect(clean.jevDecisions).toHaveLength(6);
    expect(clean.unitSurfaces).toHaveLength(3);
    expect(failing.jevDecisions).toEqual(clean.jevDecisions);
    expect(failing.labeledUnits).toEqual(clean.labeledUnits);
    expect(failing.unitSurfaces).toEqual(clean.unitSurfaces);
    expect(clean.completionSnapshots).toBe(1);
    expect(failing.completionSnapshots).toBe(1);
  }, 60_000);

  it("sends the Jev debug panel the latest decisions once per pass, not once per decision", async () => {
    let debug: unknown[] = [];
    let latest: unknown[] = [];
    const rows = await runTurnEnd("pass-jev-debug", () => {}, (db, collected, sessionId) => {
      debug = collected.channels.get(MainToRendererChannels.jevDebug) ?? [];
      latest = db.latestJevDecisions(sessionId, 50);
    });

    // One pass ran the Jev stage (the pass after it found no changed unit) and wrote six decisions.
    expect(rows.jevDecisions).toHaveLength(6);
    expect(debug).toHaveLength(1);
    expect(debug[0]).toEqual({ sessionId: "sess-pass-rows", decisions: latest });
  }, 60_000);

  it("yields to the event loop during a long pass, so a waiting task runs before the pass ends", async () => {
    const order: string[] = [];
    await runTurnEnd("pass-slices", (db) => {
      // Six Jev decision writes of 8 ms each: a 48 ms stretch without slices.
      const upsertJevDecision = db.upsertJevDecision.bind(db);
      db.upsertJevDecision = ((log) => {
        if (order.length === 0) {
          order.push("first decision");
          setImmediate(() => order.push("waiting task"));
        }
        const until = performance.now() + 8;
        while (performance.now() < until) {
          // a slow write
        }
        return upsertJevDecision(log);
      }) as typeof db.upsertJevDecision;
      const upsertUiSnapshot = db.upsertUiSnapshot.bind(db);
      db.upsertUiSnapshot = ((id, snapshot) => {
        if (snapshot.surfaceId === "completion") order.push("completion");
        return upsertUiSnapshot(id, snapshot);
      }) as typeof db.upsertUiSnapshot;
    });

    expect(order).toEqual(["first decision", "waiting task", "completion"]);
  }, 60_000);

  it("stores each unit's Jev decisions as its answers arrive on a pass that does not end the turn", async () => {
    const dir = path.join(repoRoot, "apps/desktop/.test-tmp/pass-live-rows");
    rmSync(dir, { recursive: true, force: true });
    const db = createTempDb(dir);
    const sessionId = "sess-live-rows";
    db.upsertRepository({ id: "repo-lr", path: dir, gitRoot: dir, branch: "test", baseCommit: "test" });
    db.createSession({ id: sessionId, repoId: "repo-lr", prompt: "demo" });
    // A networked client: each projection answers 20 ms later. At each call, count the first unit's stored rows.
    const calls: Array<{ unitId: string; firstUnitRows: number }> = [];
    class DelayedProjectClient extends DegradeClient {
      override async project(input: ProjectionInput): ReturnType<DegradeClient["project"]> {
        const firstUnitId = calls[0]?.unitId ?? input.changeUnitId;
        calls.push({
          unitId: input.changeUnitId,
          firstUnitRows: db.listJevDecisions(sessionId).filter((log) => log.changeUnitId === firstUnitId).length,
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        return super.project(input);
      }
    }
    const { emit } = collectEmit();
    const runtime = new PipelineRuntime({
      db,
      emit,
      evidence: false,
      jevClient: new DelayedProjectClient(),
      log: () => {},
    });
    // The smoke script without its agent_completed: the session stays running, so no pass ends the turn.
    const script = quickSmokeScript({ sessionId, repoId: "repo-lr", repoPath: dir, prompt: "demo" });
    try {
      await runtime.startSession({
        sessionId,
        repoId: "repo-lr",
        repoPath: dir,
        prompt: "demo",
        agentMode: "mock",
        mockScript: { ...script, entries: script.entries.slice(0, -1) },
      });
      await waitFor(() => db.listEvents(sessionId, { limit: 10_000 }).filter((event) => event.type === "evidence_fact").length === 6, 15_000, "records");
      await runtime.syncAll();

      expect(db.getSession(sessionId)?.state).not.toBe("completed");
      expect(calls).toHaveLength(3);
      const last = calls.at(-1);
      expect(last?.unitId).not.toBe(calls[0]?.unitId);
      // The first unit's pass A and pass B rows were stored before the last unit's call was even made.
      expect(last?.firstUnitRows).toBe(2);
    } finally {
      await runtime.stopSession(sessionId);
      db.close();
    }
  }, 60_000);
});
