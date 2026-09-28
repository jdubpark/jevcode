import { describe, expect, it } from "vitest";

import { loadFixtureTrace } from "../test-support/fixture-rows.js";
import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { foldRows } from "./fold.js";
import { compareFindings, FINDING_RULE_RANK, isSuccessClaim, SIGNALS, signalMeta } from "./signals.js";
import {
  findingStableId,
  SIGNAL_IDS,
  stepStableId,
  type Finding,
  type Severity,
  type SignalId,
  type TraceSession,
} from "./types.js";

function fold(builder: TraceBuilder, live = false): TraceSession {
  return foldRows(testMeta(), builder.rows, { live });
}

function findingsOf(session: TraceSession, ruleId: SignalId): Finding[] {
  return session.findings.filter((finding) => finding.ruleId === ruleId);
}

function testRun(b: TraceBuilder, passed: number, failed: number, command = "pnpm test"): { start: number; result: number } {
  const start = b.agent({ type: "command_started", command });
  b.agent({ type: "command_completed", command, exitCode: failed > 0 ? 1 : 0, stdout: "", stderr: "" });
  const result = b.fact({ type: "test_result", runner: "vitest", command, passed, failed, skipped: 0, failures: [] });
  return { start, result };
}

function editFile(b: TraceBuilder, file: string, added: number): number {
  return b.fact({ type: "git_hunk", file, added, removed: 0, isFormattingOnly: false, isConfigOnly: false, isLockfile: false });
}

describe("signal registry", () => {
  it("has complete metadata for every signal id", () => {
    for (const id of SIGNAL_IDS) {
      const rule = SIGNALS[id];
      expect(rule.id).toBe(id);
      expect(rule.version).toBeGreaterThanOrEqual(1);
      expect(rule.title.length).toBeGreaterThan(0);
      expect(rule.rationale.length).toBeGreaterThan(0);
      expect(rule.knownFalsePositives.length).toBeGreaterThan(0);
      expect(rule.requires.length).toBeGreaterThan(0);
      expect(signalMeta(id)).not.toHaveProperty("evaluate");
    }
  });

  it("lists guardrail_clamp inactive on a fixture fold", () => {
    const trace = loadFixtureTrace("oauth");
    const session = foldRows(trace.meta, trace.rows, { live: false });
    expect(session.coverage.signals).toContainEqual({ id: "guardrail_clamp", active: false, missing: ["jev_decisions"] });
    expect(session.coverage.signals.map((signal) => signal.id)).toEqual([...SIGNAL_IDS]);
  });
});

describe("success claim lexicon", () => {
  it.each([
    ["OAuth implementation complete; all checks pass.", true],
    ["The endpoint change is complete and all tests pass.", true],
    ["143 tests pass (128 existing, 12 new).", true],
    ["All tests pass with no failures.", true],
    ["Not all tests pass yet.", false],
    ["Tests pass except the flaky one.", false],
    ["I haven't finished the migration.", false],
    ["Dependencies swapped; formatting noise included.", false],
    ["Running the tests now.", false],
    ["The migration is done.", true],
    ["I'm done reading the file, next I will complete the setup.", false],
    ["The migration is not complete.", false],
  ])("%s -> %s", (text, expected) => {
    expect(isSuccessClaim(text)).toBe(expected);
  });
});

