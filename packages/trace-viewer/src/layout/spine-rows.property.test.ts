import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { Level, Step, TraceSession } from "../model/index.js";
import { arbSessionSeed, arbTraceSession } from "../test-support/arbitraries.js";
import { buildSession } from "../test-support/session-builder.js";
import { buildSpineRows, type SpineRow } from "./spine-rows.js";
import { buildTimeScale, timeScaleInputOf } from "./time-scale.js";
import { buildTraceIndex } from "./trace-index.js";

const none = new Set<string>();
const PINNED_KINDS = new Set(["instruction", "decision", "approval"]);

function rows(session: TraceSession, playheadSeq: number, selection: Step | undefined, matches: ReadonlySet<string>, live: boolean, level: Level = "chapter"): SpineRow[] {
  const index = buildTraceIndex(session);
  return buildSpineRows(session, index, buildTimeScale(timeScaleInputOf(session)), {
    brush: { kind: "session" }, level, playheadSeq, selection: selection?.id ?? null,
    expanded: none, collapsed: none, matches, live,
  });
}

describe("spine row properties (spec §7.6.3)", () => {
  it("the playhead row and every pinned row are never elided; keys are unique", () => {
    fc.assert(fc.property(arbTraceSession({ maxSteps: 80, maxChapters: 3, maxTurns: 2 }), fc.nat(), fc.nat(), fc.array(fc.nat(), { maxLength: 4 }), (session, p, s, m) => {
      const n = session.steps.length;
      const playhead = session.steps[p % n];
      const selected = session.steps[s % n];
      const matches = new Set(m.map((i) => session.steps[i % n]?.id ?? ""));
      const out = rows(session, playhead?.firstSeq ?? 1, selected, matches, false);
      expect(new Set(out.map((r) => r.key)).size).toBe(out.length);
      // Chapters that share an anchor seq (a step linked to several units) still get distinct Session-level keys.
      const beats = rows(session, playhead?.firstSeq ?? 1, selected, matches, false, "session");
      expect(new Set(beats.map((r) => r.key)).size).toBe(beats.length);
      const shown = new Set(out.flatMap((r) => (r.t === "step" ? [r.step] : [])));
      const reviewed = new Set(out.flatMap((r) => (r.t === "noise" && r.jev !== undefined ? r.steps : [])));
      const findingsById = new Map(session.findings.map((f) => [f.id, f]));
      session.steps.forEach((step, i) => {
        const pinned = PINNED_KINDS.has(step.kind) || step.findingIds.length > 0 || step.status === "failed"
          || step === playhead || step === selected || matches.has(step.id);
        // A Jev review group (audit 1-1) may hold a pinned Jev row, never one with a critical finding,
        // a failure, the playhead, the selection or a match.
        const critical = step.findingIds.some((id) => findingsById.get(id)?.severity === "critical");
        const mayFold = step.lane === "jev" && !critical && step.status !== "failed" && step !== playhead && step !== selected && !matches.has(step.id);
        if (pinned) expect(shown.has(i) || (mayFold && reviewed.has(i)), step.id).toBe(true);
        if (reviewed.has(i)) expect(mayFold, step.id).toBe(true);
      });
      for (const r of out) {
        if (r.t === "noise" && r.jev !== undefined) {
          expect(r.steps.length).toBeGreaterThanOrEqual(2);
          expect(r.steps.filter((i) => session.steps[i]?.kind === "guardrail" && (session.steps[i]?.findingIds.length ?? 0) > 0)).toHaveLength(r.jev.guardrails);
          expect(r.jev.guardrails).toBeGreaterThan(0);
        }
      }
    }), { numRuns: 150 });
  });

  it("keys from a prefix fold stay in the full fold except the open tail", () => {
    fc.assert(fc.property(arbSessionSeed({ maxSteps: 60, maxChapters: 3, maxTurns: 2, live: false }), fc.double({ min: 0, max: 1, noNaN: true }), (seed, f) => {
      const m = Math.max(1, Math.floor(seed.steps.length * f));
      const full = buildSession(seed);
      const prefix = buildSession({
        ...seed,
        live: true,
        state: "running",
        steps: seed.steps.slice(0, m),
        findings: (seed.findings ?? []).filter((x) => x.step < m).map((x) => ({ ...x, evidence: (x.evidence ?? []).filter((e) => e < m) })),
        gaps: (seed.gaps ?? []).filter((g) => g.beforeStep < m),
      });
      const prefixRows = rows(prefix, 1, undefined, none, true);
      const fullKeys = new Set(rows(full, 1, undefined, none, false).map((r) => r.key));
      let lastClosed = -1;
      prefixRows.forEach((row, j) => {
        if (row.t === "turn" || row.t === "idle" || row.t === "gap") lastClosed = j;
        if (row.t === "step") {
          const step = prefix.steps[row.step];
          // A pinned Jev-lane row at the tail may still join a Jev review group as rows arrive (audit 1-1).
          const closes = PINNED_KINDS.has(step?.kind ?? "") || (step !== undefined && step.lane !== "jev" && (step.findingIds.length > 0 || step.status === "failed")) || step?.firstSeq === 1;
          if (step !== undefined && closes) lastClosed = j;
        }
      });
      for (const row of prefixRows.slice(0, lastClosed + 1)) expect(fullKeys.has(row.key), row.key).toBe(true);
    }), { numRuns: 150 });
  });
});
