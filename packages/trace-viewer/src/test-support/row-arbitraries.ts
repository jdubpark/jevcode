// Test-only: random trace rows for fold properties. Excluded from the build (tsconfig.build.json).
// Small id pools make rows collide the way real sessions do: units cite facts, call ids, validations
// and decisions before or after those rows arrive, several steps share a call id, units are re-emitted
// with changed joins, statuses and files, and one validation can be cited by every unit (the soak
// shape). A few rows are invalid, out of order or of an unknown type.
import fc from "fast-check";

import type { TraceRow, TraceSessionSummary } from "@jevcode/contracts";

import { overviewSnapshot } from "./overview-builder.js";
import { TraceBuilder, testMeta } from "./trace-builder.js";

const FILES = ["src/a.ts", "src/b.ts", "tests/a.test.ts", "pnpm-lock.yaml"] as const;
const COMMANDS = ["pnpm test", "pnpm lint", "bash -lc 'pnpm test'", "rm -rf dist"] as const;
const CALL_IDS = ["c1", "c2", "c3", "c4", "c5"] as const;
const FACT_IDS = ["fact_1", "fact_2", "fact_3", "fact_4", "fact_5", "fact_6"] as const;
const VALIDATION_IDS = ["val_1", "val_2", "val_3"] as const;
const UNIT_IDS = ["u1", "u2", "u3", "u4"] as const;
const DECISION_IDS = ["d1", "d2"] as const;
const TEXTS = ["Plan:\n- read\n- fix", "All tests pass.", "Working on it", "Fix the bug", "done", "Plan the fix"] as const;
const HASHES = ["0123456789abcdef", "fedcba9876543210"] as const;
const CLAMPS = [[], ["schema_floor"], ["suppress_formatting"], ["destructive_command", "suppress_lockfile"]] as const;
const STATUSES = ["detected", "in_progress", "validated", "failed", "superseded"] as const;

const pick = <T>(values: readonly T[]) => fc.constantFrom(...values);
const optional = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined, freq: 2 });
const subset = <T>(values: readonly T[]) => fc.subarray([...values]);

type Op = (b: TraceBuilder) => void;

function at(seconds: number): string {
  return TraceBuilder.at(seconds);
}

const agentOp: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ prompt: pick(TEXTS) }).map(({ prompt }): Op => (b) => b.agent({ type: "agent_started", prompt })),
  fc
    .record({ role: pick(["assistant", "user"] as const), text: pick(TEXTS) })
    .map(({ role, text }): Op => (b) => b.agent({ type: "agent_message", role, text })),
  fc.constant<Op>((b) => b.agent({ type: "agent_reasoning", text: "thinking" })),
  fc
    .record({ tool: pick(["read_file", "shell"] as const), callId: optional(pick(CALL_IDS)), done: fc.boolean() })
    .map(({ tool, callId, done }): Op => (b) => {
      b.agent({ type: "tool_started", tool, input: "x", ...(callId !== undefined ? { callId } : {}) });
      if (done) b.agent({ type: "tool_completed", tool, output: "y", ...(callId !== undefined ? { callId } : {}) });
    }),
  fc
    .record({ command: pick(COMMANDS), callId: optional(pick(CALL_IDS)), exitCode: pick([0, 1, -1]), close: pick(["no", "yes", "orphan"] as const) })
    .map(({ command, callId, exitCode, close }): Op => (b) => {
      const id = callId !== undefined ? { callId } : {};
      if (close !== "orphan") b.agent({ type: "command_started", command, ...id });
      if (close !== "no") b.agent({ type: "command_completed", command, exitCode, stdout: "ok\n", stderr: "", ...id });
    }),
  fc
    .record({ command: pick(COMMANDS), exitCode: pick([0, 1]), done: fc.boolean() })
    .map(({ command, exitCode, done }): Op => (b) => {
      b.agent({ type: "test_started", command });
      if (done) b.agent({ type: "test_completed", command, exitCode });
    }),
  pick(FILES).map((path): Op => (b) => b.agent({ type: "file_read", path })),
  fc
    .record({ path: pick(FILES), callId: optional(pick(CALL_IDS)) })
    .map(({ path, callId }): Op => (b) => b.agent({ type: "file_changed", path, ...(callId !== undefined ? { callId } : {}) })),
  pick(COMMANDS).map((command): Op => (b) => b.agent({ type: "approval_requested", command, rationale: "r" })),
  pick(["agent_waiting", "agent_completed", "agent_failed", "agent_interrupted"] as const).map((type): Op => (b) => {
    if (type === "agent_failed") b.agent({ type, error: "boom" });
    else if (type === "agent_interrupted") b.agent({ type, reason: "steer" });
    else b.agent({ type });
  }),
);

