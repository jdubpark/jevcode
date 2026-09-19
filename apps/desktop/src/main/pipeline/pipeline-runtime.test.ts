import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  Decision,
  EvidenceFact,
  NormalizedAgentEvent,
} from "@jevcode/contracts";
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
import { describe, expect, it } from "vitest";

import type { MockScriptEntry } from "./mock-agent-adapter.js";
import { MockAgentAdapter } from "./mock-agent-adapter.js";
import { PlaybackClient, PlaybackLabels, loadPlaybackFixture } from "./playback.js";
import { PipelineRuntime } from "./pipeline-runtime.js";
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
        JSON.stringify(spec).includes("expected 7 to be null"),
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
