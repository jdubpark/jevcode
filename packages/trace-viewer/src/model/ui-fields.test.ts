import { describe, expect, it } from "vitest";

import { loadFixtureTrace } from "../test-support/fixture-rows.js";
import { TraceBuilder, testMeta, type DecisionInput } from "../test-support/trace-builder.js";
import { foldRows } from "./fold.js";
import { pickGraphic } from "./format.js";
import { isPlanText, matchSuccessClaim } from "./signals.js";
import type { Step, TraceSession } from "./types.js";

// Fields the viewer UI needs from the model (decision record R25).

function fold(b: TraceBuilder): TraceSession {
  return foldRows(testMeta(), b.rows, { live: false });
}

function holding(session: TraceSession, seq: number): Step | undefined {
  return session.steps.find((step) => step.seqs.includes(seq));
}

describe("Step.startMs", () => {
  it("is the source time for agent rows and origin plus the inherited clock for pipeline rows", () => {
    const b = new TraceBuilder();
    const start = b.agent({ type: "agent_started", prompt: "p", ts: TraceBuilder.at(0) });
    const message = b.agent({ type: "agent_message", role: "assistant", text: "a", ts: TraceBuilder.at(4) });
    // replay.db stamps decision rows with the replay run's wall clock, days after the source times.
    const decision = b.decision({ id: "dec-1", ts: "2026-09-21T10:00:00.000Z" });
    const session = fold(b);
    expect(holding(session, start)?.startMs).toBe(Date.parse(TraceBuilder.at(0)));
    expect(holding(session, message)?.startMs).toBe(Date.parse(TraceBuilder.at(4)));
    expect(holding(session, decision)?.startMs).toBe(Date.parse(TraceBuilder.at(4)));
  });
});

describe("Turn.planStepId and Turn.claimStepId", () => {
  it("marks the plan before the first edit and the last success claim", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "agent_message", role: "assistant", text: "Looking at the code first." });
    const plan = b.agent({ type: "agent_message", role: "assistant", text: "Steps:\n1. add the route\n2. add a test" });
    b.agent({ type: "file_changed", path: "src/a.ts" });
    b.agent({ type: "agent_message", role: "assistant", text: "Plan: also update the docs" });
    b.agent({ type: "agent_message", role: "assistant", text: "All tests pass." });
    const claim = b.agent({ type: "agent_message", role: "assistant", text: "Done; all checks pass." });
    b.agent({ type: "agent_completed" });
    expect(fold(b).turns[0]).toMatchObject({ planStepId: `step:${plan}`, claimStepId: `step:${claim}` });
  });

  it("leaves both unset when no message qualifies", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "agent_message", role: "assistant", text: "Not all tests pass yet." });
    b.agent({ type: "agent_completed" });
    const turn = fold(b).turns[0];
    expect(turn?.planStepId).toBeUndefined();
    expect(turn?.claimStepId).toBeUndefined();
  });

  it("finds oauth's plan and claim", () => {
    const trace = loadFixtureTrace("oauth");
    const session = foldRows(trace.meta, trace.rows, { live: false });
    const plan = session.steps.find((step) => step.kind === "message" && step.text?.startsWith("Plan:") === true);
    const claim = session.steps.find((step) => step.text === "OAuth implementation complete; all checks pass.");
    expect(plan).toBeDefined();
    expect(claim).toBeDefined();
    expect(session.turns[0]).toMatchObject({ planStepId: plan?.id, claimStepId: claim?.id });
  });
});

describe("matchSuccessClaim and isPlanText", () => {
  it.each([
    ["OAuth implementation complete; all checks pass.", "all checks pass"],
    ["Refactor done. All tests pass now.", "All tests pass"],
    ["I checked it and the build is green", "build is green"],
    ["The migration is complete.", "complete"],
  ])("finds the claim in %j", (text, phrase) => {
    const span = matchSuccessClaim(text);
    expect(span).not.toBeNull();
    const [start, end] = span ?? [0, 0];
    expect(text.slice(start, end)).toBe(phrase);
  });

  it("returns null for negated or absent claims", () => {
    expect(matchSuccessClaim("Not all tests pass yet.")).toBeNull();
    expect(matchSuccessClaim("I'm done reading the file")).toBeNull();
  });

  it("accepts a Plan lead or two list items and rejects prose", () => {
    expect(isPlanText("Plan: introduce an Identity layer.")).toBe(true);
    expect(isPlanText("1. inspect\n2. edit")).toBe(true);
    expect(isPlanText("- one item only")).toBe(false);
    expect(isPlanText("I will plan later.")).toBe(false);
  });
});

