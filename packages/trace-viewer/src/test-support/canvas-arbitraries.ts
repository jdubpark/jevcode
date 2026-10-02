import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  TRACE_BUNDLE_FORMAT,
  TRACE_BUNDLE_VERSION,
  type ChangeUnit,
  type TraceBundle,
  type TraceRow,
  type TraceSessionSummary,
} from "@jevcode/contracts";
import fc from "fast-check";

import { loadFixtureTrace } from "./fixture-rows.js";

import { RESUME_DEFAULT_PROMPT } from "../layout/canvas-layout.js";
import { buildTimeScale, timeScaleInputOf, type TimeScale } from "../layout/time-scale.js";
import {
  decisionStableId,
  foldRows,
  type UnitStableId,
  findingStableId,
  stepStableId,
  unitStableId,
  type Chapter,
  type Finding,
  type Lane,
  type Severity,
  type SignalId,
  type Step,
  type StepKind,
  type TraceSession,
  type Turn,
  type TurnTrigger,
} from "../model/index.js";

// Test-only builders for canvas layout and view tests. Sessions follow the W0 model
// contract: seqs 1..n in time order, step:<firstSeq> ids, lists sorted by seq.

/** 2026-09-18T09:00:00.000Z, the oauth fixture's first agent row. */
export const CANVAS_ORIGIN_MS = Date.parse("2026-09-18T09:00:00.000Z");

/** Local copy of the B-2 lane table (UI index §1.4). */
const LANE_OF = {
  instruction: "supervisor",
  approval: "supervisor",
  decision: "supervisor",
  message: "agent",
  reasoning: "agent",
  tool: "agent",
  lifecycle: "agent",
  command: "commands",
  edit: "edits",
  read: "edits",
  dependency: "edits",
  revert: "edits",
  test: "tests",
  check: "tests",
  guardrail: "jev",
  attention: "jev",
} as const satisfies Record<StepKind, Lane>;

export type CanvasSeedKind = "prompt" | "plan" | "claim" | "decision" | "chapter" | "noise" | "loose" | "work";

export interface CanvasSeed {
  /** Display-clock time of the step (ms since CANVAS_ORIGIN_MS). */
  atMs: number;
  kind: CanvasSeedKind;
  /** Step duration: edits 500 ms, tests and commands 4 s, others 0 when omitted. */
  durationMs?: number;
  /** chapter/noise: a warning failing_tests finding on its step. claim: a critical claim_contradicted citing the latest loose step. */
  flagged?: boolean;
  title?: string;
  /** prompt only; turn 0 is always "initial". */
  trigger?: TurnTrigger;
  prompt?: string;
  /** chapter/noise: the chapter lists the latest decision. */
  decides?: boolean;
  /** chapter: validationStepIds holds the latest loose step. */
  validates?: boolean;
  category?: Chapter["category"];
}

export interface CanvasSessionOptions {
  sessionId?: string;
  live?: boolean;
}

function iso(t: number): string {
  return new Date(CANVAS_ORIGIN_MS + t).toISOString();
}

export function canvasMeta(
  sessionId = "sess-canvas",
  state: TraceSessionSummary["state"] = "completed",
): TraceSessionSummary {
  return {
    sessionId,
    repoId: "repo-canvas",
    repoName: "repo-canvas",
    prompt: "Build the feature",
    state,
    startedAt: iso(0),
    endedAt: null,
    lastEventSeq: 0,
  };
}

