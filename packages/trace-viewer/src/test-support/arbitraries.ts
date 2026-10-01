import fc from "fast-check";

import { NOISE_REASONS, SIGNAL_IDS, STEP_KINDS, type Severity, type StepKind, type StepStatus, type TraceSession } from "../model/index.js";
import { buildSession, type FindingSeed, type SessionSeed, type StepSeed } from "./session-builder.js";

export interface ArbSessionOptions { maxSteps?: number; maxChapters?: number; maxTurns?: number; live?: boolean }

const TIMED: readonly StepKind[] = ["command", "test", "check", "tool"];

/** Multi-turn, no-chapter, gap, idle-gap and running sessions. */
export function arbSessionSeed(options: ArbSessionOptions = {}): fc.Arbitrary<SessionSeed> {
  const maxSteps = options.maxSteps ?? 40;
  const maxChapters = options.maxChapters ?? 6;
  const maxTurns = options.maxTurns ?? 3;
  const step = fc.record({
    kind: fc.constantFrom(...STEP_KINDS),
    gapMs: fc.oneof(
      { weight: 8, arbitrary: fc.integer({ min: 0, max: 5_000 }) },
      { weight: 1, arbitrary: fc.integer({ min: 10_001, max: 3_600_000 }) },
    ),
    durationMs: fc.integer({ min: 0, max: 20_000 }),
    outcome: fc.constantFrom("ok", "ok", "ok", "ok", "failed", "unknown"),
    noise: fc.option(fc.constantFrom(...NOISE_REASONS), { freq: 4, nil: null }),
    chapter: fc.integer({ min: -1, max: Math.max(0, maxChapters - 1) }),
    /** A second unit link (a decision or multi-file step), so chapters can share an anchor seq. */
    alsoChapter: fc.option(fc.integer({ min: 0, max: Math.max(0, maxChapters - 1) }), { freq: 5, nil: null }),
    newTurn: fc.integer({ min: 0, max: 9 }).map((n) => n === 0),
    rows: fc.integer({ min: 1, max: 3 }),
    /** The last such step of a turn becomes its success claim (Turn.claimStepId); half of them are contradicted. */
    claim: fc.integer({ min: 0, max: 7 }),
    finding: fc.option(
      fc.record({ ruleId: fc.constantFrom(...SIGNAL_IDS), severity: fc.constantFrom<Severity>("info", "warning", "critical") }),
      { freq: 6, nil: null },
    ),
  });
  return fc
    .record({
      steps: fc.array(step, { minLength: 1, maxLength: maxSteps }),
      chapters: fc.integer({ min: 0, max: maxChapters }),
      gapAt: fc.option(fc.nat(), { nil: null }),
      live: options.live === undefined ? fc.boolean() : fc.constant(options.live),
    })
    .map(({ steps, chapters, gapAt, live }): SessionSeed => {
      let t = 0;
      let turn = 0;
      const seeds: StepSeed[] = [];
      const findings: FindingSeed[] = [];
      const claimOfTurn = new Map<number, number>();
      steps.forEach((s, i) => {
        if (i > 0 && s.newTurn && turn < maxTurns - 1) turn += 1;
        t += s.gapMs;
        const timed = TIMED.includes(s.kind);
        const running = live && timed && i === steps.length - 1;
        const status: StepStatus | undefined = timed ? (running ? "running" : (s.outcome as StepStatus)) : undefined;
        seeds.push({
          kind: s.kind,
          tMs: t,
          durationMs: running ? null : timed ? s.durationMs : 0,
          status,
          turn,
          rows: s.rows,
          chapter: s.chapter >= 0 && s.chapter < chapters ? `u${s.chapter}` : undefined,
          alsoChapters: s.alsoChapter !== null && s.alsoChapter < chapters ? [`u${s.alsoChapter}`] : undefined,
          noise: s.noise,
          target: s.kind === "edit" || s.kind === "read" ? `src/f${i % 13}.ts` : `cmd-${i % 7}`,
          tests: s.kind === "test" ? { passed: 3, failed: s.outcome === "failed" ? 1 : 0, skipped: 0 } : undefined,
          command: status === "unknown" ? { exitCode: -1 } : undefined,
        });
        if (timed && !running) t += s.durationMs;
        if (s.claim < 2) {
          claimOfTurn.set(turn, i);
          if (s.claim === 0 && s.finding === null) findings.push({ ruleId: "claim_contradicted", severity: "critical", step: i });
        }
        if (s.finding !== null) findings.push({ ruleId: s.finding.ruleId, severity: s.finding.severity, step: i });
      });
      return {
        live,
        state: live ? "running" : "completed",
        turns: Array.from({ length: turn + 1 }, (_, k) => {
          const claimStep = claimOfTurn.get(k);
          return { trigger: k === 0 ? "initial" : "steer", prompt: `Turn ${k + 1}`, ...(claimStep === undefined ? {} : { claimStep }) };
        }),
        steps: seeds,
        chapters: Array.from({ length: chapters }, (_, k) => ({ id: `u${k}`, title: `Chapter ${k + 1}` })),
        findings,
        gaps: gapAt === null ? [] : [{ kind: "invalid_row", beforeStep: gapAt % steps.length }],
      };
    });
}

export function arbTraceSession(options: ArbSessionOptions = {}): fc.Arbitrary<TraceSession> {
  return arbSessionSeed(options).map(buildSession);
}
