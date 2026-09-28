import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { TraceSession } from "../model/index.js";
import { arbTraceSession } from "./arbitraries.js";
import { buildSession, LANE_OF_KIND, largeSession, OAUTH_CLAIM_TEXT, oauthLikeSession } from "./session-builder.js";

function sortedBySeqThenId<T extends { id: string }>(items: readonly T[], seqOf: (item: T) => number): boolean {
  return items.every((item, i) => {
    const prev = items[i - 1];
    if (prev === undefined) return true;
    return seqOf(prev) < seqOf(item) || (seqOf(prev) === seqOf(item) && prev.id <= item.id);
  });
}

function checkInvariants(session: TraceSession): void {
  const ids = new Set<string>();
  let prevT = 0;
  for (const step of session.steps) {
    expect(ids.has(step.id)).toBe(false);
    ids.add(step.id);
    expect(step.id).toBe(`step:${step.firstSeq}`);
    expect(step.seqs[0]).toBe(step.firstSeq);
    expect(step.seqs.at(-1)).toBe(step.lastSeq);
    expect(step.tMs).toBeGreaterThanOrEqual(prevT);
    prevT = step.tMs;
    expect(step.lane).toBe(LANE_OF_KIND[step.kind]);
    expect(step.startMs).toBe(session.originMs + step.tMs);
    if (step.problems.length > 0 || step.findingIds.length > 0) expect(step.noise).toBeNull();
  }
  expect(sortedBySeqThenId(session.steps, (s) => s.firstSeq)).toBe(true);
  expect(sortedBySeqThenId(session.chapters, (c) => c.firstSeq)).toBe(true);
  expect(sortedBySeqThenId(session.findings, (f) => f.anchorSeq)).toBe(true);
  for (const finding of session.findings) {
    const anchor = session.steps.find((s) => s.id === finding.anchorStepId);
    expect(anchor?.seqs).toContain(finding.anchorSeq);
    expect(anchor?.findingIds).toContain(finding.id);
  }
  const last = session.steps.at(-1);
  expect(session.loadedThroughSeq).toBeGreaterThanOrEqual(last?.lastSeq ?? 0);
  expect(session.meta.lastEventSeq).toBe(session.loadedThroughSeq);
}

describe("buildSession", () => {
  it("assigns seqs in order, step ids, lanes and display times", () => {
    const session = buildSession({
      steps: [
        { kind: "instruction", tMs: 0, text: "Do it" },
        { kind: "command", tMs: 2_000, target: "pnpm test", rows: 3 },
        { kind: "message", tMs: 1_000, text: "earlier ts is clamped" },
      ],
    });
    expect(session.steps.map((s) => s.id)).toEqual(["step:1", "step:2", "step:5"]);
    expect(session.steps.map((s) => s.tMs)).toEqual([0, 2_000, 2_000]);
    expect(session.steps[1]?.command).toEqual({ command: "pnpm test", exitCode: 0 });
    expect(session.steps[1]?.lane).toBe("commands");
    expect(session.loadedThroughSeq).toBe(5);
    checkInvariants(session);
  });

  it("never marks a step with a problem or finding as noise", () => {
    const session = buildSession({
      steps: [{ kind: "command", tMs: 0, target: "rm -rf dist", noise: "duplicate_poll" }],
      findings: [{ ruleId: "destructive_command", severity: "critical", step: 0 }],
    });
    expect(session.steps[0]?.noise).toBeNull();
    expect(session.steps[0]?.problems).toContain("destructive");
  });

  it("mirrors oauth: one failed test step 14/1/0 at +0:35 for 5.0 s and the contradicted claim at +0:43", () => {
    const session = oauthLikeSession();
    checkInvariants(session);
    const tests = session.steps.filter((s) => s.kind === "test");
    expect(tests).toHaveLength(1);
    expect(tests[0]).toMatchObject({ tMs: 35_000, durationMs: 5_000, status: "failed", tests: { passed: 14, failed: 1, skipped: 0 } });
    const claim = session.steps.find((s) => s.text === OAUTH_CLAIM_TEXT);
    expect(claim?.tMs).toBe(43_000);
    const contradiction = session.findings.find((f) => f.ruleId === "claim_contradicted");
    expect(contradiction).toMatchObject({ severity: "critical", anchorStepId: claim?.id, claimStepId: claim?.id, evidenceStepIds: [tests[0]?.id] });
    const span = contradiction?.claimSpan;
    expect(span === undefined ? "" : OAUTH_CLAIM_TEXT.slice(span[0], span[1])).toBe("all checks pass");
    expect(session.chapters).toHaveLength(7);
    expect(session.chapters.filter((c) => c.noise)).toHaveLength(2);
    expect(session.chapters.find((c) => c.title === "Linking test")?.tMs).toBe(33_000);
    expect(session.steps.filter((s) => s.kind === "decision")).toHaveLength(1);
    expect(session.turns[0]?.claimStepId).toBe(claim?.id);
  });

  it("largeSession builds 60 chapters over 5k steps deterministically", () => {
    const a = largeSession();
    expect(a.steps).toHaveLength(5_000);
    expect(a.chapters).toHaveLength(60);
    expect(largeSession().steps.map((s) => s.tMs)).toEqual(a.steps.map((s) => s.tMs));
    checkInvariants(a);
  });

  it("arbitrary sessions satisfy the W0 invariants", () => {
    fc.assert(fc.property(arbTraceSession({ maxSteps: 60, maxChapters: 5, maxTurns: 3 }), (session) => {
      checkInvariants(session);
    }), { numRuns: 100 });
  });
});
