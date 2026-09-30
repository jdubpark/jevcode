import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { fixtureEventsPath, loadFixtureTrace, stripCaptureFields } from "../test-support/fixture-rows.js";
import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { foldRows } from "./fold.js";
import type { Step, TraceSession } from "./types.js";

function fold(builder: TraceBuilder): TraceSession {
  return foldRows(testMeta(), builder.rows, { live: false });
}

function stepAt(session: TraceSession, seq: number): Step {
  const step = session.steps.find((candidate) => candidate.firstSeq === seq);
  if (step === undefined) throw new Error(`no step starts at seq ${seq}`);
  return step;
}

function editSession(): { builder: TraceBuilder; hunkSeq: number } {
  const b = new TraceBuilder();
  b.agent({ type: "agent_started", prompt: "p" });
  b.agent({ type: "file_changed", path: "src/a.ts", callId: "t:1" });
  const hunkSeq = b.fact(
    { type: "git_hunk", file: "src/a.ts", added: 3, removed: 1, isFormattingOnly: false, isConfigOnly: false, isLockfile: false },
    "fact_a",
  );
  return { builder: b, hunkSeq };
}

describe("chapters", () => {
  it("folds unit versions into one chapter from the latest version", () => {
    const { builder: b } = editSession();
    const first = b.unit({ id: "cu_1", files: ["src/a.ts"], title: "Draft", evidence: ["fact_a"] });
    const last = b.unit({ id: "cu_1", files: ["src/a.ts"], title: "Final", status: "validated", evidence: ["fact_a"] });
    const [chapter] = fold(b).chapters;
    expect(chapter).toMatchObject({
      id: "unit:cu_1",
      changeUnitId: "cu_1",
      title: "Final",
      status: "validated",
      versions: 2,
      firstSeq: first,
      lastSeq: last,
    });
  });

  it("links observed through row factIds", () => {
    const { builder: b, hunkSeq } = editSession();
    b.unit({ id: "cu_1", files: ["src/a.ts"], evidence: ["fact_a", "fact_missing", "se-1", "val_1"] });
    const session = fold(b);
    const [chapter] = session.chapters;
    expect(chapter).toMatchObject({
      link: "observed",
      evidenceLinks: { cited: 2, resolved: 1, approx: 0 },
      stepIds: ["step:2"],
      factSeqs: [hunkSeq],
      current: true,
      noise: false,
      validationStepIds: [],
    });
    expect(stepAt(session, 2).chapterIds).toEqual(["unit:cu_1"]);
    expect(session.entities[0]?.chapterIds).toEqual(["unit:cu_1"]);
    expect(session.coverage.approximateJoins).toBe(false);
  });

  it("links observed through agentCallIds", () => {
    const { builder: b } = editSession();
    b.unit({ id: "cu_1", files: ["src/a.ts"], evidence: ["fact_other"], agentCallIds: ["t:1"] });
    const [chapter] = fold(b).chapters;
    expect(chapter).toMatchObject({ link: "observed", stepIds: ["step:2"], evidenceLinks: { cited: 1, resolved: 0, approx: 0 } });
  });

  it("joins each edit of a multi-file call only to the unit that owns its path", () => {
    // A Codex file_change item: one file_changed per path, all with the item's callId (A1-2), and
    // A1-8 cites that callId from every unit owning one of the paths.
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const a = b.agent({ type: "file_changed", path: "src/a.ts", callId: "t:item_1" });
    const bFile = b.agent({ type: "file_changed", path: "src/b.ts", callId: "t:item_1" });
    const hunk = { added: 1, removed: 0, isFormattingOnly: false, isConfigOnly: false, isLockfile: false };
    b.fact({ type: "git_hunk", file: "src/a.ts", ...hunk });
    b.fact({ type: "git_hunk", file: "src/b.ts", ...hunk });
    b.unit({ id: "U1", files: ["src/a.ts"], agentCallIds: ["t:item_1"] });
    b.unit({ id: "U2", files: ["src/b.ts"], agentCallIds: ["t:item_1"] });
    // A unit that cites the call but owns none of its paths joins no step through it.
    b.unit({ id: "U3", files: ["src/c.ts"], agentCallIds: ["t:item_1"] });
    const session = fold(b);
    const byUnit = new Map(session.chapters.map((chapter) => [chapter.changeUnitId, chapter]));
    expect(byUnit.get("U1")).toMatchObject({ link: "observed", stepIds: [`step:${a}`] });
    expect(byUnit.get("U2")).toMatchObject({ link: "observed", stepIds: [`step:${bFile}`] });
    expect(byUnit.get("U3")).toMatchObject({ link: "inferred", stepIds: [] });
    expect(stepAt(session, a).chapterIds).toEqual(["unit:U1"]);
    expect(stepAt(session, bFile).chapterIds).toEqual(["unit:U2"]);
  });

  it("legacy session joins by time window", () => {
    const trace = loadFixtureTrace("oauth");
    const session = foldRows(trace.meta, stripCaptureFields(trace.rows), { live: false });
    const citing = session.chapters.filter((chapter) => chapter.evidenceLinks.cited > 0);
    expect(citing.length).toBeGreaterThan(0);
    for (const chapter of citing) {
      expect(chapter.link, chapter.title).toBe("inferred");
      expect(chapter.evidenceLinks.resolved, chapter.title).toBe(0);
      expect(chapter.evidenceLinks.approx, chapter.title).toBeGreaterThan(0);
      expect(chapter.stepIds.length, chapter.title).toBeGreaterThan(0);
    }
    expect(session.coverage.approximateJoins).toBe(true);
    expect(session.coverage.capabilities).not.toContain("fact_links");
  });

  it("falls back to a file's latest earlier edit when none is inside the unit window", () => {
    const { builder: b } = editSession();
    b.agent({ type: "agent_message", role: "assistant", text: "later", ts: TraceBuilder.at(60) });
    b.unit({ id: "cu_late", files: ["src/a.ts"], evidence: ["fact_gone"], createdAt: TraceBuilder.at(60), updatedAt: TraceBuilder.at(61) });
    const [chapter] = fold(b).chapters;
    expect(chapter).toMatchObject({ link: "inferred", stepIds: ["step:2"], evidenceLinks: { cited: 1, resolved: 0, approx: 1 } });
  });

  it("keeps a unit that cites no content ids observed", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.unit({ id: "cu_fail", files: ["tests/a.test.ts"], evidence: ["fail_1", "val_1"], status: "failed" });
    expect(fold(b).chapters[0]).toMatchObject({ link: "observed", evidenceLinks: { cited: 0, resolved: 0, approx: 0 }, status: "failed" });
  });

  it("matches the oauth expected_units.json file sets", () => {
    const trace = loadFixtureTrace("oauth");
    const session = foldRows(trace.meta, trace.rows, { live: false });
    const expectedPath = path.join(path.dirname(fixtureEventsPath("oauth")), "expected_units.json");
    const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as { id: string; category: string; files: string[] }[];
    const key = (files: readonly string[]) => [...files].sort().join("|");
    for (const unit of expected) {
      const match = session.chapters.find(
        (chapter) => key(chapter.files) === key(unit.files) && chapter.category === unit.category,
      );
      expect(match, unit.id).toBeDefined();
    }
  });
});

