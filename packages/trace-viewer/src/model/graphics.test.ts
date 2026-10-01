import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { loadFixtureTrace } from "../test-support/fixture-rows.js";
import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { foldRows } from "./fold.js";
import { describeGraphic, entityPositions, pickGraphic, sessionStep, stepPositions } from "./format.js";
import type { Chapter, Entity, GraphicSpec, Step, TraceSession } from "./types.js";

function hunk(file: string, added: number, removed: number) {
  return { type: "git_hunk" as const, file, added, removed, isFormattingOnly: false, isConfigOnly: false, isLockfile: false };
}

function chapterOf(session: TraceSession, unitId: string): Chapter {
  const chapter = session.chapters.find((candidate) => candidate.changeUnitId === unitId);
  if (chapter === undefined) throw new Error(`no chapter for ${unitId}`);
  return chapter;
}

function stepAt(session: TraceSession, seq: number): Step {
  const step = session.steps.find((candidate) => candidate.firstSeq === seq);
  if (step === undefined) throw new Error(`no step starts at seq ${seq}`);
  return step;
}

describe("pickGraphic: steps", () => {
  it("picks tests, claim, diff and fork graphics on oauth", () => {
    const trace = loadFixtureTrace("oauth");
    const session = foldRows(trace.meta, trace.rows, { live: false });
    const byKind = (kind: string) => session.steps.find((step) => step.kind === kind);
    expect(pickGraphic(byKind("test") as NonNullable<ReturnType<typeof byKind>>, session)).toEqual({
      kind: "tests",
      passed: 14,
      failed: 1,
      skipped: 0,
    });
    const claimStep = session.steps.find((step) => step.problems.includes("claim_contradicted"));
    expect(claimStep && pickGraphic(claimStep, session)).toMatchObject({
      kind: "claim",
      claim: { text: "OAuth implementation complete; all checks pass.", tMs: claimStep?.tMs },
      observed: { passed: 14, failed: 1, command: "pnpm test" },
    });
    const edit = session.steps.find((step) => step.edit?.path === "src/auth/identity.ts");
    // Counts come from the fixture row, never a literal: A1-9 reconciles fixture git_hunk counts
    // with the real diffs (index §4, fixture drift).
    const fixtureHunk = trace.rows.find((row) => {
      const payload = row.payload as { type?: string; file?: string };
      return row.type === "evidence_fact" && payload.type === "git_hunk" && payload.file === "src/auth/identity.ts";
    })?.payload as { added: number; removed: number } | undefined;
    expect(fixtureHunk).toBeDefined();
    expect(edit && pickGraphic(edit, session)).toEqual({ kind: "diff", added: fixtureHunk?.added, removed: fixtureHunk?.removed });
    const decision = byKind("decision");
    expect(decision && pickGraphic(decision, session)).toEqual({
      kind: "fork",
      options: [
        { label: "Match by email", chosen: false },
        { label: "Require explicit linking", chosen: true },
      ],
      decidedBy: "supervisor",
    });
    const message = byKind("message");
    expect(message && pickGraphic(message, session)).toBeNull();
  });

  it("draws commands as durations: open while running, an x for a failed command, a dot for a failed check", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const make = b.agent({ type: "command_started", command: "make" });
    b.agent({ type: "command_completed", command: "make", exitCode: 2, stdout: "", stderr: "" });
    const lint = b.agent({ type: "command_started", command: "pnpm lint" });
    b.agent({ type: "command_completed", command: "pnpm lint", exitCode: 1, stdout: "", stderr: "" });
    const install = b.agent({ type: "command_started", command: "pnpm install" });
    const session = foldRows(testMeta(), b.rows, { live: true });
    expect(pickGraphic(stepAt(session, make), session)).toEqual({
      kind: "duration",
      durationMs: 1_000,
      running: false,
      status: "failed",
      end: "exit_x",
    });
    expect(pickGraphic(stepAt(session, lint), session)).toEqual({
      kind: "duration",
      durationMs: 1_000,
      running: false,
      status: "failed",
      end: "bad_dot",
    });
    expect(pickGraphic(stepAt(session, install), session)).toEqual({
      kind: "duration",
      durationMs: null,
      running: true,
      status: "running",
      end: "none",
    });
  });
});