describe("claim_contradicted", () => {
  it("fires when the last success claim follows a failed run and cites both rows", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const run = testRun(b, 14, 1);
    const claim = b.agent({ type: "agent_message", role: "assistant", text: "Done; all checks pass." });
    const session = fold(b);
    const [finding] = findingsOf(session, "claim_contradicted");
    expect(finding).toMatchObject({
      id: `finding:claim_contradicted@1:${claim}`,
      severity: "critical",
      anchorSeq: claim,
      anchorStepId: `step:${claim}`,
      evidenceSeqs: [run.result, claim],
      stepIds: [`step:${run.start}`, `step:${claim}`],
    });
    expect(finding?.claim?.claim).toMatchObject({ seq: claim, stepId: `step:${claim}`, text: "Done; all checks pass." });
    expect(finding?.claim?.observed).toMatchObject({ seq: run.result, passed: 14, failed: 1, command: "pnpm test" });
    const claimStep = session.steps.find((step) => step.firstSeq === claim);
    expect(claimStep?.problems).toEqual(["claim_contradicted"]);
    expect(claimStep?.findingIds).toEqual([finding?.id]);
  });

  it("does not fire on a negated claim or after a later passing run", () => {
    const negated = new TraceBuilder();
    negated.agent({ type: "agent_started", prompt: "p" });
    testRun(negated, 14, 1);
    negated.agent({ type: "agent_message", role: "assistant", text: "Not all tests pass yet." });
    expect(findingsOf(fold(negated), "claim_contradicted")).toEqual([]);

    const fixed = new TraceBuilder();
    fixed.agent({ type: "agent_started", prompt: "p" });
    testRun(fixed, 14, 1);
    testRun(fixed, 15, 0);
    fixed.agent({ type: "agent_message", role: "assistant", text: "All tests pass." });
    expect(findingsOf(fold(fixed), "claim_contradicted")).toEqual([]);
  });

  it("compares with the latest run of every command, so a later passing check does not hide a failed test run", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const tests = testRun(b, 14, 1);
    b.agent({ type: "command_started", command: "pnpm lint" });
    b.agent({ type: "command_completed", command: "pnpm lint", exitCode: 0, stdout: "", stderr: "" });
    const claim = b.agent({ type: "agent_message", role: "assistant", text: "All checks pass." });
    const [finding] = findingsOf(fold(b), "claim_contradicted");
    expect(finding).toMatchObject({
      anchorSeq: claim,
      evidenceSeqs: [tests.result, claim],
      stepIds: [`step:${tests.start}`, `step:${claim}`],
    });
    expect(finding?.claim?.observed).toMatchObject({ command: "pnpm test", failed: 1 });
  });

  it("does not count a failed command that only mentions a check word as a failed check", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    testRun(b, 5, 0);
    const grep = b.agent({ type: "command_started", command: "grep -r build src" });
    b.agent({ type: "command_completed", command: "grep -r build src", exitCode: 1, stdout: "", stderr: "" });
    b.agent({ type: "agent_message", role: "assistant", text: "All checks pass." });
    const session = fold(b);
    expect(session.steps.find((step) => step.firstSeq === grep)).toMatchObject({ kind: "command", problems: ["exit_nonzero"] });
    expect(findingsOf(session, "claim_contradicted")).toEqual([]);
  });

  it("fires on oauth and api-break and not on the green fixtures", () => {
    const fired = (name: "oauth" | "api-break" | "rate-limit" | "schema-change" | "dep-change") => {
      const trace = loadFixtureTrace(name);
      return findingsOf(foldRows(trace.meta, trace.rows, { live: false }), "claim_contradicted").length;
    };
    expect(fired("oauth")).toBe(1);
    expect(fired("api-break")).toBe(1);
    expect(fired("rate-limit")).toBe(0);
    expect(fired("schema-change")).toBe(0);
    expect(fired("dep-change")).toBe(0);
  });
});

describe("failing_tests", () => {
  it("is critical when the final run still fails and a warning when a later run passed", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const fixedRun = testRun(b, 4, 1, "pnpm test");
    testRun(b, 5, 0, "pnpm test");
    const brokenRun = testRun(b, 1, 2, "pnpm test:e2e");
    const session = fold(b);
    const findings = findingsOf(session, "failing_tests");
    expect(findings.map((finding) => [finding.anchorSeq, finding.severity])).toEqual([
      [fixedRun.result, "warning"],
      [brokenRun.result, "critical"],
    ]);
  });

  it("does not treat an unknown exit code as a failing test", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "command_started", command: "pnpm test" });
    b.agent({ type: "command_completed", command: "pnpm test", exitCode: -1, stdout: "", stderr: "" });
    b.fact({ type: "test_result", runner: "vitest", command: "pnpm test", passed: 0, failed: 0, skipped: 0, failures: [] });
    expect(findingsOf(fold(b), "failing_tests")).toEqual([]);
  });
});

describe("destructive_command", () => {
  it("fires on a matched pattern and names it", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const seq = b.agent({ type: "command_started", command: "git reset --hard HEAD~1" });
    b.agent({ type: "command_completed", command: "git reset --hard HEAD~1", exitCode: 0, stdout: "", stderr: "" });
    const [finding] = findingsOf(fold(b), "destructive_command");
    expect(finding).toMatchObject({ anchorSeq: seq, severity: "critical", matchedPattern: "git-reset-hard" });
  });

  it("does not fire on a plain git reset", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "command_started", command: "git reset HEAD src/a.ts" });
    b.agent({ type: "command_completed", command: "git reset HEAD src/a.ts", exitCode: 0, stdout: "", stderr: "" });
    expect(findingsOf(fold(b), "destructive_command")).toEqual([]);
  });
});

describe("guardrail_clamp", () => {
  it("raises one finding per row at its most severe clamp", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const severe = b.jev({ id: "j1", changeUnitId: "cu_1", clamps: ["suppress_lockfile", "destructive_command"] });
    const warning = b.jev({ id: "j2", changeUnitId: "cu_1", clamps: ["guardrail.security", "public_api"] });
    b.unit({ id: "cu_1", files: [] });
    const session = fold(b);
    const findings = findingsOf(session, "guardrail_clamp");
    expect(findings.map((finding) => [finding.anchorSeq, finding.severity, finding.clampId, finding.headline])).toEqual([
      [severe, "critical", "destructive_command", "Destructive command"],
      [warning, "warning", "public_api", "Public API change kept visible"],
    ]);
    expect(findings[0]?.chapterIds).toEqual(["unit:cu_1"]);
    expect(session.chapters[0]?.findingIds).toEqual(findings.map((finding) => finding.id));
  });

  it("raises none for a row whose clamps are all info, including an unknown id, and lets its step collapse", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const routine = b.jev({ id: "j1", changeUnitId: "cu_1", clamps: ["suppress_formatting", "suppress_lockfile"] });
    const unknown = b.jev({ id: "j2", changeUnitId: "cu_1", clamps: ["guardrail.security"] });
    b.unit({ id: "cu_1", files: [] });
    const session = fold(b);
    expect(session.coverage.signals).toContainEqual({ id: "guardrail_clamp", active: true, missing: [] });
    expect(findingsOf(session, "guardrail_clamp")).toEqual([]);
    for (const seq of [routine, unknown]) {
      expect(session.steps.find((step) => step.firstSeq === seq)).toMatchObject({
        kind: "guardrail",
        problems: [],
        findingIds: [],
        noise: "lifecycle",
      });
    }
    expect(session.chapters[0]?.findingIds).toEqual([]);
  });
});

