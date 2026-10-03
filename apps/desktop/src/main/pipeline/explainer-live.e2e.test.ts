import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scanPaths, scanRepo } from "@jevcode/codebase-map/node";
import type {
  Decision,
  EvidenceFact,
  ExplainerRecord,
  NarrativeSentence,
  NormalizedAgentEvent,
  TraceRow,
} from "@jevcode/contracts";
import { isTraceRowType } from "@jevcode/contracts";
import { extractImports } from "@jevcode/evidence-engine";
import { NARRATOR_MODEL } from "@jevcode/jev-router";
import type {
  DecisionWhyInput,
  DescribedComponent,
  NarratorClient,
  NarratorResult,
  SessionStoryInput,
} from "@jevcode/jev-router";
import { parseReplayLine, type PipelineRecord } from "@jevcode/semantic-core";
import { openDb, type JevcodeDb, type StoredEvent } from "@jevcode/storage";
import { foldRows, resolveCitation } from "@jevcode/trace-viewer/model";
import { describe, expect, it } from "vitest";

import { createExplainerStage } from "./explainer-stage.js";
import type { MockScriptEntry } from "./mock-agent-adapter.js";
import { PipelineRuntime } from "./pipeline-runtime.js";
import { PlaybackClient, PlaybackLabels, loadPlaybackFixture } from "./playback.js";

// Spec §13 phase C exit: during a live mock session (the PRD §58 rate-limit demo through the real
// PipelineRuntime and the real explainer stage), story and highlights rows land within one debounce
// window of their triggers, and each answered decision gets a why whose citations resolve in the
// viewer's fold. The story interval is shortened to 1.5 s so the window is measured in real time.

// The stage runs with the injected EchoNarrator. Keep a shell's key and the kill switch from ever reaching a
// real client: no billed calls, no nondeterministic rows during the timing windows.
delete process.env["ANTHROPIC_API_KEY"];
process.env["JEVCODE_NARRATOR"] = "off";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../");
const fixturePath = path.join(repoRoot, "fixtures", "rate-limit");
const STORY_INTERVAL_MS = 1_500;
const SYNC_DEBOUNCE_MS = 600; // pipeline-runtime.ts SYNC_DEBOUNCE_MS
const SLACK_MS = 1_000;
// The runtime's sync debounce is trailing: a record resets it. The script keeps the fixture's own gaps (each
// capped at 1 s), so the session pauses where the recorded agent paused and syncs run as they would live.
const MAX_GAP_MS = 1_000;
const REPO_FILES = [
  "package.json",
  "tsconfig.json",
  "src/config.ts",
  "src/server/index.ts",
  "src/server/app.ts",
  "src/middleware/rate-limiter.ts",
  "src/redis/client.ts",
  "tests/rate-limit.test.ts",
  "tests/redis-unavailable.test.ts",
];

const answer = <T>(value: T): NarratorResult<T> => ({
  value,
  confidence: 1,
  model: NARRATOR_MODEL,
  ms: 5,
  usage: null,
  schemaValid: true,
});

/** A stub model (spec §11: "narrator stubbed") that cites what it was shown, so every citation can resolve. */
class EchoNarrator implements NarratorClient {
  readonly storyAt: number[] = [];
  readonly whyFor: string[] = [];

  describeComponents(): Promise<NarratorResult<DescribedComponent[]>> {
    return Promise.resolve(answer([]));
  }

  overviewNarrative(): Promise<NarratorResult<NarrativeSentence[]>> {
    return Promise.resolve(answer([]));
  }

  sessionStory(input: SessionStoryInput): Promise<NarratorResult<NarrativeSentence[]>> {
    this.storyAt.push(Date.now());
    const step = input.recentSteps.at(-1);
    const component = input.touchedComponents[0];
    const value: NarrativeSentence[] = [];
    if (step !== undefined) value.push({ text: "The agent made progress on the task.", citations: [{ kind: "step", id: step.id }] });
    if (component !== undefined) {
      value.push({ text: "The work touches one part of the codebase.", citations: [{ kind: "component", id: component.id }] });
    }
    return Promise.resolve(answer(value));
  }

  decisionWhy(input: DecisionWhyInput): Promise<NarratorResult<NarrativeSentence | null>> {
    this.whyFor.push(input.decisionId);
    const near = input.nearby[0];
    const citation = near !== undefined ? { kind: "step" as const, id: near.id } : { kind: "decision" as const, id: input.decisionId };
    return Promise.resolve(answer({ text: "The answer follows the agent's note just before it.", citations: [citation] }));
  }
}