const factOp: fc.Arbitrary<Op> = fc.oneof(
  fc
    .record({
      file: pick(FILES),
      added: fc.nat(9),
      formatting: fc.boolean(),
      hash: optional(pick(HASHES)),
      // Every diff state a hunk can carry (review m3): text, truncated text, withheld as a secret path, not captured.
      shape: pick(["text", "truncated", "secret_path", "not_captured"] as const),
      factId: optional(pick(FACT_IDS)),
    })
    .map(({ file, added, formatting, hash, shape, factId }): Op => (b) =>
      b.fact(
        {
          type: "git_hunk",
          file,
          added,
          removed: 1,
          isFormattingOnly: formatting,
          isConfigOnly: false,
          isLockfile: file === "pnpm-lock.yaml",
          ...(hash !== undefined
            ? {
                diff:
                  shape === "text" || shape === "truncated"
                    ? { hash, bytes: 10, text: "@@", truncated: shape === "truncated", redactions: 0 }
                    : { hash, bytes: 10, truncated: false, redactions: 0, withheld: shape },
              }
            : {}),
        },
        factId,
      ),
    ),
  fc
    .record({ path: pick(FILES), factId: optional(pick(FACT_IDS)) })
    .map(({ path, factId }): Op => (b) => b.fact({ type: "file_changed", path, kind: "modified" }, factId)),
  fc
    .record({ command: pick(COMMANDS), exitCode: pick([0, 1]), callId: optional(pick(CALL_IDS)), factId: optional(pick(FACT_IDS)) })
    .map(({ command, exitCode, callId, factId }): Op => (b) =>
      b.fact(
        { type: "command_executed", command, exitCode, isDestructive: false, ...(callId !== undefined ? { sourceCallId: callId } : {}) },
        factId,
      ),
    ),
  fc
    .record({
      command: pick(COMMANDS),
      failed: pick([0, 0, 1, 2]),
      file: pick(FILES),
      callId: optional(pick(CALL_IDS)),
      factId: optional(pick(FACT_IDS)),
      ts: optional(fc.nat(40)),
    })
    .map(({ command, failed, file, callId, factId, ts }): Op => (b) =>
      b.fact(
        {
          type: "test_result",
          runner: "vitest",
          command,
          passed: 3,
          failed,
          skipped: 0,
          failures: failed > 0 ? [{ file, testName: "t", message: "m" }] : [],
          ...(callId !== undefined ? { sourceCallId: callId } : {}),
          ...(ts !== undefined ? { ts: at(ts) } : {}),
        },
        factId,
      ),
    ),
  fc.constant<Op>((b) => b.fact({ type: "dependency_change", manifest: "package.json", added: [{ name: "zod", version: "3" }], removed: [] })),
  pick(FILES).map((file): Op => (b) => b.fact({ type: "revert_detected", files: [file] })),
);

const unitOp: fc.Arbitrary<Op> = fc
  .record({
    id: pick(UNIT_IDS),
    files: subset(FILES),
    evidence: subset(FACT_IDS),
    callIds: optional(subset(CALL_IDS)),
    validations: subset(VALIDATION_IDS),
    related: subset(DECISION_IDS),
    status: pick(STATUSES),
    placeholder: fc.boolean(),
    window: optional(fc.record({ from: fc.nat(60), span: fc.nat(30) })),
  })
  .map(({ id, files, evidence, callIds, validations, related, status, placeholder, window }): Op => (b) =>
    b.unit({
      id,
      files,
      evidence,
      ...(callIds !== undefined ? { agentCallIds: callIds } : {}),
      validationResults: validations,
      relatedDecisions: related,
      status,
      title: placeholder ? `Changed ${files.length} files` : `Unit ${id} work`,
      ...(window !== undefined ? { createdAt: at(window.from), updatedAt: at(window.from + window.span) } : {}),
    }),
  );