export function buildCanvasSession(
  seeds: readonly CanvasSeed[],
  options: CanvasSessionOptions = {},
): TraceSession {
  const sorted = [...seeds].sort((a, b) => a.atMs - b.atMs);
  if (sorted[0]?.kind !== "prompt") sorted.unshift({ atMs: 0, kind: "prompt" });
  const steps: Step[] = [];
  const turns: Turn[] = [];
  const chapters: Chapter[] = [];
  const findings: Finding[] = [];
  let lastDecision: Step | undefined;
  let lastLoose: Step | undefined;

  const addStep = (kind: StepKind, t: number, durationMs: number, extra: Partial<Step> = {}): Step => {
    const seq = steps.length + 1;
    const turn = turns.at(-1);
    const step: Step = {
      id: stepStableId(seq),
      kind,
      lane: LANE_OF[kind],
      actor: kind === "instruction" || kind === "decision" ? "supervisor" : kind === "edit" ? "repo" : "agent",
      provenance: "observed",
      status: "ok",
      headline: `${kind} ${seq}`,
      turnIndex: turn?.index ?? 0,
      seqs: [seq],
      firstSeq: seq,
      lastSeq: seq,
      startTs: iso(t),
      endTs: iso(t + durationMs),
      tMs: t,
      endTMs: t + durationMs,
      durationMs,
      approxTime: false,
      startMs: CANVAS_ORIGIN_MS + t,
      evidenceSeqs: [],
      chapterIds: [],
      entityIds: [],
      findingIds: [],
      problems: [],
      noise: null,
      ...extra,
    };
    steps.push(step);
    if (turn !== undefined) {
      turn.stepIds.push(step.id);
      turn.endSeq = seq;
      turn.endTs = step.endTs ?? step.startTs;
      turn.endTMs = Math.max(turn.endTMs, t + durationMs);
    }
    return step;
  };

  const addFinding = (ruleId: SignalId, severity: Severity, step: Step, extra: Partial<Finding> = {}): Finding => {
    const finding: Finding = {
      id: findingStableId(ruleId, 1, step.firstSeq),
      ruleId,
      ruleVersion: 1,
      severity,
      anchorSeq: step.firstSeq,
      headline: ruleId,
      reason: ruleId,
      stepIds: [step.id],
      chapterIds: [],
      evidenceSeqs: [],
      anchorStepId: step.id,
      ...extra,
    };
    findings.push(finding);
    step.findingIds.push(finding.id);
    return finding;
  };

  for (const seed of sorted) {
    const t = seed.atMs;
    switch (seed.kind) {
      case "prompt": {
        const index = turns.length;
        const trigger: TurnTrigger = index === 0 ? "initial" : (seed.trigger ?? "steer");
        const prompt = seed.prompt ?? `Prompt ${index + 1}`;
        const seq = steps.length + 1;
        turns.push({
          index,
          trigger,
          prompt,
          outcome: "completed",
          startSeq: seq,
          endSeq: seq,
          startTs: iso(t),
          endTs: iso(t),
          tMs: t,
          endTMs: t,
          stepIds: [],
        });
        addStep("instruction", t, 0, { text: prompt, headline: prompt });
        break;
      }
      case "plan": {
        const step = addStep("message", t, 0, { text: "Plan: build it, then test it.", headline: "Plan" });
        const turn = turns.at(-1);
        if (turn !== undefined && turn.planStepId === undefined) turn.planStepId = step.id;
        break;
      }
      case "claim": {
        const text = seed.title ?? "All tests pass.";
        const step = addStep("message", t, 0, { text, headline: "Final claim" });
        const turn = turns.at(-1);
        if (turn !== undefined) turn.claimStepId = step.id;
        if (seed.flagged === true && lastLoose !== undefined) {
          addFinding("claim_contradicted", "critical", step, {
            claimStepId: step.id,
            evidenceStepIds: [lastLoose.id],
            evidenceSeqs: [lastLoose.firstSeq],
            claimSpan: [0, text.length],
          });
          step.problems = ["claim_contradicted"];
        }
        break;
      }
      case "decision": {
        const decisionId = `dec-${steps.length + 1}`;
        lastDecision = addStep("decision", t, seed.durationMs ?? 0, {
          target: decisionId,
          headline: seed.title ?? "Decision",
          decision: {
            decisionId,
            title: seed.title ?? "Decision",
            severity: "required",
            status: "answered",
            options: [
              { id: "a", label: "Option A", chosen: true },
              { id: "b", label: "Option B", chosen: false },
            ],
            decidedBy: "supervisor",
          },
        });
        break;
      }
      case "chapter":
      case "noise": {
        const path = `src/file-${steps.length + 1}.ts`;
        const durationMs = seed.durationMs ?? 500;
        const step = addStep("edit", t, durationMs, {
          target: path,
          headline: path,
          edit: {
            path,
            change: "modified",
            added: 12,
            removed: 3,
            claimed: false,
            observed: true,
            diff: "none",
            lockfile: seed.kind === "noise",
            formattingOnly: false,
          },
        });
        const id = unitStableId(`c${step.firstSeq}`);
        const chapter: Chapter = {
          id,
          changeUnitId: `c${step.firstSeq}`,
          title: seed.title ?? `Chapter ${step.firstSeq}`,
          category: seed.category ?? "implementation",
          status: "detected",
          files: [path],
          link: "observed",
          evidenceLinks: { cited: 1, resolved: 1, approx: 0 },
          firstSeq: step.firstSeq,
          lastSeq: step.lastSeq,
          versions: 1,
          startTs: step.startTs,
          endTs: step.endTs ?? step.startTs,
          tMs: t,
          endTMs: t + durationMs,
          stepIds: [step.id],
          factSeqs: [step.firstSeq],
          decisionIds:
            seed.decides === true && lastDecision?.target !== undefined ? [decisionStableId(lastDecision.target)] : [],
          validationIds: [],
          clampIds: [],
          triad: {},
          schemaChanges: [],
          dependencyChanges: [],
          findingIds: [],
          noise: seed.kind === "noise",
          current: true,
          validationStepIds: seed.validates === true && lastLoose !== undefined ? [lastLoose.id] : [],
        };
        step.chapterIds.push(id);
        if (seed.flagged === true) {
          const finding = addFinding("failing_tests", "warning", step, { chapterIds: [id] });
          chapter.findingIds.push(finding.id);
        }
        chapters.push(chapter);
        break;
      }
      case "loose": {
        lastLoose = addStep("test", t, seed.durationMs ?? 4_000, {
          target: "pnpm test",
          headline: "pnpm test",
          status: "failed",
          problems: ["tests_failed"],
          command: { command: "pnpm test", exitCode: 1 },
          tests: { passed: 14, failed: 1, skipped: 0, failures: [] },
        });
        addFinding("failing_tests", "warning", lastLoose);
        break;
      }
      case "work": {
        addStep("command", t, seed.durationMs ?? 4_000, {
          target: "pnpm build",
          headline: "pnpm build",
          command: { command: "pnpm build", exitCode: 0 },
        });
        break;
      }
    }
  }

  const last = steps.at(-1);
  const endT = steps.reduce((max, step) => Math.max(max, step.endTMs ?? step.tMs), 0);
  findings.sort((a, b) => a.anchorSeq - b.anchorSeq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    schemaVersion: 1,
    meta: {
      ...canvasMeta(options.sessionId, options.live === true ? "running" : "completed"),
      lastEventSeq: last?.lastSeq ?? 0,
    },
    live: options.live === true,
    loadedThroughSeq: last?.lastSeq ?? 0,
    originMs: CANVAS_ORIGIN_MS,
    span: { startTs: iso(0), endTs: iso(endT), durationMs: endT },
    turns,
    steps,
    chapters,
    entities: [],
    findings,
    gaps: [],
    coverage: { capabilities: [], signals: [], approximateJoins: false, inferredSteps: 0 },
    hidden: { byType: {}, unreceived: 0 },
    overview: null,
  };
}

