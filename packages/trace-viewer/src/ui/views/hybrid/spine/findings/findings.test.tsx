// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { foldRows, SIGNAL_IDS, type Finding, type TraceSession } from "../../../../../model/index.js";
import { TraceBuilder, testMeta } from "../../../../../test-support/trace-builder.js";
import { foldFixture } from "../../../../../test-support/ui-harness.js";
import { FINDING_BODY, FindingBody } from "./FindingBody.js";

afterEach(() => {
  cleanup();
});

function stepOf(session: TraceSession, finding: Finding) {
  const step = session.steps.find((item) => item.id === finding.anchorStepId);
  if (step === undefined) throw new Error("finding has no anchor step");
  return step;
}

function synthetic(session: TraceSession, overrides: Partial<Finding> & Pick<Finding, "ruleId">): Finding {
  const step = session.steps[1] ?? session.steps[0];
  if (step === undefined) throw new Error("empty session");
  return {
    id: `finding:${overrides.ruleId}@1:${step.firstSeq}`,
    ruleVersion: 1,
    severity: "warning",
    anchorSeq: step.firstSeq,
    headline: "synthetic",
    reason: "Synthetic reason for the test.",
    stepIds: [step.id],
    chapterIds: [],
    evidenceSeqs: [],
    anchorStepId: step.id,
    ...overrides,
  };
}

describe("FINDING_BODY", () => {
  it("covers every signal", () => {
    expect(Object.keys(FINDING_BODY).sort()).toEqual([...SIGNAL_IDS].sort());
  });

  it("shows oauth's claim chain, the underlined span, and jumps to the evidence", () => {
    const session = foldFixture("oauth");
    const finding = session.findings.find((item) => item.ruleId === "claim_contradicted");
    expect(finding).toBeDefined();
    if (finding === undefined) return;
    const onJump = vi.fn();
    render(<FindingBody finding={finding} step={stepOf(session, finding)} session={session} onJump={onJump} />);
    expect(screen.getByText("3.0 s")).toBeTruthy();
    expect(screen.getAllByText("all checks pass").length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByText(/1 failed/)[0] as HTMLElement);
    const evidence = session.steps.find((step) => step.command?.command === "pnpm test");
    expect(onJump).toHaveBeenCalledWith(evidence?.id);
  });

  it("lists failing tests with their names", () => {
    const session = foldFixture("oauth");
    const finding = session.findings.find((item) => item.ruleId === "failing_tests");
    expect(finding).toBeDefined();
    if (finding === undefined) return;
    const failure = session.steps.find((step) => step.tests !== undefined)?.tests?.failures[0];
    render(<FindingBody finding={finding} step={stepOf(session, finding)} session={session} onJump={() => undefined} />);
    expect(screen.getByText(failure?.testName ?? "missing")).toBeTruthy();
  });

  it("explains a destructive command", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Clean" });
    b.agent({ type: "command_started", command: "rm -rf build" });
    b.agent({ type: "command_completed", command: "rm -rf build", exitCode: 0, stdout: "", stderr: "" });
    const session = foldRows(testMeta(), b.rows, { live: false });
    const step = session.steps.find((item) => item.kind === "command");
    const finding = synthetic(session, {
      ruleId: "destructive_command",
      severity: "critical",
      matchedPattern: "rm_rf",
      anchorStepId: step?.id ?? "step:1",
      stepIds: [step?.id ?? "step:1"],
    });
    render(<FindingBody finding={finding} step={step ?? session.steps[0]!} session={session} onJump={() => undefined} />);
    expect(screen.getByText("rm -rf build")).toBeTruthy();
    expect(screen.getByText("Matched rule: rm_rf")).toBeTruthy();
    expect(screen.getByText("Why flagged?")).toBeTruthy();
  });

  it("names the clamp of a guardrail finding and the steps of a recovery", () => {
    const session = foldFixture("oauth");
    const guard = synthetic(session, { ruleId: "guardrail_clamp", clampId: "destructive_command" });
    render(<FindingBody finding={guard} step={session.steps[1]!} session={session} onJump={() => undefined} />);
    expect(screen.getByText("Synthetic reason for the test.")).toBeTruthy();
    cleanup();

    const ids = session.steps.slice(0, 3).map((step) => step.id);
    const recovery = synthetic(session, { ruleId: "recovery_arc", severity: "info", stepIds: ids });
    render(<FindingBody finding={recovery} step={session.steps[0]!} session={session} onJump={() => undefined} />);
    expect(document.querySelectorAll("[data-recovery-step]")).toHaveLength(3);
  });
});
