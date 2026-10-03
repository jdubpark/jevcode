import { bench, describe } from "vitest";

import type { NarrativeSentence } from "@jevcode/contracts";

import { accumulateAll, createTraceState, finalize } from "../model/fold.js";
import type { TraceSession } from "../model/index.js";
import { componentId, overviewSnapshot } from "../test-support/overview-builder.js";
import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { buildBrief, editedFilesOf } from "./brief.js";
import { componentDetails } from "./map-details.js";
import { buildTraceIndex, type TraceIndex } from "./trace-index.js";

// The Brief (mounted whenever nothing is selected), its edited-files list and the component Inspector rebuild on every
// live commit. Each bench times one builder over a chain of real commits (fold, incremental finalize, incremental index,
// as the Shell does), so every sample is a new session object built after its predecessor's. Benchmark, not a CI gate
// (docs/perf.md, "Brief and component Inspector per commit").
//
// Shape: PL-3's long soak had 2,937 units and 68,321 steps (docs/perf.md). Here a unit is 3 messages, a reasoning
// step, 13 reads, 3 edits and a lint run (21 steps), a test run every 4 units, a re-emit of the previous unit, a
// decision every 25 units (answered 5 units later, with a narrator "why") and highlights every 100; 50 components of 20
// files each, rescanned with purposes halfway. There is no story, so Now is the rule-based one (phases A and B), and no
// step is running or pending at the base, so its scans for a running step and an open decision walk the whole session.

const COMPONENTS = 50;
const FILES_PER_COMPONENT = 20;
const CHAIN = 40;

const root = (k: number): string => `packages/p${k}`;
const fileOf = (n: number): string =>
  `${root(n % COMPONENTS)}/src/f${Math.floor(n / COMPONENTS) % FILES_PER_COMPONENT}.ts`;

function snapshot(described: boolean) {
  return overviewSnapshot({
    components: Array.from({ length: COMPONENTS }, (_, k) => ({
      rootPath: root(k),
      files: Array.from({ length: FILES_PER_COMPONENT }, (_, j) => `${root(k)}/src/f${j}.ts`),
      ...(described ? { purpose: `Package ${k}.`, provenance: "model" as const } : {}),
    })),
    // Each component imports the next two.
    edges: Array.from({ length: COMPONENTS * 2 }, (_, e) => ({
      from: root(e % COMPONENTS),
      to: root(((e % COMPONENTS) + 1 + Math.floor(e / COMPONENTS)) % COMPONENTS),
      count: 1 + (e % 9),
    })),
    narrative: {
      provenance: "model",
      sentences: [
        { text: "A monorepo of packages.", citations: [{ kind: "component", id: componentId(root(0)) }] },
        { text: "The first file of p1.", citations: [{ kind: "file", id: `${root(1)}/src/f0.ts` }] },
      ],
    },
  });
}

const sentence = (text: string): NarrativeSentence => ({ text, citations: [{ kind: "step", id: "step:1" }] });