// ------------------------------------------------------------ scale

export function canvasScale(session: TraceSession, liveTMs?: number): TimeScale {
  return buildTimeScale(timeScaleInputOf(session, liveTMs));
}

// ------------------------------------------------------------ arbitraries (P1–P10)

interface RawSeed {
  dtMs: number;
  kind: CanvasSeedKind;
  durationMs: number;
  flagged: boolean;
  decides: boolean;
  validates: boolean;
  trigger: TurnTrigger;
  resumeDefault: boolean;
}

const rawSeed: fc.Arbitrary<RawSeed> = fc.record({
  dtMs: fc.oneof(
    { weight: 6, arbitrary: fc.integer({ min: 0, max: 20_000 }) },
    { weight: 1, arbitrary: fc.integer({ min: 60_000, max: 1_200_000 }) },
  ),
  kind: fc.constantFrom<CanvasSeedKind>(
    "prompt",
    "plan",
    "claim",
    "decision",
    "chapter",
    "chapter",
    "chapter",
    "noise",
    "loose",
    "work",
  ),
  durationMs: fc.oneof(
    fc.constant(0),
    fc.integer({ min: 100, max: 5_000 }),
    fc.integer({ min: 60_000, max: 400_000 }),
  ),
  flagged: fc.boolean(),
  decides: fc.boolean(),
  validates: fc.boolean(),
  trigger: fc.constantFrom<TurnTrigger>("steer", "resume"),
  resumeDefault: fc.boolean(),
});

