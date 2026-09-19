import { describe, expect, it } from "vitest";

import { evidenceRefForFact, kindForUnit, type UnitEventInput } from "./events.js";
import { clusterSession, type SequencedFact } from "./clustering.js";
import {
  depChange,
  fileChanged,
  hunk,
  seq,
  SESSION,
  testResult,
  tsOf,
} from "./test-helpers.js";

function unitFor(facts: SequencedFact[]) {
  const result = clusterSession({
    sessionId: SESSION,
    facts,
    agentEvents: [],
    semanticEvents: [],
    decisions: [],
  });
  const unit = result.units[0];
  expect(unit).toBeDefined();
  const unitFacts = (result.unitEvidenceFacts.get(unit?.id ?? "") ?? []).map((entry) => entry.fact);
  return { unit: unit as NonNullable<typeof unit>, facts: unitFacts };
}

function inputFor(facts: SequencedFact[]): UnitEventInput {
  const { unit, facts: unitFacts } = unitFor(facts);
  return { unit, facts: unitFacts, unitValidationIds: unit.validationResults, hasFailures: false };
}

describe("semantic event kind mapping", () => {
  it("maps git_hunk+symbol_delta to implementation_change", () => {
    const { unit, facts } = unitFor([
      seq({ fact: hunk("src/util.ts", tsOf(0), { added: 3 }), factId: "f1", seq: 1, batchId: 0 }),
    ]);
    expect(kindForUnit({ unit, facts, unitValidationIds: [], hasFailures: false })).toBe("implementation_change");
  });

  it("maps dependency_change to dependency_change", () => {
    expect(kindForUnit(inputFor([
      seq({ fact: depChange(tsOf(0), [{ name: "zod", version: "^3" }]), factId: "f1", seq: 1, batchId: 0 }),
    ]))).toBe("dependency_change");
  });

  it("maps failing test_result to failure", () => {
    const input = inputFor([
      seq({
        fact: testResult(tsOf(0), { failed: 1, failures: [{ file: "tests/a.test.ts", testName: "t", message: "m" }] }),
        factId: "f1",
        seq: 1,
        batchId: 0,
      }),
    ]);
    expect(kindForUnit({ ...input, hasFailures: true })).toBe("failure");
  });

  it("maps passing test_result to test_result", () => {
    const facts = [
      seq({ fact: testResult(tsOf(0), { passed: 2 }), factId: "f1", seq: 1, batchId: 0 }),
      seq({ fact: fileChanged("tests/a.test.ts", "added", tsOf(0, 1)), factId: "f2", seq: 2, batchId: 0 }),
    ];
    const result = clusterSession({
      sessionId: SESSION,
      facts,
      agentEvents: [],
      semanticEvents: [],
      decisions: [],
    });
    const unit = result.units.find((candidate) => candidate.files.includes("tests/a.test.ts"));
    expect(unit).toBeDefined();
    const unitFacts = (result.unitEvidenceFacts.get(unit?.id ?? "") ?? []).map((entry) => entry.fact);
    expect(
      kindForUnit({
        unit: unit as NonNullable<typeof unit>,
        facts: unitFacts,
        unitValidationIds: (unit as NonNullable<typeof unit>).validationResults,
        hasFailures: false,
      }),
    ).toBe("test_result");
  });

  it("maps schema paths to schema_change", () => {
    expect(kindForUnit(inputFor([
      seq({ fact: fileChanged("migrations/001.sql", "added", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
    ]))).toBe("schema_change");
  });

  it("maps auth paths to security_change", () => {
    expect(kindForUnit(inputFor([
      seq({ fact: fileChanged("src/auth/service.ts", "modified", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
    ]))).toBe("security_change");
  });

  it("maps route paths to behavior_change", () => {
    expect(kindForUnit(inputFor([
      seq({ fact: fileChanged("src/routes/users.ts", "modified", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
    ]))).toBe("behavior_change");
  });
});

describe("evidence refs", () => {
  it("maps fact types to evidence ref types", () => {
    expect(evidenceRefForFact(hunk("src/a.ts", tsOf(0))).type).toBe("git_hunk");
    expect(evidenceRefForFact(fileChanged("src/a.ts", "modified", tsOf(0))).type).toBe("file");
    expect(evidenceRefForFact(testResult(tsOf(0))).type).toBe("test_output");
    expect(evidenceRefForFact(depChange(tsOf(0))).type).toBe("file");
    expect(evidenceRefForFact(depChange(tsOf(0))).sourceId).toBe("package.json");
  });
});