describe("pickGraphic: chapters follow CHAPTER_GRAPHIC", () => {
  it("draws a schema chapter as tables and falls back to a diff list without schema data", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.fact(hunk("migrations/1.sql", 12, 0));
    b.unit({
      id: "cu_schema",
      category: "schema",
      files: ["migrations/1.sql"],
      schemaChanges: [
        { entity: "identities", entityType: "table", change: "added" },
        { entity: "identities.user_id", entityType: "column", change: "added" },
        { entity: "users.password_hash", entityType: "column", change: "removed" },
        { entity: "users_email_idx", entityType: "index", change: "added" },
      ],
    });
    b.unit({ id: "cu_bare", category: "schema", files: ["migrations/1.sql"] });
    const session = foldRows(testMeta(), b.rows, { live: false });
    expect(pickGraphic(chapterOf(session, "cu_schema"), session)).toEqual({
      kind: "table",
      tables: [
        { name: "identities", role: "new", columns: 1 },
        { name: "users", role: "altered", columns: 1 },
      ],
    });
    expect(pickGraphic(chapterOf(session, "cu_bare"), session)).toEqual({
      kind: "diff",
      added: 12,
      removed: 0,
      files: [{ path: "migrations/1.sql", added: 12, removed: 0 }],
    });
  });

  it("draws architecture and api chapters as a flow of file stems in first-edit order", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.fact(hunk("src/auth/identity.ts", 24, 0));
    b.fact(hunk("src/auth/google.ts", 34, 0));
    b.fact(hunk("src/server/index.ts", 11, 3));
    b.fact(hunk("src/auth/service.ts", 7, 12));
    b.unit({
      id: "cu_arch",
      category: "architecture",
      files: ["src/server/index.ts", "src/auth/service.ts", "src/auth/google.ts", "src/auth/identity.ts"],
    });
    b.unit({ id: "cu_api", category: "api", files: ["src/server/index.ts"] });
    const session = foldRows(testMeta(), b.rows, { live: false });
    expect(pickGraphic(chapterOf(session, "cu_arch"), session)).toEqual({
      kind: "flow",
      nodes: ["identity", "google", "index"],
      focus: 1,
    });
    expect(pickGraphic(chapterOf(session, "cu_api"), session)).toEqual({ kind: "flow", nodes: ["index"], focus: 0 });
  });

  it("draws a tests chapter with its latest run's counts", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.fact(hunk("tests/a.test.ts", 5, 0));
    for (const [passed, failed, id] of [[4, 1, "val_1"], [5, 0, "val_2"]] as const) {
      b.agent({ type: "command_started", command: "pnpm test" });
      b.agent({ type: "command_completed", command: "pnpm test", exitCode: failed > 0 ? 1 : 0, stdout: "", stderr: "" });
      b.fact({ type: "test_result", runner: "vitest", command: "pnpm test", passed, failed, skipped: 0, failures: [] });
      b.validation({ id, kind: "test", command: "pnpm test", status: failed > 0 ? "failed" : "passed", passed, failed, skipped: 0 });
    }
    b.unit({ id: "cu_tests", category: "tests", files: ["tests/a.test.ts"], validationResults: ["val_1", "val_2"] });
    b.unit({ id: "cu_untested", category: "tests", files: ["tests/a.test.ts"] });
    const session = foldRows(testMeta(), b.rows, { live: false });
    expect(pickGraphic(chapterOf(session, "cu_tests"), session)).toEqual({ kind: "tests", passed: 5, failed: 0, skipped: 0 });
    expect(pickGraphic(chapterOf(session, "cu_untested"), session)).toEqual({
      kind: "diff",
      added: 5,
      removed: 0,
      files: [{ path: "tests/a.test.ts", added: 5, removed: 0 }],
    });
  });

  it("draws a decision-born chapter with an answered decision as a fork where the decision is not shown", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.fact(hunk("src/link.ts", 6, 1));
    b.decision({ id: "dec-1", title: "Linking policy" });
    b.decision({
      id: "dec-1",
      title: "Linking policy",
      status: "answered",
      answer: { decisionId: "dec-1", decision: { policy: "b" }, evidence: [] },
    });
    b.decision({ id: "dec-2", title: "Still open" });
    b.unit({ id: "cu_linked", files: ["src/link.ts"], relatedDecisions: ["dec-1"] });
    b.unit({ id: "cu_waiting", files: ["src/link.ts"], relatedDecisions: ["dec-2"] });
    const session = foldRows(testMeta(), b.rows, { live: false });
    // Spec §7.12 refinement (C3-6 ruling): the fork shows on the decision-born chapter only where no decision frame
    // or row beside it already shows it; every list surface shows the decision step, so the default is a DiffBar.
    expect(pickGraphic(chapterOf(session, "cu_linked"), session)).toMatchObject({ kind: "diff", added: 6, removed: 1 });
    expect(pickGraphic(chapterOf(session, "cu_linked"), session, { decisionShown: () => false })).toEqual({
      kind: "fork",
      options: [
        { label: "Option A", chosen: false },
        { label: "Option B", chosen: true },
      ],
      decidedBy: "supervisor",
    });
    expect(pickGraphic(chapterOf(session, "cu_waiting"), session)).toMatchObject({ kind: "diff", added: 6, removed: 1 });
  });

  it("forks only the decision-born chapter, never one that links the decision but predates it", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.fact(hunk("src/identity.ts", 24, 0));
    // Like oauth's Identity layer: the decision lists this unit as affected, but the unit comes first.
    b.unit({ id: "cu_identity", category: "security", files: ["src/identity.ts"] });
    // Decision rows inherit the agent clock (R25): this message puts the decision after cu_identity.
    b.agent({ type: "agent_message", role: "assistant", text: "Which linking policy?" });
    b.decision({ id: "dec-1", title: "Linking policy", affectedChangeUnits: ["cu_identity", "cu_policy"] });
    b.decision({
      id: "dec-1",
      title: "Linking policy",
      affectedChangeUnits: ["cu_identity", "cu_policy"],
      status: "answered",
      answer: { decisionId: "dec-1", decision: { policy: "b" }, evidence: [] },
    });
    b.fact(hunk("src/link.ts", 6, 1));
    b.unit({ id: "cu_policy", category: "security", files: ["src/link.ts"] });
    const session = foldRows(testMeta(), b.rows, { live: false });
    const hidden = { decisionShown: () => false };
    expect(chapterOf(session, "cu_identity").decisionIds).toEqual(["decision:dec-1"]);
    expect(pickGraphic(chapterOf(session, "cu_identity"), session, hidden)).toMatchObject({ kind: "diff", added: 24 });
    expect(pickGraphic(chapterOf(session, "cu_policy"), session, hidden)).toMatchObject({ kind: "fork" });
    expect(pickGraphic(chapterOf(session, "cu_policy"), session)).toMatchObject({ kind: "diff", added: 6 });
  });

  it("lists a chapter's top 4 files by lines changed and counts the rest", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const sizes = [
      ["a.ts", 3, 1],
      ["b.ts", 2, 2],
      ["c.ts", 10, 0],
      ["d.ts", 1, 0],
      ["e.ts", 0, 6],
      ["f.ts", 1, 1],
    ] as const;
    for (const [file, added, removed] of sizes) b.fact(hunk(file, added, removed));
    b.unit({ id: "cu_code", files: sizes.map(([file]) => file) });
    const session = foldRows(testMeta(), b.rows, { live: false });
    expect(pickGraphic(chapterOf(session, "cu_code"), session)).toEqual({
      kind: "diff",
      added: 17,
      removed: 10,
      files: [
        { path: "c.ts", added: 10, removed: 0 },
        { path: "e.ts", added: 0, removed: 6 },
        { path: "a.ts", added: 3, removed: 1 },
        { path: "b.ts", added: 2, removed: 2 },
      ],
      moreFiles: 2,
    });
  });
});