/** Turns, story items, chapters, noise, loose findings, decisions, validations, idle gaps and long commands. */
export function arbCanvasSession(options: { maxSeeds?: number } = {}): fc.Arbitrary<TraceSession> {
  return fc.array(rawSeed, { minLength: 1, maxLength: options.maxSeeds ?? 40 }).map((raw) => {
    let t = 0;
    const seeds: CanvasSeed[] = raw.map((seed, index) => {
      t += index === 0 ? 0 : seed.dtMs;
      const prompt =
        seed.kind === "prompt" && seed.trigger === "resume" && seed.resumeDefault ? RESUME_DEFAULT_PROMPT : undefined;
      return {
        atMs: t,
        kind: seed.kind,
        durationMs: seed.durationMs,
        flagged: seed.flagged,
        decides: seed.decides,
        validates: seed.validates,
        trigger: seed.trigger,
        ...(prompt === undefined ? {} : { prompt }),
        ...(seed.validates ? { category: "tests" as const } : {}),
      };
    });
    return buildCanvasSession(seeds);
  });
}

/** The items with start < beforeMs, unchanged (P5: "no key mutated after T"). */
export function canvasPrefix(session: TraceSession, beforeMs: number): TraceSession {
  const steps = session.steps.filter((step) => step.tMs < beforeMs);
  const kept = new Set<string>(steps.map((step) => step.id));
  const turns = session.turns
    .filter((turn) => turn.tMs < beforeMs)
    .map((turn) => {
      const next: Turn = { ...turn, stepIds: turn.stepIds.filter((id) => kept.has(id)) };
      if (next.planStepId !== undefined && !kept.has(next.planStepId)) delete next.planStepId;
      if (next.claimStepId !== undefined && !kept.has(next.claimStepId)) delete next.claimStepId;
      return next;
    });
  const last = steps.at(-1);
  return {
    ...session,
    meta: { ...session.meta, lastEventSeq: last?.lastSeq ?? 0 },
    loadedThroughSeq: last?.lastSeq ?? 0,
    turns,
    steps,
    chapters: session.chapters.filter((chapter) => chapter.tMs < beforeMs),
    findings: session.findings.filter((finding) => kept.has(finding.anchorStepId)),
  };
}

export interface CanvasMutation {
  op: "churn" | "merge" | "flip" | "late" | "append";
  pick: number;
}

export const arbCanvasMutation: fc.Arbitrary<CanvasMutation> = fc.record({
  op: fc.constantFrom<CanvasMutation["op"]>("churn", "merge", "flip", "late", "append"),
  pick: fc.nat({ max: 1_000 }),
});

function chapterAnchor(chapter: Chapter, session: TraceSession): number {
  const stepSeqs = chapter.stepIds.map((id) => session.steps.find((step) => step.id === id)?.firstSeq ?? Infinity);
  return Math.min(...chapter.factSeqs, ...stepSeqs);
}

function replaceChapterId(session: TraceSession, from: UnitStableId, to: UnitStableId): void {
  const swap = (ids: UnitStableId[]): UnitStableId[] => [...new Set(ids.map((id) => (id === from ? to : id)))];
  for (const step of session.steps) step.chapterIds = swap(step.chapterIds);
  for (const finding of session.findings) finding.chapterIds = swap(finding.chapterIds);
}