const otherOp: fc.Arbitrary<Op> = fc.oneof(
  fc
    .record({ id: pick(VALIDATION_IDS), command: pick(COMMANDS), kind: pick(["test", "lint"] as const), ts: optional(fc.nat(40)) })
    .map(({ id, command, kind, ts }): Op => (b) =>
      b.validation({ id, kind, command, status: "passed", passed: 1, failed: 0, skipped: 0, ...(ts !== undefined ? { ts: at(ts) } : {}) }),
    ),
  fc
    .record({ id: pick(DECISION_IDS), status: pick(["open", "answered", "delegated", "expired"] as const), affected: subset(UNIT_IDS) })
    .map(({ id, status, affected }): Op => (b) =>
      b.decision({
        id,
        status,
        affectedChangeUnits: affected,
        ...(status === "answered" ? { answer: { decisionId: id, decision: { q: "a" }, evidence: [] } } : {}),
      }),
    ),
  fc
    .record({
      unit: optional(pick(UNIT_IDS)),
      clamps: pick(CLAMPS),
      pass: optional(pick(["A", "B"] as const)),
      surface: optional(fc.boolean()),
    })
    .map(({ unit, clamps, pass, surface }): Op => (b) =>
      b.jev({
        id: `jev_${b.rows.length}`,
        clamps: [...clamps],
        ...(unit !== undefined ? { changeUnitId: unit } : {}),
        ...(pass !== undefined ? { pass } : {}),
        output:
          surface === undefined
            ? {}
            : {
                shouldSurface: surface,
                importance: 0.5,
                relevance: 0.4,
                interruption: 0.1,
                mentalModelChange: 0.2,
                semanticCategory: "behavior_change",
                scope: "local",
                humanDecision: "none",
                needsSystem2: false,
                confidence: 0.9,
                probabilities: {},
              },
      }),
    ),
  fc.constant<Op>((b) => b.raw("change_unit", { id: "broken" })),
  fc.constant<Op>((b) => b.raw("mystery_row", {})),
  fc.constant<Op>((b) => b.raw("telemetry", { name: "x" })),
);

/** Multi-row flows the single rows above rarely line up: a test run with its facts and validation,
 *  a decision answered by a user message (the answer step is absorbed and later relaunched), a
 *  duplicate hunk poll, an edit that becomes a test run and then gets a hunk, and a new turn. */
const flowOp: fc.Arbitrary<Op> = fc.oneof(
  fc
    .record({
      command: pick(["pnpm test", "pnpm lint"] as const),
      callId: pick(CALL_IDS),
      failed: pick([0, 1]),
      file: pick(FILES),
      factId: optional(pick(FACT_IDS)),
      validation: optional(pick(VALIDATION_IDS)),
    })
    .map(({ command, callId, failed, file, factId, validation }): Op => (b) => {
      b.agent({ type: "command_started", command, callId });
      b.agent({ type: "command_completed", command, exitCode: failed, stdout: "", stderr: "", callId });
      const ts = at(b.rows.length);
      b.fact(
        {
          type: "test_result",
          runner: "vitest",
          command,
          passed: 3,
          failed,
          skipped: 0,
          failures: failed > 0 ? [{ file, testName: "t", message: "m" }] : [],
          sourceCallId: callId,
          ts,
        },
        factId,
      );
      if (validation !== undefined) {
        b.validation({ id: validation, kind: "test", command, status: failed > 0 ? "failed" : "passed", passed: 3, failed, skipped: 0, ts });
      }
    }),
  fc
    .record({ id: pick(DECISION_IDS), answer: pick(TEXTS), relaunch: fc.boolean(), affected: subset(UNIT_IDS) })
    .map(({ id, answer, relaunch, affected }): Op => (b) => {
      b.decision({ id, status: "open", affectedChangeUnits: affected });
      b.agent({ type: "agent_message", role: "user", text: answer });
      b.decision({ id, status: "answered", affectedChangeUnits: affected, answer: { decisionId: id, decision: { q: "a" }, evidence: [] } });
      if (relaunch) b.agent({ type: "agent_started", prompt: answer });
    }),
  fc
    .record({ file: pick(FILES), hash: pick(HASHES) })
    .map(({ file, hash }): Op => (b) => {
      for (let i = 0; i < 2; i += 1) {
        b.fact({
          type: "git_hunk",
          file,
          added: 1,
          removed: 1,
          isFormattingOnly: false,
          isConfigOnly: false,
          isLockfile: false,
          diff: { hash, bytes: 10, text: "@@", truncated: false, redactions: 0 },
        });
      }
    }),
  // An edit that a test_result joins through its call id becomes a test run but keeps its edit, and later hunks on
  // its path still reach it: the chapters that join it and the turn's plan mark (its first edit) must follow.
  fc
    .record({
      path: pick(FILES),
      callId: pick(CALL_IDS),
      unit: pick(UNIT_IDS),
      formatting: fc.boolean(),
      planFirst: fc.boolean(),
      unitBeforeHunk: fc.boolean(),
    })
    .map(({ path, callId, unit, formatting, planFirst, unitBeforeHunk }): Op => (b) => {
      const plan = (): void => void b.agent({ type: "agent_message", role: "assistant", text: "Plan:\n- read\n- fix" });
      const citing = (): void => void b.unit({ id: unit, files: [path], evidence: [], agentCallIds: [callId], title: `Unit ${unit} work` });
      if (planFirst) plan();
      b.agent({ type: "file_changed", path, callId });
      if (!planFirst) plan();
      b.fact({ type: "test_result", runner: "vitest", command: "pnpm test", passed: 1, failed: 0, skipped: 0, failures: [], sourceCallId: callId });
      if (unitBeforeHunk) citing();
      b.fact({
        type: "git_hunk", file: path, added: 1, removed: 0, isFormattingOnly: formatting, isConfigOnly: false,
        isLockfile: path === "pnpm-lock.yaml",
      });
      if (!unitBeforeHunk) citing();
    }),
  fc
    .record({ prompt: pick(TEXTS), end: pick(["agent_completed", "agent_interrupted", "none"] as const) })
    .map(({ prompt, end }): Op => (b) => {
      if (end === "agent_completed") b.agent({ type: end });
      if (end === "agent_interrupted") b.agent({ type: end, reason: "stop" });
      b.agent({ type: "agent_started", prompt });
    }),
);

