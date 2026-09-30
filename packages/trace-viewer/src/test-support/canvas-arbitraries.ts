import type { TraceSessionSummary } from "@jevcode/contracts";

import {
  decisionStableId,
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
  };
}