function applyMutation(session: TraceSession, { op, pick }: CanvasMutation): void {
  const chapters = session.chapters;
  switch (op) {
    case "churn": {
      const chapter = chapters[pick % Math.max(1, chapters.length)];
      if (chapter === undefined) return;
      const id: UnitStableId = `${chapter.id}~r`;
      replaceChapterId(session, chapter.id, id);
      chapter.id = id;
      chapter.changeUnitId = id.slice("unit:".length);
      return;
    }
    case "merge": {
      if (chapters.length < 2) return;
      const i = pick % chapters.length;
      const a = chapters[i];
      const b = chapters[(i + 1) % chapters.length];
      if (a === undefined || b === undefined) return;
      a.stepIds = [...new Set([...a.stepIds, ...b.stepIds])].sort(
        (x, y) => Number(x.slice("step:".length)) - Number(y.slice("step:".length)),
      );
      a.factSeqs = [...new Set([...a.factSeqs, ...b.factSeqs])].sort((x, y) => x - y);
      a.findingIds = [...new Set([...a.findingIds, ...b.findingIds])];
      a.tMs = Math.min(a.tMs, b.tMs);
      a.endTMs = Math.max(a.endTMs, b.endTMs);
      a.noise = a.noise && b.noise;
      replaceChapterId(session, b.id, a.id);
      session.chapters = chapters.filter((chapter) => chapter !== b);
      return;
    }
    case "flip": {
      const clean = chapters.filter(
        (chapter) =>
          chapter.findingIds.length === 0 &&
          chapter.stepIds.every((id) => (session.steps.find((step) => step.id === id)?.findingIds.length ?? 0) === 0),
      );
      const chapter = clean[pick % Math.max(1, clean.length)];
      if (chapter !== undefined) chapter.noise = !chapter.noise;
      return;
    }
    case "late": {
      const pool = session.steps.filter(
        (step) => step.kind === "edit" || step.kind === "test" || step.kind === "command",
      );
      const step = pool[pick % Math.max(1, pool.length)];
      if (step === undefined) return;
      const id: UnitStableId = `unit:late${step.firstSeq}`;
      if (chapters.some((chapter) => chapter.id === id)) return;
      const source = chapters[0];
      const base: Chapter =
        source === undefined
          ? (buildCanvasSession([{ atMs: 0, kind: "chapter" }]).chapters[0] as Chapter)
          : source;
      chapters.push({
        ...base,
        id,
        changeUnitId: id.slice("unit:".length),
        title: `Late ${step.firstSeq}`,
        firstSeq: step.firstSeq,
        lastSeq: step.lastSeq,
        tMs: step.tMs,
        endTMs: step.endTMs ?? step.tMs,
        stepIds: [step.id],
        factSeqs: [step.firstSeq],
        decisionIds: [],
        validationStepIds: [],
        findingIds: [],
        noise: false,
        current: true,
      });
      step.chapterIds.push(id);
      chapters.sort((x, y) => chapterAnchor(x, session) - chapterAnchor(y, session));
      return;
    }
    case "append": {
      const last = session.steps.at(-1);
      const turn = session.turns.at(-1);
      if (last === undefined || turn === undefined) return;
      const endT = session.steps.reduce((max, step) => Math.max(max, step.endTMs ?? step.tMs), 0);
      const extra = buildCanvasSession([
        { atMs: 0, kind: "prompt" },
        { atMs: endT + 1_000 * (1 + (pick % 90)), kind: "chapter" },
      ]);
      const edit = extra.steps[1];
      const chapter = extra.chapters[0];
      if (edit === undefined || chapter === undefined) return;
      const seq = last.lastSeq + 1;
      const stepId = stepStableId(seq);
      const unitId = unitStableId(`a${seq}`);
      session.steps.push({
        ...edit,
        id: stepId,
        seqs: [seq],
        firstSeq: seq,
        lastSeq: seq,
        turnIndex: turn.index,
        chapterIds: [unitId],
      });
      session.chapters.push({
        ...chapter,
        id: unitId,
        changeUnitId: `a${seq}`,
        firstSeq: seq,
        lastSeq: seq,
        stepIds: [stepId],
        factSeqs: [seq],
      });
      turn.stepIds.push(stepId);
      turn.endSeq = seq;
      session.loadedThroughSeq = seq;
      session.meta = { ...session.meta, lastEventSeq: seq };
      return;
    }
  }
}

/** Id churn, merges, kind flips, late arrivals and appends (P6). Never mutates its input. */
export function mutateCanvasSession(session: TraceSession, ops: readonly CanvasMutation[]): TraceSession {
  const next = structuredClone(session);
  for (const op of ops) applyMutation(next, op);
  return next;
}