describe("chapter short titles", () => {
  it("sets shortTitle from the latest unit version", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.unit({ id: "cu_1", files: ["tests/auth/oauth.test.ts"], category: "tests", title: "Changed 1 file: tests/auth/oauth.test.ts" });
    b.unit({ id: "cu_2", files: ["src/a.ts"], title: "Google OAuth identity layer" });
    const byUnit = new Map(fold(b).chapters.map((chapter) => [chapter.changeUnitId, chapter]));
    expect(byUnit.get("cu_1")).toMatchObject({ title: "Changed 1 file: tests/auth/oauth.test.ts", shortTitle: "Tests · oauth" });
    expect(byUnit.get("cu_2")?.shortTitle).toBe("Google OAuth identity…");
  });
});

describe("validation-only steps", () => {
  it("lists validation steps that no other join links to the chapter", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.fact({ type: "git_hunk", file: "src/a.ts", added: 3, removed: 0, isFormattingOnly: false, isConfigOnly: false, isLockfile: false }, "fact_a");
    const run = b.agent({ type: "command_started", command: "pnpm test" });
    b.agent({ type: "command_completed", command: "pnpm test", exitCode: 0, stdout: "", stderr: "" });
    b.fact({ type: "test_result", runner: "vitest", command: "pnpm test", passed: 3, failed: 0, skipped: 0, failures: [] }, "fact_tr");
    b.validation({ id: "val_1", kind: "test", command: "pnpm test", status: "passed", passed: 3, failed: 0, skipped: 0 });
    b.unit({ id: "cu_a", files: ["src/a.ts"], evidence: ["fact_a"], validationResults: ["val_1"] });
    b.unit({ id: "cu_t", files: ["tests/a.test.ts"], evidence: ["fact_tr"], validationResults: ["val_1"] });
    const byUnit = new Map(fold(b).chapters.map((chapter) => [chapter.changeUnitId, chapter]));
    expect(byUnit.get("cu_a")).toMatchObject({ validationStepIds: [`step:${run}`], validationOnlyStepIds: [`step:${run}`] });
    // cu_t also cites the run's test_result fact, so the run is part of its own work.
    expect(byUnit.get("cu_t")).toMatchObject({ validationStepIds: [`step:${run}`], validationOnlyStepIds: [] });
  });
});