describe("describeGraphic", () => {
  it.each<[GraphicSpec, string]>([
    [{ kind: "tests", passed: 14, failed: 1, skipped: 0 }, "14 passed, 1 failed"],
    [{ kind: "tests", passed: 3, failed: 0, skipped: 2 }, "3 passed, 0 failed, 2 skipped"],
    [{ kind: "diff", added: 17, removed: 3 }, "+17 −3"],
    [
      { kind: "diff", added: 17, removed: 10, files: [{ path: "c.ts", added: 10, removed: 0 }], moreFiles: 5 },
      "+17 −10 in 6 files",
    ],
    [{ kind: "duration", durationMs: 5_000, running: false, status: "failed", end: "bad_dot" }, "5.0 s, failed"],
    [{ kind: "duration", durationMs: null, running: true, status: "running", end: "none" }, "running"],
    [
      { kind: "fork", options: [{ label: "Fail open", chosen: true }, { label: "Fail closed", chosen: false }], decidedBy: "supervisor" },
      "2 options; you chose Fail open",
    ],
    [{ kind: "fork", options: [{ label: "A", chosen: false }], decidedBy: "open" }, "1 option; open"],
    [{ kind: "flow", nodes: ["User", "Identity", "Session"], focus: 1 }, "User → Identity → Session"],
    [
      {
        kind: "table",
        tables: [
          { name: "identities", role: "new", columns: 0 },
          { name: "users", role: "altered", columns: 1 },
        ],
      },
      "identities (new); users (altered, 1 column)",
    ],
    [
      {
        kind: "claim",
        claim: { text: "All checks pass.", span: [0, 15], tMs: 43_000 },
        observed: { passed: 14, failed: 1, command: "pnpm test", tMs: 40_000 },
      },
      'Claimed "All checks pass."; pnpm test had 14 passed, 1 failed',
    ],
  ])("describes %j", (spec, text) => {
    expect(describeGraphic(spec)).toBe(text);
  });
});

// ------------------------------------------------------------ lookups from the previous session