function parseStream(): PipelineRecord[] {
  const text = readFileSync(path.join(fixturePath, "events.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => parseReplayLine(line))
    .filter((record): record is PipelineRecord => record !== null);
}

const isAgentEvent = (record: PipelineRecord): record is NormalizedAgentEvent =>
  !("repoId" in record) && !("severity" in record) && !("kind" in record);
const isDecision = (record: PipelineRecord): record is Decision => "severity" in record;

/** The record's own source time, or null (decisions and semantic events carry no comparable stream time). */
function recordTs(record: PipelineRecord): number | null {
  if (isDecision(record) || !("ts" in record) || typeof record.ts !== "string") return null;
  const ts = Date.parse(record.ts);
  return Number.isNaN(ts) ? null : ts;
}

async function waitFor(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function events(db: JevcodeDb, sessionId: string): StoredEvent[] {
  return db.listEvents(sessionId, { limit: 100_000 });
}

function explainerRows(db: JevcodeDb, sessionId: string): { event: StoredEvent; record: ExplainerRecord }[] {
  return events(db, sessionId)
    .filter((event) => event.type === "explainer")
    .map((event) => ({ event, record: JSON.parse(event.payloadJson) as ExplainerRecord }));
}

const ms = (iso: string): number => Date.parse(iso);

describe("explainer stage in a live mock session (phase C exit)", () => {
  it("updates story and highlights within one debounce window and explains the answered decision with resolvable citations", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jevcode-explainer-live-"));
    const repo = path.join(dir, "repo");
    for (const file of REPO_FILES) {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      writeFileSync(path.join(repo, file), file.endsWith(".json") ? "{}\n" : "export {};\n");
    }
    // M-5 lists files with git ls-files (tracked and untracked, .gitignore respected), so the repo needs a git dir.
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const fixture = loadPlaybackFixture(fixturePath);
    const labels = new PlaybackLabels(fixture.labels, fixture.expectedUnits);
    const records = parseStream();
    const firstAgent = records.find(isAgentEvent) as Extract<NormalizedAgentEvent, { type: "agent_started" }> | undefined;
    const sessionId = firstAgent?.sessionId ?? "sess-live";
    const repoId = (records.find((record): record is EvidenceFact => "repoId" in record) as EvidenceFact | undefined)?.repoId ?? "repo-live";
    const prompt = firstAgent?.prompt ?? "";
    const openIndex = records.findIndex((record) => isDecision(record) && record.status === "open");
    const answeredIndex = records.findIndex((record) => isDecision(record) && record.status === "answered");
    expect(openIndex).toBeGreaterThan(-1);
    expect(answeredIndex).toBeGreaterThan(openIndex);

    const db = openDb({ dbPath: path.join(dir, "live.db") });
    db.upsertRepository({ id: repoId, path: repo, gitRoot: repo, branch: "demo", baseCommit: "demo" });
    db.createSession({ id: sessionId, repoId, prompt });

    const hints: number[] = [];
    const narrator = new EchoNarrator();
    const stage = createExplainerStage({
      db,
      repoRoot: repo,
      sessionId: () => sessionId,
      initialNarrator: narrator,
      scan: scanRepo,
      scanPaths,
      extract: extractImports,
      emitRowsAvailable: (_sessionId, seq) => void hints.push(seq),
      now: () => Date.now(),
      schedule: {
        setTimeout: (fn, delay) => setTimeout(fn, delay),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      log: () => undefined,
      storyIntervalMs: STORY_INTERVAL_MS,
    });
    // Each hook call's time and its first unit count, to tell the runtime's debounce from the stage's latency.
    const syncs: { at: number; units: number }[] = [];
    let runtime: PipelineRuntime | null = null;

    try {
      stage.onRepoOpened();
      await stage.whenIdle();
      stage.onSessionStarted(sessionId);
      await waitFor(() => events(db, sessionId).some((event) => event.type === "overview_snapshot"), 15_000, "overview snapshot row");

      runtime = new PipelineRuntime({
        db,
        emit: () => undefined,
        evidence: false,
        jevClient: new PlaybackClient(labels),
        interruptAgentOnDecision: true,
        log: () => undefined,
        onPipelineSync: (_repoPath, sync) => {
          syncs.push({ at: Date.now(), units: sync.changeUnits.length });
          stage.onPipelineSync(sync);
        },
      });
      let previousTs: number | null = null;
      const entry = (record: PipelineRecord): MockScriptEntry => {
        const ts = recordTs(record);
        const gap = ts !== null && previousTs !== null ? Math.min(Math.max(0, ts - previousTs), MAX_GAP_MS) : 0;
        if (ts !== null) previousTs = ts;
        if (isAgentEvent(record)) return { kind: "agent", event: record, delayMs: gap };
        return { kind: "record", record, delayMs: isDecision(record) ? 800 : gap };
      };
      const preDecision = records.slice(0, openIndex + 1).map(entry);
      previousTs = null;
      const continuation = records.slice(answeredIndex + 1).map(entry);
      await runtime.startSession({
        sessionId,
        repoId,
        repoPath: repo,
        prompt,
        agentMode: "mock",
        mockThreadId: "th-explainer-live",
        playbackLabels: labels,
        mockScript: {
          sessionId,
          repoPath: repo,
          cwd: repo,
          prompt,
          entries: preDecision,
          autoResumeOnDecision: true,
          onDecision: () => continuation,
        },
      });

      await waitFor(() => db.listDecisions(sessionId).some((decision) => decision.status === "open"), 30_000, "open decision");
      const open = db.listDecisions(sessionId).find((decision) => decision.status === "open");
      await runtime.answerDecision(sessionId, { decisionId: open?.id ?? "", decision: { redis_failure_policy: "fail_open" }, evidence: [] });
      await waitFor(
        () =>
          events(db, sessionId).some(
            (event) => event.type === "agent_event" && (JSON.parse(event.payloadJson) as NormalizedAgentEvent).type === "agent_completed",
          ),
        45_000,
        "agent_completed",
      );
      await runtime.syncAll();
      await waitFor(() => explainerRows(db, sessionId).some((row) => row.record.kind === "decision_why"), 15_000, "decision_why row");

      const all = events(db, sessionId);
      const firstStoryAfter = (seq: number) =>
        explainerRows(db, sessionId).find((row) => row.record.kind === "story" && row.record.basisSeq >= seq);

      // Story within one debounce window of the answer and of completion.
      const answered = all.find((event) => event.type === "decision" && (JSON.parse(event.payloadJson) as Decision).status === "answered");
      const completed = all.find(
        (event) => event.type === "agent_event" && (JSON.parse(event.payloadJson) as NormalizedAgentEvent).type === "agent_completed",
      );
      const storyGaps: number[] = [];
      for (const trigger of [answered, completed]) {
        expect(trigger).toBeDefined();
        await waitFor(() => firstStoryAfter(trigger?.seq ?? 0) !== undefined, 15_000, "story after trigger");
        const story = firstStoryAfter(trigger?.seq ?? 0);
        storyGaps.push(ms(story?.event.ts ?? "") - ms(trigger?.ts ?? ""));
      }
      const explainer = explainerRows(db, sessionId);

      // Highlights within one sync of the first change unit.
      const firstUnit = all.find((event) => event.type === "change_unit");
      const firstHighlights = explainer.find((row) => row.record.kind === "highlights");
      expect(firstUnit).toBeDefined();
      expect(firstHighlights).toBeDefined();
      const highlightsGap = ms(firstHighlights?.event.ts ?? "") - ms(firstUnit?.ts ?? "");
      const firstUnitSync = syncs.find((sync) => sync.units > 0);
      const storyCallGaps = narrator.storyAt.slice(1).map((at, i) => at - (narrator.storyAt[i] ?? 0));
      console.log(
        `EXPLAINER_LIVE story_after_answer_ms=${storyGaps[0]} story_after_completion_ms=${storyGaps[1]} ` +
          `highlights_after_first_unit_ms=${highlightsGap} highlights_after_its_sync_ms=${ms(firstHighlights?.event.ts ?? "") - (firstUnitSync?.at ?? 0)} ` +
          `story_calls=${narrator.storyAt.length} min_story_call_gap_ms=${storyCallGaps.length > 0 ? Math.min(...storyCallGaps) : "none"} ` +
          `explainer_rows=${explainer.length} syncs=${syncs.length}`,
      );
      for (const gap of storyGaps) expect(gap).toBeLessThanOrEqual(STORY_INTERVAL_MS + SYNC_DEBOUNCE_MS + SLACK_MS);
      expect(highlightsGap).toBeLessThanOrEqual(SYNC_DEBOUNCE_MS + SLACK_MS);

      // At most one story call per interval.
      for (const gap of storyCallGaps) expect(gap).toBeGreaterThanOrEqual(STORY_INTERVAL_MS - 2);

      // Every explainer row pushed a hint, and every citation resolves in the viewer's fold.
      for (const row of explainer) expect(hints).toContain(row.event.seq);
      const record = db.getSession(sessionId);
      const rows: TraceRow[] = events(db, sessionId)
        .filter((event) => isTraceRowType(event.type))
        .map((event) => ({ seq: event.seq, type: event.type, ts: event.ts, payload: JSON.parse(event.payloadJson) as unknown }));
      const session = foldRows(
        {
          sessionId,
          repoId,
          repoName: "",
          prompt,
          state: record?.state ?? "completed",
          startedAt: record?.startedAt ?? "",
          endedAt: record?.endedAt ?? null,
          lastEventSeq: record?.lastEventSeq ?? 0,
        },
        rows,
        { live: false },
      );
      const answeredIds = db
        .listDecisions(sessionId)
        .filter((decision) => decision.status === "answered" || decision.status === "delegated")
        .map((decision) => decision.id);
      expect(answeredIds).toEqual([open?.id]);
      for (const decisionId of answeredIds) {
        const why = session.explainer.decisionWhy.get(decisionId);
        expect(why).toBeDefined();
        expect(why?.citations.length).toBeGreaterThan(0);
        for (const citation of why?.citations ?? []) expect(resolveCitation(session, citation).kind).not.toBe("none");
      }
      expect(session.explainer.stories.length).toBeGreaterThan(0);
      for (const story of session.explainer.stories) {
        expect(story.provenance).toBe("model");
        for (const sentence of story.sentences) {
          for (const citation of sentence.citations) expect(resolveCitation(session, citation).kind).not.toBe("none");
        }
      }
      expect(narrator.whyFor).toEqual([open?.id]);
    } finally {
      if (runtime !== null) await runtime.stopSession(sessionId);
      stage.dispose();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