// ------------------------------------------------------------ oauth (spec §7.5 table)

interface ExpectedUnit {
  id: string;
  title: string;
  category: ChangeUnit["category"];
  files: string[];
}

// path + fileURLToPath, not new URL(relative, import.meta.url): under jsdom that resolves against http://localhost:3000.
const EXPECTED_UNITS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/oauth/expected_units.json",
);

type Payload = Record<string, unknown>;

function payloadOf(row: TraceRow): Payload {
  return typeof row.payload === "object" && row.payload !== null ? (row.payload as Payload) : {};
}

function isFileFact(path: string): (row: TraceRow, payload: Payload) => boolean {
  return (row, payload) => row.type === "evidence_fact" && payload.type === "file_changed" && payload.path === path;
}

/** Each unit's creation time, located by content in fixtures/oauth/events.jsonl (never by line number). */
const UNIT_START: Record<string, (row: TraceRow, payload: Payload) => boolean> = {
  "oauth-dependency": (row, payload) =>
    row.type === "agent_event" && payload.type === "command_started" && payload.command === "pnpm add google-auth-library",
  "oauth-identity-layer": isFileFact("src/auth/identity.ts"),
  "oauth-migration": isFileFact("migrations/001_create_identities.sql"),
  "oauth-lockfile-noise": isFileFact("pnpm-lock.yaml"),
  "oauth-format-noise": isFileFact("src/db/users.ts"),
  "oauth-account-linking-decision": (row, payload) =>
    row.type === "agent_event" && payload.type === "agent_message" && payload.role === "user",
  "oauth-linking-test-failure": isFileFact("tests/auth/oauth.test.ts"),
};

/** The mockup (canvas-1440.png) draws Identity layer → Account linking; the decision-born unit lists its decision. */
const RELATED_DECISIONS: Record<string, string[]> = {
  "oauth-identity-layer": ["dec-oauth-0001"],
  "oauth-account-linking-decision": ["dec-oauth-0001"],
};

function unitEvidence(unit: ExpectedUnit, rows: readonly TraceRow[]): string[] {
  const files = new Set(unit.files);
  const ids: string[] = [];
  for (const row of rows) {
    if (row.type !== "evidence_fact" || row.factId === undefined) continue;
    const payload = payloadOf(row);
    const path = payload.path ?? payload.file ?? payload.manifest;
    const touches = typeof path === "string" && files.has(path);
    const testRun = unit.category === "tests" && payload.type === "test_result";
    if (touches || testRun) ids.push(row.factId);
  }
  return ids;
}

