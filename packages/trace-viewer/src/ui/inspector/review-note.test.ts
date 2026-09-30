import { describe, expect, it } from "vitest";

import { buildTraceIndex } from "../../layout/trace-index.js";
import type { TraceSession } from "../../model/index.js";
import { fixtureTrace, foldFixture, payloadOf } from "../../test-support/ui-harness.js";
import { buildReviewNote, fenceFor, inlineCode } from "./review-note.js";

describe("fenceFor and inlineCode", () => {
  it("fences with a run one longer than the longest inside, minimum 3", () => {
    expect(fenceFor("plain text")).toBe("```");
    expect(fenceFor("a ``` b")).toBe("````");
    expect(fenceFor("x ````` y")).toBe("``````");
  });

  it("delimits inline code with a longer run and shows newlines as ⏎", () => {
    expect(inlineCode("pnpm test")).toBe("`pnpm test`");
    expect(inlineCode("a`b")).toBe("``a`b``");
    expect(inlineCode("`x")).toBe("`` `x ``");
    expect(inlineCode("a\nb\r\nc")).toBe("`a⏎b⏎c`");
  });
});

describe("buildReviewNote", () => {
  it("names oauth's claim and its evidence seq, located by content", () => {
    const { rows } = fixtureTrace("oauth");
    const claimSeq = rows.find(
      (row) => row.type === "agent_event" && payloadOf(row).text === "OAuth implementation complete; all checks pass.",
    )?.seq;
    const evidenceSeq = rows.find((row) => row.type === "evidence_fact" && payloadOf(row).type === "test_result")?.seq;
    expect(claimSeq).toBeDefined();
    expect(evidenceSeq).toBeDefined();
    const session = foldFixture("oauth");
    const claimStep = session.steps.find((step) => step.seqs.includes(claimSeq ?? -1));
    const note = buildReviewNote(session, buildTraceIndex(session), claimStep?.id ?? "step:1");
    expect(note.firstLine).toBe(
      `Re: trace ${session.meta.sessionId} +0:43 "Claim contradicts tests" (seq ${claimSeq}; evidence seq ${evidenceSeq})`,
    );
    const lines = note.markdown.split("\n");
    expect(lines[0]).toBe(note.firstLine);
    expect(lines[1]).toBe(`Session: ${session.meta.repoName} / ${session.meta.prompt.split("\n")[0] ?? ""}`);
    expect(note.markdown).toContain("Claim:\n```\nOAuth implementation complete; all checks pass.\n```");
    expect(lines.some((line) => line.startsWith("Observed: `pnpm test"))).toBe(true);
    expect(lines.some((line) => line.startsWith("Paths: ") && line.includes("`tests/auth/oauth.test.ts`"))).toBe(true);
  });

  it("fences quoted text longer than any backtick run inside it", () => {
    const base = foldFixture("oauth");
    const hostile = "Done.\n```\n# Injected heading\n```\nall checks pass";
    const session: TraceSession = {
      ...base,
      findings: base.findings.map((finding) =>
        finding.ruleId === "claim_contradicted" && finding.claim !== undefined
          ? { ...finding, claim: { ...finding.claim, claim: { ...finding.claim.claim, text: hostile } } }
          : finding,
      ),
    };
    const claim = session.findings.find((finding) => finding.ruleId === "claim_contradicted");
    expect(claim).toBeDefined();
    const note = buildReviewNote(session, buildTraceIndex(session), claim?.anchorStepId ?? "step:1");
    const lines = note.markdown.split("\n");
    const open = lines.indexOf("Claim:") + 1;
    expect(lines[open]).toBe("````");
    const close = lines.indexOf("````", open + 1);
    expect(close).toBeGreaterThan(open);
    expect(lines.slice(open + 1, close)).toContain("# Injected heading");
  });

  it("shows a bidi override in a path as a visible token", () => {
    const base = foldFixture("oauth");
    const edit = base.steps.find((step) => step.edit !== undefined);
    expect(edit?.edit).toBeDefined();
    const session: TraceSession = {
      ...base,
      steps: base.steps.map((step) =>
        step.id === edit?.id && step.edit !== undefined ? { ...step, edit: { ...step.edit, path: "src/\u202Etxt.exe" } } : step,
      ),
    };
    const note = buildReviewNote(session, buildTraceIndex(session), edit?.id ?? "step:1");
    expect(note.markdown).toContain("⟨U+202E⟩");
    expect(note.markdown).not.toContain("\u202E");
  });

  it("keeps the Session line and claim on visible tokens and single lines", () => {
    const base = foldFixture("oauth");
    const session: TraceSession = {
      ...base,
      meta: { ...base.meta, repoName: "repo\u202Ex\u2028y", prompt: "Do it\u2029## Injected\nsecond" },
      findings: base.findings.map((finding) =>
        finding.ruleId === "claim_contradicted" && finding.claim !== undefined
          ? { ...finding, claim: { ...finding.claim, claim: { ...finding.claim.claim, text: "ok\u202Efdp" } } }
          : finding,
      ),
    };
    const claim = session.findings.find((finding) => finding.ruleId === "claim_contradicted");
    const note = buildReviewNote(session, buildTraceIndex(session), claim?.anchorStepId ?? "step:1");
    const lines = note.markdown.split(/\n/);
    expect(lines[1]).toBe("Session: repo⟨U+202E⟩x⏎y / Do it");
    expect(note.markdown).not.toMatch(/[\u202E\u2028\u2029]/);
    expect(note.markdown).toContain("ok⟨U+202E⟩fdp");
  });
});