/** Three snapshots of one repo: a first scan, a description pass that changes one purpose, a rescan that changes one
 *  component's content and adds another. Shared with fold.incremental.test.ts. */
export const OVERVIEW_ROWS = [
  overviewSnapshot({
    components: [{ rootPath: "apps/web", role: "ui" }, { rootPath: "packages/api", role: "api" }, { rootPath: "packages/db", role: "storage" }],
    edges: [{ from: "apps/web", to: "packages/api", count: 3 }, { from: "packages/api", to: "packages/db", count: 7 }],
  }),
  overviewSnapshot({
    components: [
      { rootPath: "apps/web", role: "ui" },
      { rootPath: "packages/api", role: "api", purpose: "Serves the web app.", provenance: "model" },
      { rootPath: "packages/db", role: "storage" },
    ],
    edges: [{ from: "apps/web", to: "packages/api", count: 3 }, { from: "packages/api", to: "packages/db", count: 7 }],
  }),
  overviewSnapshot({
    components: [
      { rootPath: "apps/web", role: "ui" },
      { rootPath: "packages/api", role: "api" },
      { rootPath: "packages/db", role: "storage", version: 1 },
      { rootPath: "packages/jobs", role: "agent" },
    ],
    edges: [{ from: "apps/web", to: "packages/api", count: 3 }, { from: "packages/jobs", to: "packages/db", count: 2 }],
  }),
] as const;

const overviewOp: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: pick(OVERVIEW_ROWS).map((snapshot): Op => (b) => b.overview(snapshot)) },
  { weight: 1, arbitrary: fc.constant<Op>((b) => b.raw("overview_snapshot", { sessionId: "sess-test", repoRoot: "" })) },
);

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: agentOp },
  { weight: 4, arbitrary: factOp },
  { weight: 3, arbitrary: unitOp },
  { weight: 2, arbitrary: otherOp },
  { weight: 3, arbitrary: flowOp },
  { weight: 1, arbitrary: overviewOp },
);

export interface RowSession {
  meta: TraceSessionSummary;
  rows: TraceRow[];
}

/** A session of random rows; a few seqs are swapped or repeated so out_of_order and redelivery occur. */
export function arbRowSession(options: { maxOps?: number } = {}): fc.Arbitrary<RowSession> {
  return fc
    .record({
      // fast-check's default size keeps arrays near 10 items; medium reaches the joins that need many rows.
      ops: fc.array(opArb, { minLength: 1, maxLength: options.maxOps ?? 60, size: "medium" }),
      swap: fc.oneof({ weight: 4, arbitrary: fc.constant(undefined) }, { weight: 1, arbitrary: fc.nat() }),
    })
    .map(({ ops, swap }) => {
      const b = new TraceBuilder();
      for (const op of ops) op(b);
      const rows = [...b.rows];
      if (swap !== undefined && rows.length > 2) {
        const i = swap % (rows.length - 1);
        const a = rows[i];
        const c = rows[i + 1];
        if (a !== undefined && c !== undefined) {
          rows[i] = c;
          rows[i + 1] = a;
        }
      }
      return { meta: testMeta({ lastEventSeq: rows.length }), rows };
    });
}

