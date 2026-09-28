import { describe, expect, it } from "vitest";

import type { TraceRow } from "@jevcode/contracts";

import {
  addCaptureFields,
  FIXTURE_NAMES,
  loadFixtureTrace,
  stripCaptureFields,
  type FixtureName,
} from "../test-support/fixture-rows.js";
import { foldRows } from "./fold.js";
import { compareFindings } from "./signals.js";
import type { Step, TraceSession } from "./types.js";

// Rows are selected by content (type, command, text), never by line number: A1-9 adds lines
// and fields to fixtures/*/events.jsonl. Each fixture is folded three ways: as stored, as a
// pre-M1 session (D11: no turnId, callId, sourceCallId, factId or agentCallIds) and with the
// M1 capture fields added (A1-9 shape).

const VARIANTS = {
  stored: (rows: TraceRow[]) => rows,
  legacy: (rows: TraceRow[]) => stripCaptureFields(rows),
  captured: (rows: TraceRow[]) => addCaptureFields(rows),
} as const;

type Variant = keyof typeof VARIANTS;

function load(name: FixtureName, variant: Variant): { rows: TraceRow[]; session: TraceSession } {
  const trace = loadFixtureTrace(name);
  const rows = VARIANTS[variant](trace.rows);
  return { rows, session: foldRows(trace.meta, rows, { live: false }) };
}

function field(row: TraceRow, key: string): unknown {
  return (row.payload as Record<string, unknown>)[key];
}

function findRow(rows: readonly TraceRow[], predicate: (row: TraceRow) => boolean, label: string): TraceRow {
  const row = rows.find(predicate);
  if (row === undefined) throw new Error(`fixture has no ${label} row`);
  return row;
}

function stepContaining(session: TraceSession, seq: number): Step {
  const step = session.steps.find((candidate) => candidate.seqs.includes(seq));
  if (step === undefined) throw new Error(`no step holds seq ${seq}`);
  return step;
}

const isAgent = (type: string) => (row: TraceRow) => row.type === "agent_event" && field(row, "type") === type;
const isFact = (type: string) => (row: TraceRow) => row.type === "evidence_fact" && field(row, "type") === type;

