import { EvidenceFactSchema, NormalizedAgentEventSchema } from "@jevcode/contracts";
import type { EvidenceFact, NormalizedAgentEvent, TraceRow } from "@jevcode/contracts";
import { foldRows } from "@jevcode/trace-viewer/model";
import { describe, expect, it } from "vitest";

import { SMOKE_SCRIPT_DEFAULTS, smokeMockScript } from "./smoke-script.js";

const INPUT = { sessionId: "sess_smoke", repoId: "repo_1", repoPath: "/tmp/repo", prompt: "Smoke" };

/** The script as the trace a viewer reads: agent events and evidence facts in entry order, seq 1, 2, 3, … */
function traceOf(script: ReturnType<typeof smokeMockScript>): TraceRow[] {
  return script.entries.map((entry, index): TraceRow => {
    const seq = index + 1;
    if (entry.kind === "agent") return { seq, type: "agent_event", ts: entry.event.ts, payload: entry.event };
    if (entry.kind === "record") {
      const fact = entry.record as EvidenceFact;
      return { seq, type: "evidence_fact", ts: fact.ts, factId: `fact_${seq}`, payload: fact };
    }
    throw new Error(`unexpected ${entry.kind} entry`);
  });
}

describe("smokeMockScript", () => {
  it("emits per step a message, an edit claim with its git_hunk and a test command with its vitest result, spaced evenly", () => {
    const script = smokeMockScript(INPUT, { steps: 3, spacingMs: 150 });
    expect(script.entries).toHaveLength(3 * 6 + 1);
    for (const entry of script.entries) {
      expect(entry.delayMs).toBe(150);
      if (entry.kind === "agent") {
        expect(NormalizedAgentEventSchema.safeParse(entry.event).success).toBe(true);
        expect(entry.event.sessionId).toBe("sess_smoke");
      } else {
        expect(entry.kind).toBe("record");
        if (entry.kind === "record") {
          expect(EvidenceFactSchema.safeParse(entry.record).success).toBe(true);
          expect(entry.record).toMatchObject({ sessionId: "sess_smoke", repoId: "repo_1" });
        }
      }
    }
    const kinds = script.entries.slice(0, 6).map((entry) => {
      if (entry.kind === "agent") return (entry.event as NormalizedAgentEvent).type;
      return entry.kind === "record" ? (entry.record as EvidenceFact).type : entry.kind;
    });
    expect(kinds).toEqual(["agent_message", "file_changed", "git_hunk", "command_started", "command_completed", "test_result"]);
    const last = script.entries.at(-1);
    expect(last?.kind === "agent" ? last.event.type : null).toBe("agent_completed");
    expect(script.prompt).toBe("Smoke");
  });

  it("carries evidence for every edit and test, so the viewer finds no gaps", () => {
    const script = smokeMockScript(INPUT, { steps: 4, spacingMs: 150 });
    const rows = traceOf(script);
    const meta = {
      sessionId: "sess_smoke",
      repoId: "repo_1",
      repoName: "repo",
      prompt: "Smoke",
      state: "completed" as const,
      startedAt: rows[0]?.ts ?? "",
      endedAt: rows.at(-1)?.ts ?? null,
      lastEventSeq: rows.length,
    };
    const session = foldRows(meta, rows, { live: false, nowMs: Date.parse(rows.at(-1)?.ts ?? "") });
    expect(session.gaps).toEqual([]);
    const tests = session.steps.filter((step) => step.kind === "test");
    expect(tests).toHaveLength(4);
    for (const step of tests) expect(step.tests).toMatchObject({ runner: "vitest", passed: 3, failed: 0 });
    const edits = session.steps.filter((step) => step.kind === "edit");
    expect(edits).toHaveLength(4);
    for (const step of edits) expect(step.edit).toMatchObject({ claimed: true, observed: true });
  });

  it("defaults to a short run for screenshots", () => {
    expect(SMOKE_SCRIPT_DEFAULTS).toEqual({ steps: 6, spacingMs: 150 });
    expect(smokeMockScript(INPUT).entries).toHaveLength(6 * 6 + 1);
  });
});
