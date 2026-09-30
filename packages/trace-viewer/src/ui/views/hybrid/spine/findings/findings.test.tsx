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
    render(
      <>
        <FindingBody finding={finding} step={stepOf(session, finding)} session={session} onJump={onJump} part="header" />
        <FindingBody finding={finding} step={stepOf(session, finding)} session={session} onJump={onJump} />
      </>,
    );
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

  it("marks bidi characters in a failing test's name", () => {
    const base = foldFixture("oauth");
    const session: TraceSession = {
      ...base,
      steps: base.steps.map((step) =>
        step.tests === undefined
          ? step
          : { ...step, tests: { ...step.tests, failures: step.tests.failures.map((failure) => ({ ...failure, testName: "spoof‮name" })) } },
      ),
    };
    const finding = session.findings.find((item) => item.ruleId === "failing_tests");
    if (finding === undefined) throw new Error("no failing_tests finding");
    render(<FindingBody finding={finding} step={stepOf(session, finding)} session={session} onJump={() => undefined} />);
    expect(screen.getByText("spoof⟨U+202E⟩name")).toBeTruthy();
  });

  it("keeps every control inside a finding body out of the tab order", () => {
    const session = foldFixture("oauth");
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Clean" });
    b.agent({ type: "command_started", command: "rm -rf build" });
    b.agent({ type: "command_completed", command: "rm -rf build", exitCode: 0, stdout: "", stderr: "" });
    const destructiveSession = foldRows(testMeta(), b.rows, { live: false });
    const command = destructiveSession.steps.find((item) => item.kind === "command");
    const bodies = [
      ...session.findings.map((finding) => ({ finding, step: stepOf(session, finding), session })),
      {
        finding: synthetic(destructiveSession, {
          ruleId: "destructive_command",
          matchedPattern: "rm_rf",
          anchorStepId: command?.id ?? "step:1",
          stepIds: [command?.id ?? "step:1"],
        }),
        step: command ?? destructiveSession.steps[0]!,
        session: destructiveSession,
      },
      {
        finding: synthetic(session, { ruleId: "recovery_arc", severity: "info", stepIds: session.steps.slice(0, 3).map((step) => step.id) }),
        step: session.steps[0]!,
        session,
      },
    ];
    for (const props of bodies) {
      const { container } = render(<FindingBody {...props} onJump={() => undefined} />);
      for (const node of container.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, summary, [tabindex]")) {
        expect(node.getAttribute("tabindex"), `${props.finding.ruleId} ${node.tagName}`).toBe("-1");
      }
      cleanup();
    }
  });

  it("states the claim gap as text a screen reader reads", () => {
    const session = foldFixture("oauth");
    const finding = session.findings.find((item) => item.ruleId === "claim_contradicted");
    if (finding === undefined) throw new Error("no claim finding");
    render(<FindingBody finding={finding} step={stepOf(session, finding)} session={session} onJump={() => undefined} part="header" />);
    expect(screen.getByText("Claim made 3.0 s after the failing run")).toBeTruthy();
  });

  it("labels recovery buttons with the step outcome and offset", () => {
    const session = foldFixture("oauth");
    const ids = session.steps.slice(0, 3).map((step) => step.id);
    const recovery = synthetic(session, { ruleId: "recovery_arc", severity: "info", stepIds: ids });
    render(<FindingBody finding={recovery} step={session.steps[0]!} session={session} onJump={() => undefined} />);
    const labels = screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"));
    expect(labels).toHaveLength(3);
    for (const label of labels) expect(label).toMatch(/^Go to [a-z]+ step at \+\d+:\d\d/);
  });

  it("labels a recovery step by its real kind, not as a pass", () => {
    const base = foldFixture("oauth");
    const other = base.steps.filter((step) => step.kind !== "edit" && step.kind !== "test" && step.status !== "failed").slice(0, 2);
    const passingSource = base.steps.find((step) => step.kind === "test") ?? base.steps[0]!;
    const passing = { ...passingSource, kind: "test" as const, status: "ok" as const };
    expect(other).toHaveLength(2);
    const session = { ...base, steps: base.steps.map((step) => (step.id === passing.id ? passing : step)) };
    const steps = [...other, passing];
    const recovery = synthetic(session, { ruleId: "recovery_arc", severity: "info", stepIds: steps.map((step) => step.id) });
    render(<FindingBody finding={recovery} step={session.steps[0]!} session={session} onJump={() => undefined} />);
    const labels = screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"));
    expect(labels[0]).toMatch(new RegExp(`^Go to ${other[0]!.kind} step at `));
    expect(labels[1]).toMatch(new RegExp(`^Go to ${other[1]!.kind} step at `));
    expect(labels[2]).toMatch(/^Go to pass step at /);
  });
});