/** Rows of a long session of `units` units, and the builder to append more. */
function longSession(units: number): TraceBuilder {
  const b = new TraceBuilder();
  b.agent({ type: "agent_started", prompt: "Long session" });
  b.overview(snapshot(false));
  let validation: string | null = null;
  let previous: Parameters<TraceBuilder["unit"]>[0] | null = null;
  for (let i = 0; i < units; i += 1) {
    if (i === Math.floor(units / 2)) b.overview(snapshot(true));
    for (let m = 0; m < 3; m += 1) b.agent({ type: "agent_message", role: "assistant", text: `Unit ${i}, note ${m}.` });
    b.agent({ type: "agent_reasoning", text: "Considering the next edit." });
    for (let r = 0; r < 13; r += 1) {
      const callId = `r${i}_${r}`;
      b.agent({ type: "tool_started", tool: "read_file", input: fileOf(i + r), callId });
      b.agent({ type: "tool_completed", tool: "read_file", output: "x", callId });
    }
    const files: string[] = [];
    const evidence: string[] = [];
    const calls: string[] = [];
    for (let j = 0; j < 3; j += 1) {
      const file = fileOf(3 * i + j);
      const callId = `e${i}_${j}`;
      b.agent({ type: "file_changed", path: file, callId });
      b.fact({ type: "git_hunk", file, added: 1 + j, removed: j, isFormattingOnly: false, isConfigOnly: false, isLockfile: false }, `fact_h${i}_${j}`);
      files.push(file);
      evidence.push(`fact_h${i}_${j}`);
      calls.push(callId);
    }
    b.agent({ type: "command_started", command: "pnpm lint", callId: `l${i}` });
    b.agent({ type: "command_completed", command: "pnpm lint", exitCode: 0, stdout: "", stderr: "", callId: `l${i}` });
    if (i % 4 === 3) {
      const callId = `t${i}`;
      const failed = i % 8 === 3 ? 1 : 0;
      b.agent({ type: "command_started", command: "pnpm test", callId });
      b.agent({ type: "command_completed", command: "pnpm test", exitCode: failed, stdout: "", stderr: "", callId });
      b.fact(
        {
          type: "test_result", runner: "vitest", command: "pnpm test", passed: 40, failed, skipped: 0,
          failures: failed > 0 ? [{ file: files[0] ?? "", testName: "t", message: "m" }] : [], sourceCallId: callId,
        },
        `fact_t${i}`,
      );
      validation = `val_${i}`;
      b.validation({ id: validation, kind: "test", command: "pnpm test", status: failed > 0 ? "failed" : "passed", passed: 40, failed, skipped: 0 });
      evidence.push(`fact_t${i}`);
      calls.push(callId);
    }
    const unit = {
      id: `cu_${i}`, files, evidence, agentCallIds: calls, title: `Changed ${files.length} files`,
      validationResults: validation === null ? [] : [validation],
    };
    b.unit(unit);
    if (previous !== null) b.unit({ ...previous, status: "validated" });
    previous = unit;
    if (i % 25 === 0) b.decision({ id: `d${i}`, status: "open", affectedChangeUnits: [`cu_${i}`] });
    if (i % 25 === 5 && i >= 5) {
      const id = `d${i - 5}`;
      b.decision({ id, status: "answered", affectedChangeUnits: [`cu_${i - 5}`], answer: { decisionId: id, decision: { q: "a" }, evidence: [] } });
      b.explainer({ kind: "decision_why", decisionId: id, sentence: sentence(`Why ${id}.`) });
    }
    if (i % 100 === 99) {
      b.explainer({
        kind: "highlights", basisSeq: b.rows.length,
        components: [{ id: componentId(root(i % COMPONENTS)), state: "changed", unitIds: [`cu_${i}`] }],
      });
    }
  }
  // Answer the last open decision and settle: nothing is pending or running at the base.
  const last = Math.floor((units - 1) / 25) * 25;
  b.decision({ id: `d${last}`, status: "answered", affectedChangeUnits: [`cu_${last}`], answer: { decisionId: `d${last}`, decision: { q: "a" }, evidence: [] } });
  b.agent({ type: "agent_message", role: "assistant", text: "Checking in." });
  return b;
}

interface Commit { session: TraceSession; index: TraceIndex }

interface Chains {
  steps: number;
  /** The component of the last decision's unit's first file: the Inspector lists decisions and edits for it. */
  componentId: string;
  /** Commits that add no rows (a new session object with the same parts). */
  none: Commit[];
  /** Commits that each add one explainer row (highlights or a decision's why). */
  explainer: Commit[];
  /** Commits that each add one message step. */
  step: Commit[];
  /** Commits that add no rows while a command runs: the clock moves its step's duration, so the steps list changes. */
  running: Commit[];
}

