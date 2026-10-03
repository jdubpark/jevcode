import type { AgentState, ChangeCategory, ChangeUnitStatus, OverviewSnapshot } from "@jevcode/contracts";

import type { BandSpan, LaneMarks, OverviewIndex } from "../layout/overview-index.js";
import {
  buildOverviewModel, CAPABILITIES, decisionStableId, fileStableId, findingStableId, LANES, SIGNAL_IDS, stepStableId, TRACE_SCHEMA_VERSION, unitStableId,
  type Actor, type Chapter, type ClaimObservation, type CommandDetail, type DecisionDetail, type EditDetail, type Entity,
  type Finding, type Gap, type GapKind, type GuardrailDetail, type Lane, type NoiseReason, type ProblemKind, type Severity,
  type SignalId, type Step, type StepKind, type StepStatus, type TestDetail, type TraceSession, type Turn, type TurnOutcome,
  type TurnTrigger,
} from "../model/index.js";

/** Local copy of UI index §1.4 B-2 (KIND_META[kind].lane), so W1 tests do not need lane B. */
export const LANE_OF_KIND: { readonly [K in StepKind]: Lane } = {
  instruction: "supervisor", approval: "supervisor", decision: "supervisor",
  message: "agent", reasoning: "agent", tool: "agent", lifecycle: "agent",
  command: "commands",
  edit: "edits", read: "edits", dependency: "edits", revert: "edits",
  test: "tests", check: "tests",
  guardrail: "jev", attention: "jev",
};

const ACTOR_OF_KIND: { readonly [K in StepKind]: Actor } = {
  instruction: "supervisor", approval: "supervisor", decision: "supervisor",
  message: "agent", reasoning: "agent", tool: "agent", lifecycle: "agent", command: "agent", test: "agent",
  check: "agent", edit: "agent", read: "agent", dependency: "repo", revert: "repo", guardrail: "jevcode", attention: "jevcode",
};

const TIMED: ReadonlySet<StepKind> = new Set<StepKind>(["command", "test", "check", "tool"]);
const EDIT_LIKE: ReadonlySet<StepKind> = new Set<StepKind>(["edit", "dependency", "revert"]);

export const DEFAULT_ORIGIN_MS = Date.parse("2026-09-18T09:00:00.000Z");