describe.each(Object.keys(VARIANTS) as Variant[])("fixtures (%s)", (variant) => {
  it.each(FIXTURE_NAMES)("%s folds cleanly into one completed turn", (name) => {
    const { rows, session } = load(name, variant);
    expect(session.gaps).toEqual([]);
    expect(session.turns).toHaveLength(1);
    expect(session.turns[0]).toMatchObject({ trigger: "initial", outcome: "completed" });
    const prompt = field(findRow(rows, isAgent("agent_started"), "agent_started"), "prompt");
    expect(session.steps[0]).toMatchObject({ kind: "instruction", text: prompt });
    const ids = session.steps.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (let index = 1; index < session.steps.length; index += 1) {
      const previous = session.steps[index - 1] as Step;
      const current = session.steps[index] as Step;
      expect(current.firstSeq).toBeGreaterThan(previous.firstSeq);
      expect(current.tMs).toBeGreaterThanOrEqual(previous.tMs);
    }
    const units = rows.filter((row) => row.type === "change_unit").map((row) => field(row, "id"));
    expect(session.chapters.map((chapter) => chapter.changeUnitId).sort()).toEqual([...new Set(units)].sort());
  });

  it("oauth: the pnpm test run is one failed step with 14/1/0", () => {
    const { rows, session } = load("oauth", variant);
    const started = findRow(rows, (row) => isAgent("command_started")(row) && field(row, "command") === "pnpm test", "pnpm test start");
    const completed = findRow(rows, (row) => isAgent("command_completed")(row) && field(row, "command") === "pnpm test", "pnpm test end");
    const result = findRow(rows, isFact("test_result"), "test_result");
    const step = stepContaining(session, started.seq);
    expect(step.seqs).toEqual(expect.arrayContaining([started.seq, result.seq, completed.seq]));
    expect(step).toMatchObject({ kind: "test", status: "failed", tests: { passed: 14, failed: 1, skipped: 0 } });
    expect(step.problems).toEqual(["exit_nonzero", "tests_failed"]);
    const joinedById = field(started, "callId") !== undefined && field(result, "sourceCallId") !== undefined;
    expect(step.provenance).toBe(joinedById ? "observed" : "inferred");
  });

  it.each([
    ["oauth", "OAuth implementation complete; all checks pass."],
    ["api-break", "The endpoint change is complete and all tests pass."],
  ] as const)("%s: the claim is contradicted by the failed run's test_result", (name, text) => {
    const { rows, session } = load(name, variant);
    const claim = findRow(rows, (row) => isAgent("agent_message")(row) && field(row, "text") === text, "claim");
    const result = findRow(rows, isFact("test_result"), "test_result");
    const contradictions = session.findings.filter((finding) => finding.ruleId === "claim_contradicted");
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]).toMatchObject({
      anchorSeq: claim.seq,
      anchorStepId: stepContaining(session, claim.seq).id,
      severity: "critical",
    });
    expect(contradictions[0]?.evidenceSeqs).toEqual([result.seq, claim.seq]);
    expect(contradictions[0]?.claim?.observed.seq).toBe(result.seq);
    expect(stepContaining(session, claim.seq).problems).toContain("claim_contradicted");
    const failing = session.findings.filter((finding) => finding.ruleId === "failing_tests");
    expect(failing.map((finding) => [finding.anchorSeq, finding.severity])).toEqual([[result.seq, "critical"]]);
    // failing_tests is critical too and anchors earlier; the rule rank puts the contradiction first (spec §6.7).
    expect([...session.findings].sort(compareFindings)[0]?.ruleId).toBe("claim_contradicted");
  });

  it.each(["rate-limit", "schema-change", "dep-change"] as const)("%s raises no finding", (name) => {
    expect(load(name, variant).session.findings).toEqual([]);
  });

  it("oauth: lockfile and formatting hunks are noise, the decision is one step", () => {
    const { rows, session } = load("oauth", variant);
    const lock = findRow(rows, (row) => isFact("git_hunk")(row) && field(row, "file") === "pnpm-lock.yaml", "lockfile hunk");
    const format = findRow(rows, (row) => isFact("git_hunk")(row) && field(row, "isFormattingOnly") === true, "formatting hunk");
    expect(stepContaining(session, lock.seq).noise).toBe("lockfile");
    expect(stepContaining(session, format.seq).noise).toBe("formatting");
    const decisionRows = rows.filter((row) => row.type === "decision");
    expect(decisionRows.length).toBeGreaterThanOrEqual(2);
    const step = stepContaining(session, decisionRows[0]?.seq ?? 0);
    expect(step.id).toBe(`step:${decisionRows[0]?.seq}`);
    expect(step.seqs).toEqual(decisionRows.map((row) => row.seq));
    expect(step.decision).toMatchObject({ status: "answered", decidedBy: "supervisor" });
    expect(step.decision?.options.filter((option) => option.chosen).map((option) => option.id)).toEqual(["explicit_link"]);
  });

  it("dep-change: formatting and lockfile edits collapse, real edits stay", () => {
    const { rows, session } = load("dep-change", variant);
    const noiseOf = (file: string) => {
      const hunk = findRow(rows, (row) => isFact("git_hunk")(row) && field(row, "file") === file, file);
      return stepContaining(session, hunk.seq).noise;
    };
    expect(noiseOf("src/utils/format.ts")).toBe("formatting");
    expect(noiseOf("pnpm-lock.yaml")).toBe("lockfile");
    expect(noiseOf("src/helpers/http.ts")).toBeNull();
  });
});

describe("fixture joins by variant", () => {
  it("stored and captured sessions link chapters by id; legacy sessions link approximately", () => {
    for (const name of FIXTURE_NAMES) {
      expect(load(name, "stored").session.coverage.approximateJoins, name).toBe(false);
      expect(load(name, "captured").session.coverage.approximateJoins, name).toBe(false);
      expect(load(name, "legacy").session.coverage.approximateJoins, name).toBe(true);
    }
  });

  it("captured sessions pair every command by callId", () => {
    const { session } = load("oauth", "captured");
    const commands = session.steps.filter((step) => step.command !== undefined && step.actor === "agent");
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((step) => step.provenance === "observed" && step.callId !== undefined)).toBe(true);
    expect(session.coverage.capabilities).toContain("call_ids");
  });
});