function expectedUnits(): ExpectedUnit[] {
  const parsed: unknown = JSON.parse(readFileSync(EXPECTED_UNITS_PATH, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("expected_units.json is not an array");
  return parsed as ExpectedUnit[];
}

/**
 * oauth rows with the clusterer's change_unit rows replaced by units built from
 * fixtures/oauth/expected_units.json, so clusterer drift cannot move the §7.5 table.
 * Default: units are appended after every record row (they arrive late, as in replay).
 * unitsInline: each unit row sits right after the row it was created at, and seqs are renumbered 1..N.
 */
export function oauthCanvasRows(options: { unitsInline?: boolean } = {}): {
  meta: TraceSessionSummary;
  rows: TraceRow[];
} {
  const fixture = loadFixtureTrace("oauth");
  const records = fixture.rows.filter((row) => row.type !== "change_unit");
  const units: TraceRow[] = [];
  const after = new Map<number, TraceRow[]>();
  let seq = records.reduce((max, row) => Math.max(max, row.seq), 0);
  for (const expected of expectedUnits()) {
    const locate = UNIT_START[expected.id];
    const origin = locate === undefined ? undefined : records.find((row) => locate(row, payloadOf(row)));
    const createdAt = origin === undefined ? undefined : payloadOf(origin).ts;
    if (origin === undefined || typeof createdAt !== "string") {
      throw new Error(`oauth unit ${expected.id} has no start row`);
    }
    const unit: ChangeUnit = {
      id: expected.id,
      sessionId: fixture.meta.sessionId,
      title: expected.title,
      category: expected.category,
      status: "detected",
      files: [...expected.files],
      symbols: [],
      interfacesChanged: [],
      schemaChanges: [],
      dependencyChanges: [],
      relatedDecisions: RELATED_DECISIONS[expected.id] ?? [],
      validationResults: [],
      evidence: unitEvidence(expected, records),
      createdAt,
      updatedAt: createdAt,
    };
    seq += 1;
    const row: TraceRow = { seq, type: "change_unit", ts: createdAt, payload: unit };
    units.push(row);
    const list = after.get(origin.seq) ?? [];
    list.push(row);
    after.set(origin.seq, list);
  }
  if (options.unitsInline !== true) return { meta: fixture.meta, rows: [...records, ...units] };
  const ordered: TraceRow[] = [];
  for (const row of records) {
    ordered.push(row);
    for (const unit of after.get(row.seq) ?? []) ordered.push(unit);
  }
  return { meta: fixture.meta, rows: ordered.map((row, index) => ({ ...row, seq: index + 1 })) };
}

/** Folds the first `count` rows; running until the last row arrives. */
export function foldCanvasPrefix(meta: TraceSessionSummary, rows: readonly TraceRow[], count: number): TraceSession {
  const slice = rows.slice(0, count);
  const done = count >= rows.length;
  return foldRows({ ...meta, state: done ? meta.state : "running" }, slice, {
    live: !done,
    state: done ? meta.state : "running",
    throughSeq: slice.at(-1)?.seq ?? 0,
  });
}

export function oauthCanvasSession(): TraceSession {
  const { meta, rows } = oauthCanvasRows();
  return foldRows(meta, rows, { live: false });
}

/**
 * The replay shape of oauth (lane review I-1..I-4): fixtures/oauth folded through the real pipeline with the
 * clusterer's own units, as the dev host's replayed bundle is. Every unit cites the one `pnpm test` validation, so
 * that run (step:43) joins all seven chapters and is validation-only in the six that do not own its failure, and two
 * chapters (Lockfile, Code · users) are noise. oauthCanvasSession() pins the §7.5 table instead and has no shared run.
 * It lacks the replay's jev_decision rows (guardrail and attention steps); tests that need those add them.
 */
export function oauthReplaySession(): TraceSession {
  const { meta, rows } = loadFixtureTrace("oauth");
  return foldRows(meta, rows, { live: false });
}

export function oauthCanvasBundle(): TraceBundle {
  const { meta, rows } = oauthCanvasRows({ unitsInline: true });
  return {
    format: TRACE_BUNDLE_FORMAT,
    version: TRACE_BUNDLE_VERSION,
    exportedAt: meta.startedAt,
    redactionCount: 0,
    session: { ...meta, lastEventSeq: rows.at(-1)?.seq ?? 0 },
    rows,
  };
}

/** Spec §10 reference input: 60 chapters and 5,000 steps over three turns, with two idle breaks. */
export function syntheticCanvasSession(options: { chapters?: number; steps?: number; turns?: number } = {}): TraceSession {
  const chapters = options.chapters ?? 60;
  const steps = options.steps ?? 5_000;
  const turns = options.turns ?? 3;
  const seeds: CanvasSeed[] = [];
  const every = Math.max(1, Math.floor(steps / chapters));
  const turnEvery = Math.max(1, Math.floor(steps / turns));
  let placedChapters = 0;
  let t = 0;
  for (let i = 0; i < steps; i += 1) {
    t += i % 1_700 === 1_699 ? 180_000 : 400;
    if (i > 0 && i % turnEvery === 0) seeds.push({ atMs: t, kind: "prompt", trigger: "steer" });
    else if (i % every === 0 && placedChapters < chapters) {
      placedChapters += 1;
      seeds.push({ atMs: t, kind: "chapter", flagged: i % (every * 7) === 0, decides: i % (every * 5) === 0 });
    } else if (i % 97 === 0) seeds.push({ atMs: t, kind: "loose" });
    else if (i % 131 === 0) seeds.push({ atMs: t, kind: "decision" });
    else seeds.push({ atMs: t, kind: "work", durationMs: 300 });
  }
  return buildCanvasSession(seeds);
}