function chains(units: number): Chains {
  const b = longSession(units);
  const state = accumulateAll(createTraceState(testMeta({ lastEventSeq: b.rows.length })), b.rows);
  // The source clock an hour past the last row (appended rows add a second each), so a running step grows per commit.
  let nowMs = Date.parse(b.rows.at(-1)?.ts ?? "") + 3_600_000;
  let index: TraceIndex | undefined;
  const commit = (): Commit => {
    nowMs += 250;
    const session = finalize(state, { live: true, nowMs });
    index = buildTraceIndex(session, index);
    return { session, index };
  };
  const append = (add: () => void): Commit => {
    const from = b.rows.length;
    add();
    accumulateAll(state, b.rows.slice(from));
    return commit();
  };
  // The first commit primes the caches (setup) and tinybench's async probe takes the second, untimed.
  const run = (each: (n: number) => Commit): Commit[] => Array.from({ length: CHAIN + 2 }, (_, n) => each(n));
  const none = run(() => commit());
  const lastDecisionUnit = Math.floor((units - 1) / 25) * 25;
  const lastDecision = `d${lastDecisionUnit}`;
  const explainer = run((n) =>
    append(() =>
      n % 2 === 0
        ? b.explainer({
            kind: "highlights", basisSeq: b.rows.length,
            components: [{ id: componentId(root(n % COMPONENTS)), state: "changed", unitIds: [`cu_${lastDecisionUnit}`] }],
          })
        : b.explainer({ kind: "decision_why", decisionId: lastDecision, sentence: sentence(`Why, take ${n}.`) }),
    ),
  );
  const step = run((n) => append(() => b.agent({ type: "agent_message", role: "assistant", text: `Live note ${n}.` })));
  const running = run((n) =>
    n === 0 ? append(() => b.agent({ type: "command_started", command: "pnpm test", callId: "live-run" })) : commit(),
  );
  return {
    steps: none[0]?.session.steps.length ?? 0,
    componentId: componentId(root((3 * lastDecisionUnit) % COMPONENTS)),
    none,
    explainer,
    step,
    running,
  };
}

/** One bench over a commit chain: setup builds the first commit, the async probe the second, each sample the next. */
function chainBench(name: string, chain: readonly Commit[], build: (commit: Commit) => unknown): void {
  let at = 0;
  bench(
    name,
    () => {
      at += 1;
      const commit = chain[at];
      if (commit !== undefined) build(commit);
    },
    {
      iterations: chain.length - 2,
      time: 0,
      warmupIterations: 0,
      warmupTime: 0,
      setup: () => {
        at = 0;
        const first = chain[0];
        if (first !== undefined) build(first);
      },
    },
  );
}

for (const units of [500, 3_000]) {
  const c = chains(units);
  // editedFilesOf: the files no unit holds yet (the Brief beside its changes) and every edited file (before any unit).
  const builders: readonly (readonly [string, (commit: Commit) => unknown])[] = [
    ["buildBrief", ({ session, index }) => buildBrief(session, index)],
    ["componentDetails", ({ session }) => (session.overview === null ? null : componentDetails(session.overview, c.componentId, session))],
    ["editedFilesOf, ungrouped", ({ session }) => editedFilesOf(session.entities, true)],
    ["editedFilesOf, all files", ({ session }) => editedFilesOf(session.entities, false)],
  ];
  const cases: readonly (readonly [string, readonly Commit[]])[] = [
    ["(a) one step added", c.step],
    ["(b) explainer rows only", c.explainer],
    ["(c) no change", c.none],
    ["(d) clock only, a command running", c.running],
  ];
  describe(`Brief and component Inspector per commit, ${units.toLocaleString("en-US")} units / ${c.steps.toLocaleString("en-US")} steps`, () => {
    for (const [name, build] of builders) for (const [label, chain] of cases) chainBench(`${name}, ${label}`, chain, build);
  });
}