describe("Chapter.current, Chapter.noise and Chapter.validationStepIds", () => {
  it("marks a superseded chapter not current and a lockfile-only chapter as noise", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.fact(
      { type: "git_hunk", file: "pnpm-lock.yaml", added: 40, removed: 2, isFormattingOnly: false, isConfigOnly: false, isLockfile: true },
      "fact_lock",
    );
    b.fact(
      { type: "git_hunk", file: "src/a.ts", added: 3, removed: 1, isFormattingOnly: false, isConfigOnly: false, isLockfile: false },
      "fact_code",
    );
    b.unit({ id: "cu_lock", files: ["pnpm-lock.yaml"], evidence: ["fact_lock"] });
    b.unit({ id: "cu_code", files: ["src/a.ts"], evidence: ["fact_code"], status: "superseded" });
    const byUnit = new Map(fold(b).chapters.map((chapter) => [chapter.changeUnitId, chapter]));
    expect(byUnit.get("cu_lock")).toMatchObject({ noise: true, current: true });
    expect(byUnit.get("cu_code")).toMatchObject({ noise: false, current: false });
  });

  it("marks a chapter noise when its latest Pass A row did not surface it", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.fact(
      { type: "git_hunk", file: "src/b.ts", added: 2, removed: 0, isFormattingOnly: false, isConfigOnly: false, isLockfile: false },
      "fact_b",
    );
    b.jev({ id: "jev_1", changeUnitId: "cu_quiet", clamps: [], pass: "A", output: { shouldSurface: true } });
    b.jev({ id: "jev_2", changeUnitId: "cu_quiet", clamps: [], output: { shouldSurface: false, clamps: [], guardrailSuppression: true } });
    b.jev({ id: "jev_3", changeUnitId: "cu_quiet", clamps: [], pass: "B", output: { attention: "surface" } });
    b.unit({ id: "cu_quiet", files: ["src/b.ts"], evidence: ["fact_b"] });
    expect(fold(b).chapters[0]).toMatchObject({ noise: true, current: true });
  });

  it("lists the steps its validation results attached to", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const run = b.agent({ type: "command_started", command: "pnpm test" });
    b.agent({ type: "command_completed", command: "pnpm test", exitCode: 0, stdout: "", stderr: "" });
    b.validation({ id: "val_1", kind: "test", command: "pnpm test", status: "passed", passed: 3, failed: 0, skipped: 0 });
    b.unit({ id: "cu_1", files: [], validationResults: ["val_1"] });
    expect(fold(b).chapters[0]?.validationStepIds).toEqual([`step:${run}`]);
  });
});

describe("decision steps", () => {
  it("absorbs the supervisor's answer into the decision step, targets the decision id and keeps the step id", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const open = b.decision({ id: "dec-1", title: "Linking policy" });
    const message = b.agent({ type: "agent_message", role: "user", text: "decision:\n  policy: b\n\ninstruction:\n  Use B." });
    const answered = b.decision({
      id: "dec-1",
      title: "Linking policy",
      status: "answered",
      answer: { decisionId: "dec-1", decision: { policy: "b" }, evidence: [] },
    });
    const session = fold(b);
    const step = session.steps.find((candidate) => candidate.kind === "decision");
    expect(step).toMatchObject({ id: `step:${open}`, target: "dec-1", seqs: [open, message, answered], lastSeq: answered });
    expect(step?.decision?.answerSeq).toBe(message);
    expect(session.steps.filter((candidate) => candidate.kind === "instruction").map((candidate) => candidate.firstSeq)).toEqual([1]);
    expect(session.turns[0]?.stepIds).not.toContain(`step:${message}`);
  });

  it("keeps a user message that no answer follows as an instruction", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.decision({ id: "dec-1" });
    const steer = b.agent({ type: "agent_message", role: "user", text: "Also add a test." });
    b.decision({ id: "dec-2" });
    expect(holding(fold(b), steer)?.kind).toBe("instruction");
  });
});