describe("decisions and Jev", () => {
  it("folds every row of one decision id into one step", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const first = b.decision({ id: "dec-oauth-0001", title: "Linking policy" });
    const message = b.agent({ type: "agent_message", role: "user", text: "decision:\n  policy: b\n\ninstruction:\n  Use B." });
    const answer = b.decision({
      id: "dec-oauth-0001",
      title: "Linking policy",
      status: "answered",
      answer: { decisionId: "dec-oauth-0001", decision: { policy: "b" }, evidence: [] },
    });
    b.unit({ id: "cu_1", files: ["src/a.ts"], relatedDecisions: ["dec-oauth-0001"] });
    const session = fold(b);
    const step = stepAt(session, first);
    expect(session.steps.filter((candidate) => candidate.kind === "decision")).toHaveLength(1);
    expect(step).toMatchObject({
      id: `step:${first}`,
      kind: "decision",
      lane: "supervisor",
      status: "ok",
      target: "dec-oauth-0001",
      seqs: [first, message, answer],
    });
    expect(step.decision).toEqual({
      decisionId: "dec-oauth-0001",
      title: "Linking policy",
      severity: "required",
      status: "answered",
      options: [
        { id: "a", label: "Option A", chosen: false },
        { id: "b", label: "Option B", chosen: true },
      ],
      decidedBy: "supervisor",
      answerSeq: message,
    });
    expect(session.chapters[0]?.decisionIds).toEqual(["decision:dec-oauth-0001"]);
    // The answer is absorbed into the decision step (R25): no instruction step of its own.
    expect(session.steps.some((candidate) => candidate.kind === "instruction" && candidate.firstSeq === message)).toBe(false);
  });

  it("ends a decision's wait at its answer row; a later re-emit of the id does not extend it", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p", ts: TraceBuilder.at(0) });
    b.agent({ type: "agent_message", role: "assistant", text: "a", ts: TraceBuilder.at(2) });
    const first = b.decision({ id: "dec-1" });
    const message = b.agent({ type: "agent_message", role: "user", text: "Use B.", ts: TraceBuilder.at(6) });
    const answered = { decisionId: "dec-1", decision: { policy: "b" }, evidence: [] };
    b.decision({ id: "dec-1", status: "answered", answer: answered });
    b.agent({ type: "agent_message", role: "assistant", text: "done", ts: TraceBuilder.at(20) });
    // The Jev projection pass re-emits the answered decision at the end of the session.
    const reemit = b.decision({ id: "dec-1", status: "answered", answer: answered });
    const step = stepAt(fold(b), first);
    expect(step.decision?.answerSeq).toBe(message);
    expect(step.seqs).toContain(reemit);
    expect(step).toMatchObject({ tMs: 2_000, endTMs: 6_000, durationMs: 4_000, endTs: TraceBuilder.at(6) });
  });

  it("ends a decision closed without an answer message at its closing row", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p", ts: TraceBuilder.at(0) });
    const first = b.decision({ id: "dec-1" });
    b.agent({ type: "agent_message", role: "assistant", text: "a", ts: TraceBuilder.at(5) });
    b.decision({ id: "dec-1", status: "delegated" });
    b.agent({ type: "agent_message", role: "assistant", text: "b", ts: TraceBuilder.at(30) });
    b.decision({ id: "dec-1", status: "delegated" });
    expect(stepAt(fold(b), first)).toMatchObject({ tMs: 0, endTMs: 5_000, durationMs: 5_000 });
  });

  it("reads a decision running while open and unknown once expired (spec §6.6 Status)", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p", ts: TraceBuilder.at(0) });
    const open = b.decision({ id: "dec-open" });
    const expiring = b.decision({ id: "dec-expired" });
    b.decision({ id: "dec-expired", status: "expired" });
    const closed = fold(b);
    expect(stepAt(closed, open)).toMatchObject({ status: "running", endTs: null, endTMs: null, durationMs: null });
    expect(stepAt(closed, expiring).status).toBe("unknown");
    // At the live edge an open decision lasts until now, like any running step.
    const live = foldRows(testMeta(), b.rows, { live: true, nowMs: Date.parse(TraceBuilder.at(30)) });
    expect(stepAt(live, open)).toMatchObject({ status: "running", durationMs: 30_000 });
  });

  it("keeps pipeline rows on the inherited clock", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p", ts: TraceBuilder.at(0) });
    b.agent({ type: "agent_message", role: "assistant", text: "a", ts: TraceBuilder.at(4) });
    // replay.db stamps decision and Jev rows with the replay run's wall clock, days later.
    const decision = b.decision({ id: "dec-1", ts: "2026-09-21T10:00:00.000Z" });
    const jev = b.jev({ id: "j", clamps: [], ts: "2026-09-21T10:00:01.000Z" });
    const after = b.agent({ type: "agent_message", role: "assistant", text: "b", ts: TraceBuilder.at(6) });
    const session = fold(b);
    expect(stepAt(session, decision)).toMatchObject({ tMs: 4_000, startTs: TraceBuilder.at(4) });
    expect(stepAt(session, jev).tMs).toBe(4_000);
    expect(stepAt(session, after).tMs).toBe(6_000);
    expect(session.span.durationMs).toBe(6_000);
  });

  it("marks a turn that stopped on an answered decision as waiting and the next one as resumed", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "agent_waiting" });
    b.decision({ id: "dec-1", status: "answered", answer: { decisionId: "dec-1", decision: { k: "a" }, evidence: [] } });
    b.agent({ type: "agent_started", prompt: "continue with A" });
    expect(fold(b).turns.map((turn) => [turn.trigger, turn.outcome])).toEqual([
      ["initial", "waiting"],
      ["resume", "unknown"],
    ]);
  });

  it("links a decision through affectedChangeUnits", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.decision({ id: "dec-1", affectedChangeUnits: ["cu_1"] });
    b.unit({ id: "cu_1", files: [] });
    expect(fold(b).chapters[0]?.decisionIds).toEqual(["decision:dec-1"]);
  });

  it("makes a guardrail step for a clamped jev_decision and an attention step otherwise", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const clamped = b.jev({ id: "jev_1", changeUnitId: "cu_1", clamps: ["schema_floor", "guardrail.security"], pass: "A" });
    const plain = b.jev({ id: "jev_2", changeUnitId: "cu_1", clamps: [] });
    b.unit({ id: "cu_1", files: [] });
    const session = fold(b);
    expect(stepAt(session, clamped)).toMatchObject({
      kind: "guardrail",
      lane: "jev",
      actor: "jevcode",
      headline: "Schema change kept visible, guardrail.security",
      guardrail: { clampIds: ["schema_floor", "guardrail.security"], changeUnitId: "cu_1", pass: "A", clientKind: "typesafe", confidence: 0.9 },
    });
    expect(stepAt(session, plain)).toMatchObject({ kind: "attention", headline: "Attention scored" });
    expect(session.chapters[0]).toMatchObject({
      clampIds: ["schema_floor", "guardrail.security"],
      stepIds: [`step:${clamped}`, `step:${plain}`],
    });
    expect(session.coverage.capabilities).toContain("jev_decisions");
  });

  it("takes the triad and client kind from the latest Pass A attention row, else from the unit", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const attention = (importance: number) => ({
      shouldSurface: true,
      importance,
      relevance: 0.5,
      interruption: 0.25,
      mentalModelChange: 0.1,
      semanticCategory: "behavior_change",
      scope: "module",
      humanDecision: "none",
      needsSystem2: false,
      confidence: 0.8,
      probabilities: {},
    });
    b.jev({ id: "jev_1", changeUnitId: "cu_jev", clamps: [], output: attention(0.2), clientKind: "degrade" });
    b.jev({ id: "jev_2", changeUnitId: "cu_jev", clamps: [], pass: "A", output: attention(0.9), clientKind: "typesafe" });
    // A Pass B row never feeds the triad, even when its output happens to parse.
    b.jev({ id: "jev_3", changeUnitId: "cu_jev", clamps: [], pass: "B", output: attention(0.1), clientKind: "playback" });
    b.jev({ id: "jev_4", changeUnitId: "cu_jev", clamps: [], output: { shouldSurface: false, clamps: [], guardrailSuppression: true } });
    b.unit({ id: "cu_jev", files: [], importance: 0.4 });
    b.unit({ id: "cu_plain", files: [], importance: 0.3, relevance: 0.6, interruption: 0.1 });
    const byUnit = new Map(fold(b).chapters.map((chapter) => [chapter.changeUnitId, chapter]));
    expect(byUnit.get("cu_jev")?.triad).toEqual({ importance: 0.9, relevance: 0.5, interruption: 0.25, clientKind: "typesafe" });
    expect(byUnit.get("cu_plain")?.triad).toEqual({ importance: 0.3, relevance: 0.6, interruption: 0.1 });
  });
});
