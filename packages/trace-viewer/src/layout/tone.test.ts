import { describe, expect, it } from "vitest";

import { buildSession } from "../test-support/session-builder.js";
import { findingTone, stepTone, worstSeverity } from "./tone.js";
import { buildTraceIndex } from "./trace-index.js";

const session = buildSession({
  steps: [
    { kind: "command", tMs: 0, target: "grep -r TODO", status: "failed" },
    { kind: "test", tMs: 1_000, target: "pnpm test", status: "failed", tests: { passed: 14, failed: 1, skipped: 0 } },
    { kind: "test", tMs: 2_000, target: "pnpm test", tests: { passed: 15, failed: 0, skipped: 0 } },
    { kind: "command", tMs: 3_000, target: "pnpm dev", status: "unknown" },
    { kind: "command", tMs: 4_000, target: "rm -rf dist" },
    { kind: "guardrail", tMs: 5_000, problems: ["guardrail"] },
    { kind: "guardrail", tMs: 6_000 },
    { kind: "lifecycle", tMs: 7_000, status: "failed", problems: ["agent_failed"] },
    { kind: "message", tMs: 8_000, text: "done" },
  ],
  findings: [
    { ruleId: "destructive_command", severity: "critical", step: 4 },
    { ruleId: "guardrail_clamp", severity: "warning", step: 4 },
  ],
});
const { findingsById } = buildTraceIndex(session);
const step = (i: number) => {
  const s = session.steps[i];
  if (s === undefined) throw new Error("missing step");
  return s;
};

describe("tone (spec §6.8 toneOf)", () => {
  it("a command with exit 1 is neutral", () => expect(stepTone(step(0), findingsById)).toBe("neutral"));
  it("a failed test is bad and a passing test is good", () => {
    expect(stepTone(step(1), findingsById)).toBe("bad");
    expect(stepTone(step(2), findingsById)).toBe("good");
  });
  it("exit -1 (unknown) is neutral", () => expect(stepTone(step(3), findingsById)).toBe("neutral"));
  it("a step anchoring a critical finding is bad", () => expect(stepTone(step(4), findingsById)).toBe("bad"));
  it("a guardrail hit is bad, an info clamp neutral, an agent failure bad", () => {
    expect(stepTone(step(5), findingsById)).toBe("bad");
    expect(stepTone(step(6), findingsById)).toBe("neutral");
    expect(stepTone(step(7), findingsById)).toBe("bad");
    expect(stepTone(step(8), findingsById)).toBe("neutral");
  });
  it("worstSeverity picks critical over warning; findingTone is bad only for critical", () => {
    expect(worstSeverity(step(4), findingsById)).toBe("critical");
    expect(worstSeverity(step(8), findingsById)).toBeNull();
    const critical = session.findings.find((f) => f.ruleId === "destructive_command");
    const warning = session.findings.find((f) => f.ruleId === "guardrail_clamp");
    expect(critical === undefined ? "missing" : findingTone(critical)).toBe("bad");
    expect(warning === undefined ? "missing" : findingTone(warning)).toBe("neutral");
  });
});
