import { describe, expect, it } from "vitest";

import {
  buildPlaceholderTitle,
  clusterSession,
  type SequencedFact,
  type SessionInput,
} from "./clustering.js";
import {
  commandExecuted,
  depChange,
  fileChanged,
  functionSymbol,
  hunk,
  importSymbol,
  REPO,
  revertDetected,
  seq,
  SESSION,
  symbolDelta,
  testResult,
  tsOf,
} from "./test-helpers.js";

function run(
  facts: SequencedFact[],
  input: Partial<SessionInput> = {},
): ReturnType<typeof clusterSession> {
  return clusterSession({
    sessionId: SESSION,
    facts,
    agentEvents: [],
    semanticEvents: [],
    decisions: [],
    ...input,
  });
}

describe("clustering: idle split and bucket cohesion", () => {
  it("starts a new bucket after a >120s gap", () => {
    const result = run([
      seq({ fact: fileChanged("a.ts", "modified", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
      seq({ fact: fileChanged("b.ts", "modified", tsOf(0, 10)), factId: "f2", seq: 2, batchId: 0 }),
      seq({ fact: fileChanged("c.ts", "modified", tsOf(3)), factId: "f3", seq: 3, batchId: 1 }),
    ]);
    expect(result.units).toHaveLength(2);
    const first = result.units.find((unit) => unit.files.includes("a.ts"));
    const second = result.units.find((unit) => unit.files.includes("c.ts"));
    expect(first?.files).toEqual(["a.ts", "b.ts"]);
    expect(second?.files).toEqual(["c.ts"]);
  });

  it("keeps facts within 120s in a single bucket component", () => {
    const result = run([
      seq({ fact: fileChanged("a.ts", "modified", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
      seq({ fact: fileChanged("b.ts", "modified", tsOf(0, 30)), factId: "f2", seq: 2, batchId: 0 }),
      seq({ fact: fileChanged("c.ts", "modified", tsOf(1, 30)), factId: "f3", seq: 3, batchId: 0 }),
    ]);
    expect(result.units).toHaveLength(1);
    expect(result.units[0]?.files).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
});

describe("clustering: formatting and test carve-outs", () => {
  it("formats-only files form their own unit", () => {
    const result = run([
      seq({ fact: fileChanged("src/utils/format.ts", "modified", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
      seq({ fact: hunk("src/utils/format.ts", tsOf(0, 1), { isFormattingOnly: true }), factId: "f2", seq: 2, batchId: 0 }),
      seq({ fact: fileChanged("src/app.ts", "modified", tsOf(0, 2)), factId: "f3", seq: 3, batchId: 0 }),
    ]);
    expect(result.units).toHaveLength(2);
    const fmt = result.units.find((unit) => unit.files.includes("src/utils/format.ts"));
    const main = result.units.find((unit) => unit.files.includes("src/app.ts"));
    expect(fmt?.files).toEqual(["src/utils/format.ts"]);
    expect(fmt?.category).toBe("implementation");
    expect(main?.files).toEqual(["src/app.ts"]);
  });

  it("keeps a formatting hunk on a file that already has real changes", () => {
    const result = run([
      seq({ fact: fileChanged("src/app.ts", "modified", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
      seq({ fact: hunk("src/app.ts", tsOf(0, 1), { added: 5 }), factId: "f2", seq: 2, batchId: 0 }),
      seq({ fact: hunk("src/app.ts", tsOf(0, 2), { isFormattingOnly: true }), factId: "f3", seq: 3, batchId: 0 }),
    ]);
    expect(result.units).toHaveLength(1);
    expect(result.units[0]?.files).toEqual(["src/app.ts"]);
    expect(result.units[0]?.evidence).toHaveLength(3);
  });

  it("test files cluster into their own unit", () => {
    const result = run([
      seq({ fact: fileChanged("src/limiter.ts", "added", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
      seq({ fact: fileChanged("tests/limiter.test.ts", "added", tsOf(0, 1)), factId: "f2", seq: 2, batchId: 0 }),
      seq({ fact: fileChanged("tests/smoke.test.ts", "added", tsOf(0, 2)), factId: "f3", seq: 3, batchId: 0 }),
    ]);
    expect(result.units).toHaveLength(2);
    const testUnit = result.units.find((unit) => unit.files.includes("tests/limiter.test.ts"));
    expect(testUnit?.files).toEqual(["tests/limiter.test.ts", "tests/smoke.test.ts"]);
    expect(testUnit?.category).toBe("tests");
  });
});

describe("clustering: symbols, titles, categories", () => {
  it("collects added and modified symbols, excludes removed, dedupes by name", () => {
    const result = run([
      seq({
        fact: symbolDelta("src/a.ts", tsOf(0), {
          added: [functionSymbol("create"), importSymbol("other", "./b")],
          removed: [functionSymbol("legacy")],
          modified: [],
        }),
        factId: "f1",
        seq: 1,
        batchId: 0,
      }),
      seq({
        fact: symbolDelta("src/b.ts", tsOf(0, 1), {
          added: [functionSymbol("other")],
          removed: [],
          modified: [functionSymbol("create")],
        }),
        factId: "f2",
        seq: 2,
        batchId: 0,
      }),
    ]);
    expect(result.units).toHaveLength(1);
    const names = result.units[0]?.symbols.map((symbol) => symbol.name);
    expect(names).toEqual(["create", "other"]);
  });

  it("builds the deterministic placeholder title", () => {
    expect(buildPlaceholderTitle(["a.ts", "b.ts", "c.ts", "d.ts"])).toBe(
      "Changed 4 files: a.ts, b.ts, c.ts",
    );
    expect(buildPlaceholderTitle(["a.ts"])).toBe("Changed 1 file: a.ts");
  });

  it("derives schema category from migration paths", () => {
    const result = run([
      seq({ fact: fileChanged("src/db/schema.ts", "modified", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
      seq({ fact: fileChanged("migrations/001_alter.sql", "added", tsOf(0, 1)), factId: "f2", seq: 2, batchId: 0 }),
    ]);
    expect(result.units[0]?.category).toBe("schema");
  });

  it("derives security category from auth paths", () => {
    const result = run([
      seq({ fact: fileChanged("src/auth/service.ts", "modified", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
    ]);
    expect(result.units[0]?.category).toBe("security");
  });

  it("derives api category from route paths", () => {
    const result = run([
      seq({ fact: fileChanged("src/routes/users.ts", "modified", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
    ]);
    expect(result.units[0]?.category).toBe("api");
  });

  it("derives dependency category from dependency evidence", () => {
    const result = run([
      seq({ fact: depChange(tsOf(0), [{ name: "zod", version: "^3" }]), factId: "f1", seq: 1, batchId: 0 }),
      seq({ fact: fileChanged("src/app.ts", "modified", tsOf(0, 1)), factId: "f2", seq: 2, batchId: 0 }),
    ]);
    expect(result.units[0]?.category).toBe("dependency");
    expect(result.units[0]?.dependencyChanges).toHaveLength(1);
  });

  it("maps architecture event kind to architecture category", () => {
    const result = run(
      [
        seq({ fact: fileChanged("src/middleware/x.ts", "added", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
      ],
      {
        semanticEvents: [
          {
            id: "se-arch",
            sessionId: SESSION,
            kind: "architecture_change",
            summary: "pipeline changed",
            evidence: [],
            files: ["src/middleware/x.ts"],
            symbols: [],
            createdAt: tsOf(0, 2),
          },
        ],
      },
    );
    expect(result.units[0]?.category).toBe("architecture");
  });

  it("decision_candidate events create a separate configuration unit", () => {
    const result = run(
      [
        seq({ fact: fileChanged("src/middleware/x.ts", "added", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
      ],
      {
        semanticEvents: [
          {
            id: "se-dec",
            sessionId: SESSION,
            kind: "decision_candidate",
            summary: "policy question",
            evidence: [],
            files: ["src/middleware/x.ts"],
            symbols: [],
            createdAt: tsOf(0, 2),
          },
        ],
      },
    );
    expect(result.units).toHaveLength(2);
    const decisionUnit = result.units.find((unit) => unit.id === result.eventChangeUnitIds.get("se-dec"));
    expect(decisionUnit?.files).toEqual(["src/middleware/x.ts"]);
    expect(decisionUnit?.category).toBe("configuration");
  });
});

describe("clustering: cross-bucket attachment and merges", () => {
  it("attaches a later-bucket fact to the most-connected existing unit via import edge", () => {
    const result = run([
      seq({ fact: fileChanged("src/a.ts", "added", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
      seq({
        fact: symbolDelta("src/a.ts", tsOf(0, 1), { added: [functionSymbol("helper")], removed: [], modified: [] }),
        factId: "f2",
        seq: 2,
        batchId: 0,
      }),
      seq({ fact: fileChanged("src/b.ts", "added", tsOf(5)), factId: "f3", seq: 3, batchId: 0 }),
      seq({
        fact: symbolDelta("src/b.ts", tsOf(5, 1), { added: [importSymbol("helper", "./a")], removed: [], modified: [] }),
        factId: "f4",
        seq: 4,
        batchId: 0,
      }),
    ]);
    expect(result.units).toHaveLength(1);
    expect(result.units[0]?.files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("merges a later-bucket component when >50% of its files connect to an existing unit", () => {
    const result = run([
      seq({ fact: fileChanged("src/a.ts", "added", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
      seq({ fact: fileChanged("src/b.ts", "added", tsOf(0, 1)), factId: "f2", seq: 2, batchId: 0 }),
      seq({
        fact: symbolDelta("src/a.ts", tsOf(0, 2), { added: [functionSymbol("target")], removed: [], modified: [] }),
        factId: "f3",
        seq: 3,
        batchId: 0,
      }),
      seq({ fact: fileChanged("src/c.ts", "added", tsOf(5)), factId: "f4", seq: 4, batchId: 1 }),
      seq({ fact: fileChanged("src/d.ts", "added", tsOf(5, 1)), factId: "f5", seq: 5, batchId: 1 }),
      seq({
        fact: symbolDelta("src/c.ts", tsOf(5, 2), { added: [importSymbol("mid", "./d")], removed: [], modified: [] }),
        factId: "f6",
        seq: 6,
        batchId: 1,
      }),
      seq({
        fact: symbolDelta("src/d.ts", tsOf(5, 3), { added: [importSymbol("target", "./a")], removed: [], modified: [] }),
        factId: "f7",
        seq: 7,
        batchId: 1,
      }),
    ]);
    expect(result.units).toHaveLength(1);
    expect(result.units[0]?.files).toEqual(["src/a.ts", "src/b.ts", "src/d.ts", "src/c.ts"]);
  });
});

describe("clustering: connected components within a bucket", () => {
  it("splits one bucket with two disconnected file sets into two units", () => {
    const result = run([
      seq({ fact: fileChanged("src/a.ts", "added", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
      seq({ fact: fileChanged("src/b.ts", "added", tsOf(0, 1)), factId: "f2", seq: 2, batchId: 0 }),
      seq({ fact: fileChanged("src/x.ts", "added", tsOf(0, 2)), factId: "f3", seq: 3, batchId: 1 }),
      seq({ fact: fileChanged("src/y.ts", "added", tsOf(0, 3)), factId: "f4", seq: 4, batchId: 1 }),
    ]);
    expect(result.units).toHaveLength(2);
    const first = result.units.find((unit) => unit.files.includes("src/a.ts"));
    const second = result.units.find((unit) => unit.files.includes("src/x.ts"));
    expect(first?.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(second?.files).toEqual(["src/x.ts", "src/y.ts"]);
  });

  it("joins batch-disjoint files into one component via an import edge", () => {
    const result = run([
      seq({ fact: fileChanged("src/a.ts", "added", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
      seq({
        fact: symbolDelta("src/a.ts", tsOf(0, 1), { added: [functionSymbol("helper")], removed: [], modified: [] }),
        factId: "f2",
        seq: 2,
        batchId: 0,
      }),
      seq({ fact: fileChanged("src/x.ts", "added", tsOf(0, 2)), factId: "f3", seq: 3, batchId: 1 }),
      seq({
        fact: symbolDelta("src/x.ts", tsOf(0, 3), { added: [importSymbol("helper", "./a")], removed: [], modified: [] }),
        factId: "f4",
        seq: 4,
        batchId: 1,
      }),
    ]);
    expect(result.units).toHaveLength(1);
    expect(result.units[0]?.files).toEqual(["src/a.ts", "src/x.ts"]);
  });

  it("same-hunk-batch connects files that share no 500ms batch", () => {
    const result = run([
      seq({ fact: hunk("src/a.ts", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
      seq({ fact: hunk("src/b.ts", tsOf(0, 1)), factId: "f2", seq: 2, batchId: 0 }),
      seq({ fact: fileChanged("src/a.ts", "added", tsOf(0, 2)), factId: "f3", seq: 3, batchId: 1 }),
      seq({ fact: fileChanged("src/b.ts", "added", tsOf(0, 3)), factId: "f4", seq: 4, batchId: 1 }),
    ]);
    expect(result.units).toHaveLength(1);
    expect(result.units[0]?.files).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("clustering: unconditional 500ms-batch edges across idle buckets", () => {
  it("attaches a later-bucket file sharing a 500ms batch with an earlier unit", () => {
    const result = run([
      seq({ fact: fileChanged("src/a.ts", "added", tsOf(0)), factId: "f1", seq: 1, batchId: 7 }),
      seq({ fact: fileChanged("src/b.ts", "added", tsOf(5)), factId: "f2", seq: 2, batchId: 7 }),
    ]);
    expect(result.units).toHaveLength(1);
    expect(result.units[0]?.files).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("clustering: command-only and evidence coverage", () => {
  it("emits a 1-fact unit for a bucket whose only fact is a command", () => {
    const result = run([
      seq({ fact: commandExecuted(tsOf(0), "pnpm build"), factId: "f1", seq: 1, batchId: 0 }),
    ]);
    expect(result.units).toHaveLength(1);
    expect(result.units[0]?.files).toEqual([]);
    expect(result.units[0]?.evidence).toContain("f1");
    expect(result.units[0]?.title).toBe("Changed 0 files");
  });

  it("includes test_result and revert_detected facts in unitEvidenceFacts", () => {
    const result = run([
      seq({ fact: fileChanged("src/a.ts", "modified", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
      seq({ fact: testResult(tsOf(1), { passed: 2 }), factId: "f2", seq: 2, batchId: 0 }),
      seq({ fact: revertDetected(tsOf(1, 1), ["src/a.ts"]), factId: "f3", seq: 3, batchId: 0 }),
    ]);
    const unit = result.units.find((candidate) => candidate.files.includes("src/a.ts"));
    expect(unit).toBeDefined();
    const unitFacts = (result.unitEvidenceFacts.get(unit?.id ?? "") ?? []).map((entry) => entry.fact);
    expect(unitFacts.map((fact) => fact.type)).toEqual([
      "file_changed",
      "test_result",
      "revert_detected",
    ]);
    expect(unit?.evidence).toContain("f2");
    expect(unit?.evidence).toContain("f3");
  });
});

describe("clustering: revert and supersede status", () => {
  it("marks units reverted when a revert_detected fact covers their files", () => {
    const result = run([
      seq({ fact: fileChanged("src/a.ts", "modified", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
      seq({ fact: fileChanged("src/b.ts", "modified", tsOf(0, 1)), factId: "f2", seq: 2, batchId: 0 }),
      seq({ fact: revertDetected(tsOf(1), ["src/a.ts"]), factId: "f3", seq: 3, batchId: 0 }),
    ]);
    const reverted = result.units.find((unit) => unit.files.includes("src/a.ts"));
    expect(reverted?.status).toBe("reverted");
  });

  it("marks units superseded via supersede markers", () => {
    const result = run(
      [
        seq({ fact: fileChanged("src/a.ts", "modified", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
      ],
      { supersedeMarkers: ["src/a.ts"] },
    );
    expect(result.units[0]?.status).toBe("superseded");
  });
});

describe("clustering: validation and failure attachment", () => {
  it("attaches passing validations and marks the unit validated", () => {
    const result = run([
      seq({ fact: fileChanged("src/a.ts", "modified", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
      seq({ fact: testResult(tsOf(1), { passed: 3 }), factId: "f2", seq: 2, batchId: 0 }),
    ]);
    expect(result.validations).toHaveLength(1);
    expect(result.units[0]?.status).toBe("validated");
    expect(result.units[0]?.validationResults).toHaveLength(1);
  });

  it("attaches failures by file membership and marks units failed", () => {
    const result = run([
      seq({ fact: fileChanged("src/a.ts", "modified", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
      seq({ fact: fileChanged("tests/a.test.ts", "added", tsOf(0, 1)), factId: "f2", seq: 2, batchId: 0 }),
      seq({
        fact: testResult(tsOf(1), {
          failed: 1,
          failures: [{ file: "tests/a.test.ts", testName: "works", message: "boom" }],
        }),
        factId: "f3",
        seq: 3,
        batchId: 0,
      }),
    ]);
    const testUnit = result.units.find((unit) => unit.files.includes("tests/a.test.ts"));
    expect(testUnit?.status).toBe("failed");
  });

  it("attaches failures by symbol mention in the test name", () => {
    const result = run([
      seq({
        fact: symbolDelta("src/auth.ts", tsOf(0), { added: [functionSymbol("login")], removed: [], modified: [] }),
        factId: "f1",
        seq: 1,
        batchId: 0,
      }),
      seq({
        fact: testResult(tsOf(1), {
          failed: 1,
          failures: [{ file: "tests/other.test.ts", testName: "login redirects correctly", message: "boom" }],
        }),
        factId: "f2",
        seq: 2,
        batchId: 0,
      }),
    ]);
    const authUnit = result.units.find((unit) => unit.files.includes("src/auth.ts"));
    expect(authUnit?.status).toBe("failed");
  });

  it("creates a tests unit for a failing test file with no session facts", () => {
    const result = run([
      seq({ fact: fileChanged("src/a.ts", "modified", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
      seq({
        fact: testResult(tsOf(1), {
          failed: 1,
          failures: [{ file: "tests/stale.test.ts", testName: "stale expectation", message: "boom" }],
        }),
        factId: "f2",
        seq: 2,
        batchId: 0,
      }),
    ]);
    const stale = result.units.find((unit) => unit.files.includes("tests/stale.test.ts"));
    expect(stale).toBeDefined();
    expect(stale?.category).toBe("tests");
    expect(stale?.status).toBe("failed");
  });
});

describe("clustering: command evidence and decisions", () => {
  it("links decisions to decision-candidate units via evidence refs", () => {
    const result = run(
      [],
      {
        semanticEvents: [
          {
            id: "se-dec",
            sessionId: SESSION,
            kind: "decision_candidate",
            summary: "policy question",
            evidence: [],
            files: ["src/limiter.ts"],
            symbols: [],
            createdAt: tsOf(0),
          },
        ],
        decisions: [
          {
            id: "dec-1",
            sessionId: SESSION,
            title: "fail open?",
            context: "ctx",
            severity: "required",
            options: [],
            affectedChangeUnits: [],
            evidence: ["se-dec"],
            status: "open",
          },
        ],
      },
    );
    const decisionUnit = result.units.find((unit) => unit.id === result.eventChangeUnitIds.get("se-dec"));
    expect(decisionUnit?.relatedDecisions).toEqual(["dec-1"]);
    expect(result.decisionChangeUnitIds.get("dec-1")).toEqual([decisionUnit?.id]);
  });

  it("keeps command_executed facts as evidence on the bucket unit", () => {
    const result = run([
      seq({ fact: fileChanged("src/a.ts", "modified", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
      seq({ fact: commandExecuted(tsOf(0, 1)), factId: "f2", seq: 2, batchId: 0 }),
    ]);
    expect(result.units[0]?.evidence).toContain("f2");
  });
});

describe("clustering: determinism", () => {
  it("is invariant to input order within a bucket", () => {
    const make = (): SequencedFact[] => [
      seq({ fact: fileChanged("a.ts", "modified", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
      seq({ fact: fileChanged("b.ts", "modified", tsOf(0, 1)), factId: "f2", seq: 2, batchId: 0 }),
      seq({ fact: hunk("a.ts", tsOf(0, 2)), factId: "f3", seq: 3, batchId: 0 }),
      seq({ fact: fileChanged("c.ts", "modified", tsOf(0, 3)), factId: "f4", seq: 4, batchId: 0 }),
    ];
    const forward = run(make());
    const reversed = run([...make()].reverse());
    expect(forward.units.map((u) => u.files.join("|")).sort()).toEqual(
      reversed.units.map((u) => u.files.join("|")).sort(),
    );
  });

  it("is idempotent for duplicated facts with the same content", () => {
    const base = [
      seq({ fact: fileChanged("a.ts", "modified", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
      seq({ fact: fileChanged("b.ts", "modified", tsOf(0, 1)), factId: "f2", seq: 2, batchId: 0 }),
    ];
    const once = run(base);
    const twice = run([...base, ...base.map((entry) => ({ ...entry, seq: entry.seq + 10 }))]);
    expect(twice.units.map((unit) => unit.files.join("|")).sort()).toEqual(
      once.units.map((unit) => unit.files.join("|")).sort(),
    );
    expect(twice.units).toHaveLength(once.units.length);
  });

  it("uses REPO constant in every generated fact", () => {
    expect(REPO).toBe("repo-test");
  });
});