export interface StepSeed {
  kind: StepKind;
  tMs: number;
  /** Default: 1,000 for command, test, check and tool; 0 otherwise; null = running. */
  durationMs?: number | null;
  status?: StepStatus;
  headline?: string;
  target?: string;
  text?: string;
  turn?: number;
  /** Seqs this step folds (default 1). */
  rows?: number;
  /** Change unit id without the "unit:" prefix. */
  chapter?: string;
  /** Further units this step links to, as lane B links a decision or a multi-file step to several units. */
  alsoChapters?: string[];
  noise?: NoiseReason | null;
  problems?: ProblemKind[];
  command?: Partial<CommandDetail>;
  tests?: Partial<TestDetail>;
  edit?: Partial<EditDetail>;
  decision?: Partial<DecisionDetail>;
  guardrail?: Partial<GuardrailDetail>;
  callId?: string;
}
export interface ChapterSeed { id: string; title: string; category?: ChangeCategory; status?: ChangeUnitStatus; noise?: boolean; current?: boolean; factSeqs?: number[] }
export interface FindingSeed {
  ruleId: SignalId; severity: Severity; step: number; evidence?: number[]; claimSpan?: [number, number]; headline?: string;
  /** Which of the step's seqs anchors the finding (default 0, its firstSeq). Lane B anchors failing_tests and
   *  recovery_arc on the test_result seq inside the test step. */
  anchorRow?: number;
}
export interface TurnSeed { trigger: TurnTrigger; prompt: string; outcome?: TurnOutcome; planStep?: number; claimStep?: number }
export interface GapSeed { kind: GapKind; beforeStep: number; message?: string }
export interface SessionSeed {
  sessionId?: string;
  repoName?: string;
  prompt?: string;
  originMs?: number;
  state?: AgentState;
  live?: boolean;
  turns?: TurnSeed[];
  steps: StepSeed[];
  chapters?: ChapterSeed[];
  findings?: FindingSeed[];
  gaps?: GapSeed[];
  approximateJoins?: boolean;
  /** Seqs the source filtered out after the last step (Hidden.unreceived). */
  trailingHiddenRows?: number;
  /** An overview_snapshot to fold into session.overview (seq = loadedThroughSeq). */
  overview?: OverviewSnapshot;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const bySeqThenId = <T extends { id: string }>(seqOf: (item: T) => number) =>
  (a: T, b: T): number => seqOf(a) - seqOf(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function defaultStatus(seed: StepSeed, durationMs: number | null): StepStatus {
  if (seed.status !== undefined) return seed.status;
  if (TIMED.has(seed.kind)) return durationMs === null ? "running" : "ok";
  if (EDIT_LIKE.has(seed.kind) || seed.kind === "decision") return "ok";
  return "info";
}

function defaultProblems(seed: StepSeed, status: StepStatus): ProblemKind[] {
  if (seed.problems !== undefined) return [...seed.problems];
  if (status !== "failed") return [];
  if (seed.kind === "test" || seed.kind === "check") return (seed.tests?.failed ?? 0) > 0 ? ["tests_failed"] : ["exit_nonzero"];
  if (seed.kind === "command" || seed.kind === "tool") return ["exit_nonzero"];
  return [];
}

function exitCodeFor(status: StepStatus): number | null {
  if (status === "running") return null;
  if (status === "failed") return 1;
  if (status === "unknown") return -1;
  return 0;
}

const PROBLEM_OF_RULE: Partial<Record<SignalId, ProblemKind>> = {
  claim_contradicted: "claim_contradicted",
  destructive_command: "destructive",
};

export function buildSession(seed: SessionSeed): TraceSession {
  const origin = seed.originMs ?? DEFAULT_ORIGIN_MS;
  const state: AgentState = seed.state ?? "completed";
  const live = seed.live ?? (state === "starting" || state === "running" || state === "waiting_decision");
  const turnSeeds: TurnSeed[] = seed.turns ?? [{ trigger: "initial", prompt: seed.prompt ?? "Build the feature." }];
  const gaps: Gap[] = [];
  const steps: Step[] = [];
  let seq = 0;
  let prevT = 0;

  seed.steps.forEach((s, index) => {
    for (const g of seed.gaps ?? []) {
      if (g.beforeStep !== index) continue;
      seq += 1;
      gaps.push({ kind: g.kind, atSeq: seq, message: g.message ?? `${g.kind} at seq ${seq}` });
    }
    const rows = Math.max(1, s.rows ?? 1);
    const firstSeq = seq + 1;
    seq += rows;
    const tMs = Math.max(prevT, s.tMs, 0);
    prevT = tMs;
    const durationMs = s.durationMs !== undefined ? s.durationMs : TIMED.has(s.kind) ? 1_000 : 0;
    const status = defaultStatus(s, durationMs);
    const step: Step = {
      id: stepStableId(firstSeq),
      kind: s.kind,
      lane: LANE_OF_KIND[s.kind],
      actor: ACTOR_OF_KIND[s.kind],
      provenance: "observed",
      status,
      headline: s.headline ?? s.target ?? s.text ?? s.kind,
      turnIndex: s.turn ?? 0,
      seqs: Array.from({ length: rows }, (_, r) => firstSeq + r),
      firstSeq,
      lastSeq: seq,
      startTs: iso(origin + tMs),
      endTs: durationMs === null ? null : iso(origin + tMs + durationMs),
      startMs: origin + tMs,
      tMs,
      endTMs: durationMs === null ? null : tMs + durationMs,
      durationMs,
      approxTime: false,
      evidenceSeqs: [],
      chapterIds: [...new Set([...(s.chapter === undefined ? [] : [s.chapter]), ...(s.alsoChapters ?? [])])].map(unitStableId),
      entityIds: [],
      findingIds: [],
      problems: defaultProblems(s, status),
      noise: s.noise ?? null,
    };
    if (s.target !== undefined) step.target = s.target;
    if (s.text !== undefined) step.text = s.text;
    if (s.callId !== undefined) step.callId = s.callId;
    if (s.kind === "command" || s.kind === "test" || s.kind === "check") {
      step.command = { command: s.target ?? step.headline, exitCode: exitCodeFor(status), ...s.command };
    }
    if (s.kind === "test" || s.tests !== undefined) {
      step.tests = { passed: 0, failed: 0, skipped: 0, failures: [], ...s.tests };
    }
    if (EDIT_LIKE.has(s.kind) && s.target !== undefined) {
      step.edit = {
        path: s.target, added: 0, removed: 0, claimed: true, observed: true, diff: "text", lockfile: false, formattingOnly: false,
        ...s.edit,
      };
      step.entityIds = [fileStableId(step.edit.path)];
    }
    if (s.kind === "decision") {
      step.decision = {
        decisionId: `dec-${firstSeq}`, title: step.headline, severity: "required", status: "answered", options: [],
        decidedBy: "supervisor", ...s.decision,
      };
      step.target ??= step.decision.decisionId;
    }
    if (s.kind === "guardrail") {
      step.guardrail = { clampIds: [], clientKind: "typesafe", confidence: 1, ...s.guardrail };
    }
    steps.push(step);
  });

  const findings: Finding[] = [];
  for (const f of seed.findings ?? []) {
    const anchor = steps[f.step];
    if (anchor === undefined) continue;
    const anchorSeq = anchor.seqs[Math.max(0, Math.min(anchor.seqs.length - 1, f.anchorRow ?? 0))] ?? anchor.firstSeq;
    const id = findingStableId(f.ruleId, 1, anchorSeq);
    if (findings.some((x) => x.id === id)) continue;
    const evidence = (f.evidence ?? []).map((i) => steps[i]).filter((s): s is Step => s !== undefined);
    const finding: Finding = {
      id, ruleId: f.ruleId, ruleVersion: 1, severity: f.severity, anchorSeq,
      headline: f.headline ?? f.ruleId, reason: "", stepIds: [anchor.id, ...evidence.map((e) => e.id)],
      chapterIds: [...anchor.chapterIds], evidenceSeqs: evidence.map((e) => e.firstSeq), anchorStepId: anchor.id,
    };
    if (f.ruleId === "claim_contradicted") {
      finding.claimStepId = anchor.id;
      finding.evidenceStepIds = evidence.map((e) => e.id);
      if (f.claimSpan !== undefined) finding.claimSpan = f.claimSpan;
      const observedStep = evidence[0];
      if (observedStep !== undefined) {
        const claim: ClaimObservation = {
          claim: { text: anchor.text ?? "", seq: anchor.firstSeq, tMs: anchor.tMs, stepId: anchor.id },
          observed: {
            command: observedStep.command?.command ?? observedStep.target ?? "",
            passed: observedStep.tests?.passed ?? 0, failed: observedStep.tests?.failed ?? 0, skipped: observedStep.tests?.skipped ?? 0,
            seq: observedStep.firstSeq, tMs: observedStep.tMs, stepId: observedStep.id,
          },
        };
        finding.claim = claim;
      }
    }
    anchor.findingIds.push(id);
    // As the fold does since ruling M3: only a critical (blocking) clamp is the guardrail problem.
    const problem = PROBLEM_OF_RULE[f.ruleId] ?? (f.ruleId === "guardrail_clamp" && f.severity === "critical" ? "guardrail" : undefined);
    if (problem !== undefined && !anchor.problems.includes(problem)) anchor.problems.push(problem);
    findings.push(finding);
  }
  for (const step of steps) if (step.problems.length > 0 || step.findingIds.length > 0) step.noise = null;
  findings.sort(bySeqThenId((f) => f.anchorSeq));

  const lastSeq = seq;
  const loadedThroughSeq = lastSeq + (seed.trailingHiddenRows ?? 0);
  const endMs = steps.reduce((max, s) => Math.max(max, s.endTMs ?? s.tMs), 0);

  const turns: Turn[] = turnSeeds.map((t, index) => {
    const own = steps.filter((s) => s.turnIndex === index);
    const first = own[0];
    const lastStep = own.at(-1);
    const turn: Turn = {
      index,
      trigger: t.trigger,
      prompt: t.prompt,
      outcome: t.outcome ?? (live && index === turnSeeds.length - 1 ? "running" : "completed"),
      startSeq: first?.firstSeq ?? Math.max(1, lastSeq),
      endSeq: lastStep?.lastSeq ?? Math.max(1, lastSeq),
      startTs: iso(origin + (first?.tMs ?? endMs)),
      endTs: iso(origin + own.reduce((m, s) => Math.max(m, s.endTMs ?? s.tMs), first?.tMs ?? endMs)),
      tMs: first?.tMs ?? endMs,
      endTMs: own.reduce((m, s) => Math.max(m, s.endTMs ?? s.tMs), first?.tMs ?? endMs),
      stepIds: own.map((s) => s.id),
    };
    const plan = t.planStep === undefined ? undefined : steps[t.planStep];
    const claim = t.claimStep === undefined ? undefined : steps[t.claimStep];
    if (plan !== undefined) turn.planStepId = plan.id;
    if (claim !== undefined) turn.claimStepId = claim.id;
    return turn;
  });

  const chapters: Chapter[] = (seed.chapters ?? []).map((c) => {
    const id = unitStableId(c.id);
    const own = steps.filter((s) => s.chapterIds.includes(id));
    const firstSeq = own[0]?.firstSeq ?? c.factSeqs?.[0] ?? 1;
    const tMs = own[0]?.tMs ?? 0;
    const endTMs = own.reduce((m, s) => Math.max(m, s.endTMs ?? s.tMs), tMs);
    const status = c.status ?? "validated";
    return {
      id, changeUnitId: c.id, title: c.title, category: c.category ?? "implementation", status,
      files: [...new Set(own.flatMap((s) => (s.edit === undefined ? [] : [s.edit.path])))],
      link: seed.approximateJoins === true ? "inferred" : "observed",
      evidenceLinks: { cited: 0, resolved: 0, approx: 0 },
      firstSeq, lastSeq: own.reduce((m, s) => Math.max(m, s.lastSeq), firstSeq), versions: 1,
      startTs: iso(origin + tMs), endTs: iso(origin + endTMs), tMs, endTMs,
      stepIds: own.map((s) => s.id), factSeqs: [...(c.factSeqs ?? [])],
      decisionIds: own.flatMap((s) => (s.decision === undefined ? [] : [decisionStableId(s.decision.decisionId)])),
      validationIds: [], clampIds: [], triad: {}, schemaChanges: [], dependencyChanges: [],
      findingIds: findings.filter((f) => f.chapterIds.includes(id)).map((f) => f.id),
      noise: c.noise ?? false, current: c.current ?? status !== "superseded",
      validationStepIds: own.filter((s) => s.kind === "test" || s.kind === "check").map((s) => s.id),
    };
  });
  chapters.sort(bySeqThenId((c) => c.firstSeq));

  const entityMap = new Map<string, Entity>();
  for (const step of steps) {
    if (step.edit === undefined) continue;
    const entityId = fileStableId(step.edit.path);
    const entity = entityMap.get(entityId) ?? {
      id: entityId, kind: "file", path: step.edit.path, label: step.edit.path, added: 0, removed: 0,
      claimed: false, observed: false, stepIds: [], chapterIds: [],
    };
    entity.added += step.edit.added;
    entity.removed += step.edit.removed;
    entity.claimed ||= step.edit.claimed;
    entity.observed ||= step.edit.observed;
    entity.stepIds.push(step.id);
    for (const chapterId of step.chapterIds) if (!entity.chapterIds.includes(chapterId)) entity.chapterIds.push(chapterId);
    entityMap.set(entityId, entity);
  }

  const terminal = state === "completed" || state === "failed";
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    meta: {
      sessionId: seed.sessionId ?? "sess-test-0001", repoId: "repo-test", repoName: seed.repoName ?? "acme-app",
      prompt: turnSeeds[0]?.prompt ?? "", state, startedAt: iso(origin), endedAt: terminal ? iso(origin + endMs) : null,
      lastEventSeq: loadedThroughSeq,
    },
    live,
    loadedThroughSeq,
    originMs: origin,
    span: { startTs: iso(origin), endTs: iso(origin + endMs), durationMs: endMs },
    turns,
    steps,
    chapters,
    entities: [...entityMap.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    findings,
    gaps,
    coverage: {
      capabilities: [...CAPABILITIES],
      signals: SIGNAL_IDS.map((id) => ({ id, active: true, missing: [] })),
      approximateJoins: seed.approximateJoins ?? false,
      inferredSteps: 0,
    },
    hidden: { byType: {}, unreceived: seed.trailingHiddenRows ?? 0 },
    overview: seed.overview === undefined ? null : buildOverviewModel(seed.overview, Math.max(1, loadedThroughSeq)),
  };
}

export function claimSpanOf(text: string, phrase: string): [number, number] {
  const start = text.indexOf(phrase);
  if (start < 0) throw new Error(`"${phrase}" not in "${text}"`);
  return [start, start + phrase.length];
}

export const OAUTH_PROMPT = "Add Google OAuth login while preserving existing email/password accounts.";
export const OAUTH_CLAIM_TEXT = "OAuth implementation complete; all checks pass.";

/** Mirrors fixtures/oauth/events.jsonl by content (times from its ts fields, origin 09:00:00.000). */
export function oauthLikeSession(): TraceSession {
  const steps: StepSeed[] = [
    { kind: "instruction", tMs: 0, text: OAUTH_PROMPT, headline: "Add Google OAuth login" },
    { kind: "message", tMs: 2_100, text: "I will inspect the current auth code, database types, and server routes before making changes." },
    { kind: "read", tMs: 3_400, target: "src/auth/service.ts", rows: 3, noise: "read" },
    { kind: "read", tMs: 5_200, target: "src/db/users.ts", noise: "read" },
    { kind: "read", tMs: 6_300, target: "src/server/index.ts", noise: "read" },
    { kind: "message", tMs: 8_000, text: "Plan: introduce an Identity layer, add a Google OAuth provider, and link accounts explicitly." },
    { kind: "command", tMs: 10_000, durationMs: 4_500, target: "pnpm add google-auth-library", rows: 3, chapter: "u-google" },
    { kind: "dependency", tMs: 14_700, target: "package.json", chapter: "u-google", edit: { added: 1, removed: 0 } },
    { kind: "edit", tMs: 15_000, target: "src/auth/identity.ts", rows: 3, chapter: "u-identity", edit: { added: 42, removed: 0, change: "added" } },
    { kind: "edit", tMs: 16_000, target: "src/auth/google.ts", rows: 3, chapter: "u-google", edit: { added: 58, removed: 0, change: "added" } },
    { kind: "edit", tMs: 17_000, target: "migrations/001_create_identities.sql", rows: 2, chapter: "u-migration", edit: { added: 12, removed: 0, change: "added" } },
    { kind: "edit", tMs: 18_000, target: "src/auth/service.ts", rows: 3, chapter: "u-identity", edit: { added: 17, removed: 3 } },
    { kind: "edit", tMs: 19_000, target: "src/server/index.ts", rows: 3, chapter: "u-google", edit: { added: 9, removed: 1 } },
    { kind: "edit", tMs: 20_000, target: "package.json", rows: 2, chapter: "u-google", edit: { added: 1, removed: 0 } },
    { kind: "edit", tMs: 21_000, target: "pnpm-lock.yaml", rows: 2, chapter: "u-lock", noise: "lockfile", edit: { added: 120, removed: 4, lockfile: true } },
    { kind: "edit", tMs: 22_000, target: "src/db/users.ts", rows: 2, chapter: "u-format", noise: "formatting", edit: { added: 6, removed: 6, formattingOnly: true } },
    { kind: "message", tMs: 24_000, text: "Identity layer and Google provider are in place. The callback needs a linking policy decision." },
    { kind: "lifecycle", tMs: 25_000, headline: "Waiting", noise: "lifecycle" },
    {
      kind: "decision", tMs: 26_000, durationMs: 4_000, rows: 3, headline: "Account-linking policy for Google sign-in",
      decision: {
        decisionId: "dec-oauth-0001", title: "Account-linking policy for Google sign-in", status: "answered", decidedBy: "supervisor",
        options: [
          { id: "explicit_link", label: "Explicit link", chosen: true },
          { id: "auto_link_by_email", label: "Auto-link by email", chosen: false },
          { id: "reject", label: "Reject", chosen: false },
        ],
      },
    },
    { kind: "message", tMs: 31_000, text: "Applying the explicit linking policy to the callback flow." },
    { kind: "edit", tMs: 32_000, target: "src/auth/google.ts", rows: 2, chapter: "u-linking-policy", edit: { added: 14, removed: 2 } },
    { kind: "edit", tMs: 33_000, target: "tests/auth/oauth.test.ts", rows: 2, chapter: "u-linking-test", edit: { added: 31, removed: 0, change: "added" } },
    {
      kind: "test", tMs: 35_000, durationMs: 5_000, rows: 5, status: "failed", target: "pnpm test", chapter: "u-linking-test",
      headline: "pnpm test · 14/15",
      tests: { passed: 14, failed: 1, skipped: 0, runner: "vitest", failures: [{ file: "tests/auth/oauth.test.ts", testName: "links an existing account", message: "expected null to be 7" }] },
      command: { exitCode: 1 },
    },
    { kind: "message", tMs: 43_000, text: OAUTH_CLAIM_TEXT },
    { kind: "lifecycle", tMs: 45_000, headline: "Turn ended", noise: "lifecycle" },
  ];
  return buildSession({
    sessionId: "sess-oauth-0001",
    repoName: "acme-auth",
    originMs: DEFAULT_ORIGIN_MS,
    state: "completed",
    turns: [{ trigger: "initial", prompt: OAUTH_PROMPT, outcome: "completed", planStep: 5, claimStep: 23 }],
    steps,
    chapters: [
      { id: "u-identity", title: "Identity layer", category: "architecture" },
      { id: "u-google", title: "Google provider", category: "api" },
      { id: "u-migration", title: "Identities migration", category: "schema" },
      { id: "u-lock", title: "Lockfile update", category: "dependency", noise: true },
      { id: "u-format", title: "Users formatting", category: "implementation", noise: true },
      { id: "u-linking-policy", title: "Linking policy", category: "behavior" },
      { id: "u-linking-test", title: "Linking test", category: "tests", status: "failed" },
    ],
    findings: [
      { ruleId: "failing_tests", severity: "critical", step: 22, headline: "Tests failed" },
      { ruleId: "claim_contradicted", severity: "critical", step: 23, evidence: [22], claimSpan: claimSpanOf(OAUTH_CLAIM_TEXT, "all checks pass"), headline: "Claim contradicts tests" },
    ],
  });
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const LARGE_KINDS: readonly StepKind[] = ["command", "edit", "edit", "message", "read", "test", "tool", "reasoning"];

/** Deterministic 60-chapter / 5k-step session for layout properties and benches (spec §10 reference input). */
export function largeSession(options: { chapters?: number; steps?: number; seed?: number } = {}): TraceSession {
  const chapterCount = options.chapters ?? 60;
  const stepCount = options.steps ?? 5_000;
  const rand = mulberry32(options.seed ?? 1);
  const steps: StepSeed[] = [];
  const findings: FindingSeed[] = [];
  let t = 0;
  for (let i = 0; i < stepCount; i += 1) {
    t += rand() < 0.01 ? 90_000 + Math.floor(rand() * 600_000) : Math.floor(rand() * 2_500);
    const kind = i === 0 ? "instruction" : (LARGE_KINDS[Math.floor(rand() * LARGE_KINDS.length)] ?? "command");
    const failed = (kind === "test" || kind === "command") && rand() < 0.03;
    const chapter = `c${Math.min(chapterCount - 1, Math.floor((i / stepCount) * chapterCount))}`;
    steps.push({
      kind, tMs: t, target: kind === "edit" || kind === "read" ? `src/m${i % 97}.ts` : `cmd ${i % 31}`,
      durationMs: kind === "command" || kind === "test" || kind === "tool" ? 200 + Math.floor(rand() * 8_000) : 0,
      status: failed ? "failed" : undefined, chapter: kind === "read" ? undefined : chapter,
      noise: kind === "read" ? "read" : null,
      tests: kind === "test" ? { passed: 10, failed: failed ? 1 : 0, skipped: 0 } : undefined,
      edit: kind === "edit" ? { added: Math.floor(rand() * 40), removed: Math.floor(rand() * 10) } : undefined,
    });
    if (failed && kind === "test") findings.push({ ruleId: "failing_tests", severity: rand() < 0.3 ? "critical" : "warning", step: i });
  }
  return buildSession({
    sessionId: "sess-large",
    steps,
    chapters: Array.from({ length: chapterCount }, (_, c) => ({ id: `c${c}`, title: `Chapter ${c + 1}` })),
    findings,
  });
}

/** An OverviewIndex with bands only (no marks, pins, turns or links), sorted as buildOverviewIndex sorts them. */
export function bandsOverview(bands: readonly BandSpan[], endU: number): OverviewIndex {
  const empty: LaneMarks = {
    count: 0, u0: new Float64Array(0), u1: new Float64Array(0), step: new Int32Array(0), glyph: new Uint8Array(0), tone: new Uint8Array(0),
    added: new Float64Array(0), removed: new Float64Array(0), problem: new Uint8Array(0), noise: new Uint8Array(0), maxSpan: 0,
  };
  const lanes = Object.fromEntries(LANES.map((lane) => [lane, empty])) as OverviewIndex["lanes"];
  const sorted = [...bands].sort((a, b) => a.u0 - b.u0 || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { endU, lanes, pins: [], bands: sorted, turns: [], links: [] };
}