describe("recovery_arc", () => {
  it("fires on fail, edit, then the same command passing", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const failed = testRun(b, 4, 1);
    const edit = editFile(b, "src/fix.ts", 3);
    const passed = testRun(b, 5, 0);
    const [finding] = findingsOf(fold(b), "recovery_arc");
    expect(finding).toMatchObject({
      anchorSeq: passed.result,
      severity: "info",
      stepIds: [`step:${failed.start}`, `step:${edit}`, `step:${passed.start}`],
      evidenceSeqs: [failed.result, passed.result],
    });
  });

  it("does not fire when nothing was edited between the failure and the pass", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    testRun(b, 4, 1);
    testRun(b, 5, 0);
    expect(findingsOf(fold(b), "recovery_arc")).toEqual([]);
  });

  it("keeps the passing run of an arc from collapsing", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    testRun(b, 4, 1);
    editFile(b, "src/fix.ts", 3);
    const passed = testRun(b, 5, 0);
    testRun(b, 5, 0);
    const step = fold(b).steps.find((candidate) => candidate.firstSeq === passed.start);
    expect(step?.findingIds).toHaveLength(1);
    expect(step?.noise).toBeNull();
  });
});

describe("finding order and anchors", () => {
  function finding(ruleId: SignalId, severity: Severity, anchorSeq: number): Finding {
    return {
      id: findingStableId(ruleId, 1, anchorSeq),
      ruleId,
      ruleVersion: 1,
      severity,
      anchorSeq,
      anchorStepId: stepStableId(anchorSeq),
      headline: "",
      reason: "",
      stepIds: [stepStableId(anchorSeq)],
      chapterIds: [],
      evidenceSeqs: [anchorSeq],
    };
  }

  it("sorts by severity, then rule rank, then anchor seq (spec §6.7 FINDING_ORDER)", () => {
    expect(Object.keys(FINDING_RULE_RANK).sort()).toEqual([...SIGNAL_IDS].sort());
    const input = [
      finding("recovery_arc", "info", 1),
      finding("failing_tests", "critical", 46),
      finding("guardrail_clamp", "warning", 3),
      finding("claim_contradicted", "critical", 48),
      finding("destructive_command", "critical", 50),
      finding("failing_tests", "critical", 12),
      finding("guardrail_clamp", "critical", 2),
    ];
    expect([...input].sort(compareFindings).map((item) => item.id)).toEqual([
      "finding:claim_contradicted@1:48",
      "finding:destructive_command@1:50",
      "finding:failing_tests@1:12",
      "finding:failing_tests@1:46",
      "finding:guardrail_clamp@1:2",
      "finding:guardrail_clamp@1:3",
      "finding:recovery_arc@1:1",
    ]);
  });

  it("puts the contradiction first on oauth and api-break, where failing_tests is also critical and earlier", () => {
    for (const name of ["oauth", "api-break"] as const) {
      const trace = loadFixtureTrace(name);
      const findings = foldRows(trace.meta, trace.rows, { live: false }).findings;
      expect(findings.map((item) => [item.ruleId, item.severity]), name).toEqual([
        ["failing_tests", "critical"],
        ["claim_contradicted", "critical"],
      ]);
      expect([...findings].sort(compareFindings)[0]?.ruleId, name).toBe("claim_contradicted");
    }
  });

  it("anchors every finding on the step that holds its anchor seq", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    testRun(b, 4, 1);
    editFile(b, "src/fix.ts", 3);
    testRun(b, 5, 0);
    b.agent({ type: "command_started", command: "rm -rf dist" });
    b.agent({ type: "command_completed", command: "rm -rf dist", exitCode: 0, stdout: "", stderr: "" });
    b.jev({ id: "j1", clamps: ["schema_floor"] });
    const fixtures = (["oauth", "api-break"] as const).map((name) => {
      const trace = loadFixtureTrace(name);
      return foldRows(trace.meta, trace.rows, { live: false });
    });
    const rules = new Set<SignalId>();
    for (const session of [fold(b), ...fixtures]) {
      for (const item of session.findings) {
        rules.add(item.ruleId);
        const anchor = session.steps.find((step) => step.id === item.anchorStepId);
        expect(anchor?.seqs, item.id).toContain(item.anchorSeq);
        expect(item.stepIds, item.id).toContain(item.anchorStepId);
      }
    }
    expect([...rules].sort()).toEqual([...SIGNAL_IDS].sort());
  });
});