/** Soak-shaped rows (spec §10 soak): runs that every unit cites through one validation, its
 *  test_result fact and its call id, units re-emitted many times, and edits per unit. */
export function soakShapedRows(options: { units: number; runs: number; reemits: number }): RowSession {
  const b = new TraceBuilder();
  b.agent({ type: "agent_started", prompt: "Soak" });
  const validations: string[] = [];
  const results: string[] = [];
  const calls: string[] = [];
  const unit = (i: number, version: number): void => {
    b.unit({
      id: `cu_${i}`,
      files: [`src/m${i}.ts`],
      evidence: [`fact_e${i}`, ...results],
      agentCallIds: [`edit_${i}`, ...calls],
      validationResults: [...validations],
      status: version % 3 === 2 ? "validated" : "in_progress",
      title: `Changed 1 file: src/m${i}.ts`,
    });
  };
  const runEvery = Math.max(1, Math.floor(options.units / Math.max(1, options.runs)));
  for (let i = 0; i < options.units; i += 1) {
    if (i % runEvery === 0 && validations.length < options.runs) {
      const r = validations.length;
      const callId = `run_${r}`;
      const failed = r % 2 === 0 ? 1 : 0;
      b.agent({ type: "command_started", command: "pnpm test", callId });
      b.agent({ type: "command_completed", command: "pnpm test", exitCode: failed, stdout: "", stderr: "", callId });
      b.fact(
        {
          type: "test_result",
          runner: "vitest",
          command: "pnpm test",
          passed: 40,
          failed,
          skipped: 0,
          failures: failed > 0 ? [{ file: `src/m${i}.ts`, testName: "t", message: "m" }] : [],
          sourceCallId: callId,
        },
        `fact_tr_${r}`,
      );
      b.validation({ id: `val_${r}`, kind: "test", command: "pnpm test", status: failed > 0 ? "failed" : "passed", passed: 40, failed, skipped: 0 });
      validations.push(`val_${r}`);
      results.push(`fact_tr_${r}`);
      calls.push(callId);
    }
    b.agent({ type: "file_changed", path: `src/m${i}.ts`, callId: `edit_${i}` });
    b.fact({ type: "git_hunk", file: `src/m${i}.ts`, added: 2, removed: 1, isFormattingOnly: false, isConfigOnly: false, isLockfile: false }, `fact_e${i}`);
    unit(i, 0);
    // Re-emit a few earlier units, as the pipeline does on every update.
    for (let k = 1; k <= options.reemits && i - k >= 0; k += 1) unit(i - k, k);
  }
  return { meta: testMeta({ lastEventSeq: b.rows.length }), rows: b.rows };
}

/** The pools folded onto their first two members: with 2 call ids, 2 facts, 1 validation, 2 units and 1 decision
 *  most joins line up (several steps share a call id, every unit cites the same fact), where the 4-6 member pools
 *  of arbRowSession leave them rare (review 1 M1c). */
const DENSE_IDS: Readonly<Record<string, string>> = {
  c3: "c1", c4: "c2", c5: "c1",
  fact_3: "fact_1", fact_4: "fact_2", fact_5: "fact_1", fact_6: "fact_2",
  val_2: "val_1", val_3: "val_1",
  u3: "u1", u4: "u2",
  d2: "d1",
};

function denseValue(value: unknown): unknown {
  if (typeof value === "string") return DENSE_IDS[value] ?? value;
  if (Array.isArray(value)) return value.map(denseValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, denseValue(inner)]));
  }
  return value;
}

/** arbRowSession over dense id pools: the same flows, with ids colliding far more often. */
export function arbDenseRowSession(options: { maxOps?: number } = {}): fc.Arbitrary<RowSession> {
  return arbRowSession(options).map(({ meta, rows }) => ({
    meta,
    rows: rows.map((row) => ({ ...row, payload: denseValue(row.payload) as typeof row.payload })),
  }));
}