describe("instruction dedupe (spec §6.6)", () => {
  const answer = "decision:\n  policy: b\n\ninstruction:\n  Use B.";
  const answeredRow: DecisionInput = {
    id: "dec-1",
    title: "Linking policy",
    status: "answered",
    answer: { decisionId: "dec-1", decision: { policy: "b" }, evidence: [] },
  };

  it("folds a steer's echoed user message into its relaunch's instruction step", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Add the route." });
    b.agent({ type: "agent_message", role: "assistant", text: "Working on it." });
    b.agent({ type: "agent_interrupted", reason: "steer" });
    const relaunch = b.agent({ type: "agent_started", prompt: "Use the v2 API instead." });
    const echo = b.agent({ type: "agent_message", role: "user", text: "Use the v2 API instead.\n" });
    b.agent({ type: "agent_message", role: "assistant", text: "Switching to v2." });
    // The same words after the agent has acted are a new instruction.
    const again = b.agent({ type: "agent_message", role: "user", text: "Use the v2 API instead." });
    const session = fold(b);
    expect(session.steps.filter((step) => step.kind === "instruction").map((step) => step.seqs)).toEqual([[1], [relaunch, echo], [again]]);
    expect(holding(session, echo)).toMatchObject({ id: `step:${relaunch}`, firstSeq: relaunch, lastSeq: echo, turnIndex: 1 });
    expect(session.turns[1]).toMatchObject({ trigger: "steer", startSeq: relaunch, prompt: "Use the v2 API instead." });
  });

  it("keeps a queued instruction as the instruction item of the turn that delivers it", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Add the route." });
    const queued = b.agent({ type: "agent_message", role: "user", text: "Then add a test." });
    b.agent({ type: "agent_completed" });
    const relaunch = b.agent({ type: "agent_started", prompt: "Then add a test." });
    const session = fold(b);
    expect(session.steps.filter((step) => step.kind === "instruction").map((step) => step.seqs)).toEqual([[1], [queued, relaunch]]);
    // A turn's instruction item is the step holding its startSeq.
    expect(holding(session, relaunch)).toMatchObject({ id: `step:${queued}`, turnIndex: 0 });
    expect(session.turns[1]).toMatchObject({ trigger: "resume", startSeq: relaunch, prompt: "Then add a test." });
  });

  it("opens a decision relaunch's turn without an instruction step, whichever row comes first", () => {
    // sendDecision relaunches with the answer, echoes it, then the answer row lands.
    const live = new TraceBuilder();
    live.agent({ type: "agent_started", prompt: "p" });
    const open = live.decision({ id: "dec-1", title: "Linking policy" });
    const relaunch = live.agent({ type: "agent_started", prompt: answer });
    const echo = live.agent({ type: "agent_message", role: "user", text: answer });
    const answered = live.decision(answeredRow);
    const first = fold(live);
    expect(first.steps.filter((step) => step.kind === "instruction").map((step) => step.firstSeq)).toEqual([1]);
    expect(holding(first, relaunch)).toMatchObject({ id: `step:${open}`, kind: "decision", seqs: [open, relaunch, echo, answered] });
    expect(holding(first, relaunch)?.decision?.answerSeq).toBe(echo);
    expect(first.turns[1]).toMatchObject({ startSeq: relaunch, prompt: "Linking policy" });

    // The answer row lands before a relaunch that delivers the same text.
    const late = new TraceBuilder();
    late.agent({ type: "agent_started", prompt: "p" });
    const open2 = late.decision({ id: "dec-1", title: "Linking policy" });
    const message = late.agent({ type: "agent_message", role: "user", text: answer });
    const answered2 = late.decision(answeredRow);
    const relaunch2 = late.agent({ type: "agent_started", prompt: answer });
    const second = fold(late);
    expect(second.steps.filter((step) => step.kind === "instruction").map((step) => step.firstSeq)).toEqual([1]);
    expect(holding(second, relaunch2)).toMatchObject({ id: `step:${open2}`, seqs: [open2, message, answered2, relaunch2] });
    expect(second.turns[1]).toMatchObject({ startSeq: relaunch2, prompt: "Linking policy" });
  });
});

describe("Finding.anchorStepId and the claim fields", () => {
  it("pins oauth's contradiction to its claim and the failed run, with the claim span", () => {
    const trace = loadFixtureTrace("oauth");
    const session = foldRows(trace.meta, trace.rows, { live: false });
    const finding = session.findings.find((candidate) => candidate.ruleId === "claim_contradicted");
    const claim = session.steps.find((step) => step.text === "OAuth implementation complete; all checks pass.");
    const failed = session.steps.find((step) => step.kind === "test" && step.status === "failed");
    expect(claim).toBeDefined();
    expect(failed).toBeDefined();
    expect(finding).toMatchObject({
      anchorStepId: claim?.id,
      claimStepId: claim?.id,
      evidenceStepIds: [failed?.id],
      claimSpan: [31, 46],
    });
    const [start, end] = finding?.claimSpan ?? [0, 0];
    expect(claim?.text?.slice(start, end)).toBe("all checks pass");
    // ClaimVsObserved underlines the same span (B-10 pickGraphic reads Finding.claimSpan).
    expect(claim && pickGraphic(claim, session)).toMatchObject({ kind: "claim", claim: { span: [31, 46] } });
  });

  it("anchors every finding on a step it names", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "command_started", command: "git reset --hard" });
    b.agent({ type: "command_completed", command: "git reset --hard", exitCode: 0, stdout: "", stderr: "" });
    b.jev({ id: "jev_1", clamps: ["schema_floor"] });
    const trace = loadFixtureTrace("oauth");
    for (const session of [fold(b), foldRows(trace.meta, trace.rows, { live: false })]) {
      expect(session.findings.length).toBeGreaterThan(0);
      for (const finding of session.findings) {
        expect(finding.stepIds, finding.id).toContain(finding.anchorStepId);
        expect(session.steps.some((step) => step.id === finding.anchorStepId), finding.id).toBe(true);
      }
    }
  });
});