/** A list edit: replace in place (same or another key), append, remove or swap. */
type ListEdit = { op: "replace"; at: number; key: number } | { op: "append"; key: number } | { op: "remove"; at: number } | { op: "swap"; at: number; with: number };

const arbListEdit: fc.Arbitrary<ListEdit> = fc.oneof(
  fc.record({ op: fc.constant("replace" as const), at: fc.nat(), key: fc.nat({ max: 6 }) }),
  fc.record({ op: fc.constant("append" as const), key: fc.nat({ max: 6 }) }),
  fc.record({ op: fc.constant("remove" as const), at: fc.nat() }),
  fc.record({ op: fc.constant("swap" as const), at: fc.nat(), with: fc.nat() }),
);

/** Chains of lists, each an edit of the last: kept items stay the same objects, as a finalize keeps them. */
function editChain<T>(first: T[], rounds: readonly (readonly ListEdit[])[], make: (key: number, was: T | undefined) => T): T[][] {
  const chain = [first];
  for (const edits of rounds) {
    const list = [...(chain[chain.length - 1] ?? [])];
    for (const e of edits) {
      const n = Math.max(1, list.length);
      if (e.op === "replace" && list.length > 0) list[e.at % n] = make(e.key, list[e.at % n]);
      if (e.op === "append") list.push(make(e.key, undefined));
      if (e.op === "remove" && list.length > 0) list.splice(e.at % n, 1);
      if (e.op === "swap" && list.length > 1) {
        const [i, j] = [e.at % n, e.with % n];
        const [a, b] = [list[i], list[j]];
        if (a !== undefined && b !== undefined) [list[i], list[j]] = [b, a];
      }
    }
    chain.push(list);
  }
  return chain;
}

const roundsArb = fc.array(fc.array(arbListEdit, { maxLength: 4 }), { minLength: 1, maxLength: 6 });

describe("graphic lookups built from the previous session's equal fresh ones", () => {
  it("entity positions per path, after every edit of the entity list", () => {
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 6 }), { maxLength: 8 }), roundsArb, (keys, rounds) => {
        const entity = (key: number): Entity => ({ path: `src/f${key}.ts` }) as Entity;
        let previous: ReturnType<typeof entityPositions> | undefined;
        for (const list of editChain(keys.map((key) => entity(key)), rounds, (key) => entity(key))) {
          const snapshot = previous === undefined ? undefined : structuredClone(previous.byPath);
          const next = entityPositions(list, previous);
          expect(next.byPath).toEqual(entityPositions(list).byPath);
          // An earlier session keeps its own lookups: building from them never changes them.
          if (previous !== undefined) expect(previous.byPath).toEqual(snapshot);
          previous = next;
        }
      }),
      { numRuns: 500 },
    );
  });

  it("step positions and deciding steps, after every edit of the step list", () => {
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 6 }), { maxLength: 8 }), roundsArb, (keys, rounds) => {
        // Keys 0-2 are decision steps (decided or not); a replace keeps the id half the time with a new decision.
        const step = (key: number, was?: Step): Step =>
          ({
            id: was !== undefined && key % 2 === 0 ? was.id : `step:${key}`,
            ...(key < 3 ? { decision: { decisionId: `d${key % 2}`, ...(key === 1 ? {} : { decidedBy: "supervisor" }) } } : {}),
          }) as Step;
        let previous: ReturnType<typeof stepPositions> | undefined;
        for (const list of editChain(keys.map((key) => step(key)), rounds, (key, was) => step(key, was))) {
          const snapshot = previous === undefined ? undefined : structuredClone({ ...previous, steps: [] });
          const next = stepPositions(list, previous);
          if (previous !== undefined) expect({ ...previous, steps: [] }).toEqual(snapshot);
          const fresh = stepPositions(list);
          expect(next.stepPosition).toEqual(fresh.stepPosition);
          expect(next.decidedStep).toEqual(fresh.decidedStep);
          previous = next;
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe("graphic lookup slots", () => {
  it("do not keep a dropped session's steps alive", async () => {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    const trace = loadFixtureTrace("oauth");
    let session: TraceSession | undefined = foldRows(trace.meta, trace.rows, { live: false });
    const first = session.steps[0];
    if (first === undefined) throw new Error("no steps");
    expect(sessionStep(session, first.id)).toBe(first);
    const chapter = session.chapters.find((candidate) => candidate.files.length > 0);
    if (chapter !== undefined) pickGraphic(chapter, session);
    const steps = new WeakRef(session.steps);
    const entities = new WeakRef(session.entities);
    session = undefined;
    // A WeakRef target stays alive until the end of the current job.
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
    expect(steps.deref()).toBeUndefined();
    expect(entities.deref()).toBeUndefined();
  });
});
