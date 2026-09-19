import { describe, expect, it } from "vitest";

import { clusterSession, type SequencedFact } from "./clustering.js";
import { projectGraph, type GraphInput } from "./graph.js";
import {
  commandExecuted,
  depChange,
  fileChanged,
  functionSymbol,
  hunk,
  importSymbol,
  seq,
  SESSION,
  symbolDelta,
  testResult,
  tsOf,
} from "./test-helpers.js";

function graphFor(facts: SequencedFact[], extra: Partial<GraphInput> = {}): ReturnType<typeof projectGraph> {
  const projection = clusterSession({
    sessionId: SESSION,
    facts,
    agentEvents: [],
    semanticEvents: [],
    decisions: [],
  });
  const failureUnitIds = new Map<string, string[]>();
  for (const failure of projection.failures) {
    const hosts = projection.units
      .filter((unit) => unit.files.includes(failure.file))
      .map((unit) => unit.id);
    failureUnitIds.set(failure.id, hosts);
  }
  return projectGraph({
    sessionId: SESSION,
    units: projection.units,
    facts,
    agentEvents: [],
    decisions: [],
    validations: projection.validations,
    failures: projection.failures,
    unitEvidenceFacts: projection.unitEvidenceFacts,
    importEdges: projection.importEdges,
    packageImports: projection.packageImports,
    fileKinds: projection.fileKinds,
    failureUnitIds,
    ...extra,
  });
}

describe("graph projection", () => {
  it("emits nodes of every required type", () => {
    const facts: SequencedFact[] = [
      seq({ fact: fileChanged("src/a.ts", "added", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
      seq({
        fact: symbolDelta("src/a.ts", tsOf(0, 1), { added: [functionSymbol("run")], removed: [], modified: [] }),
        factId: "f2",
        seq: 2,
        batchId: 0,
      }),
      seq({ fact: fileChanged("tests/a.test.ts", "added", tsOf(0, 2)), factId: "f3", seq: 3, batchId: 0 }),
      seq({ fact: depChange(tsOf(0, 3), [{ name: "zod", version: "^3" }]), factId: "f4", seq: 4, batchId: 0 }),
      seq({ fact: commandExecuted(tsOf(0, 4), "pnpm test"), factId: "f5", seq: 5, batchId: 0 }),
      seq({
        fact: testResult(tsOf(0, 5), { passed: 1, failed: 1, failures: [{ file: "tests/a.test.ts", testName: "run works", message: "boom" }] }),
        factId: "f6",
        seq: 6,
        batchId: 0,
      }),
    ];
    const graph = graphFor(facts, {
      taskPrompt: "add zod",
      decisions: [
        {
          id: "dec-1",
          sessionId: SESSION,
          title: "t",
          context: "c",
          severity: "optional",
          options: [],
          affectedChangeUnits: [],
          evidence: [],
          status: "open",
        },
      ],
    });
    const types = new Set(graph.nodes.map((node) => node.type));
    expect(types).toEqual(
      new Set(["Task", "ChangeUnit", "File", "Symbol", "Dependency", "Decision", "Validation", "Failure", "Command"]),
    );
  });

  it("emits MODIFIES, ADDS, REMOVES, DEPENDS_ON, VALIDATES, FAILS, REQUIRES edges", () => {
    const facts: SequencedFact[] = [
      seq({ fact: fileChanged("src/a.ts", "added", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
      seq({
        fact: symbolDelta("src/a.ts", tsOf(0, 1), {
          added: [functionSymbol("run"), importSymbol("z", "zod")],
          removed: [functionSymbol("old")],
          modified: [],
        }),
        factId: "f2",
        seq: 2,
        batchId: 0,
      }),
      seq({ fact: depChange(tsOf(0, 2), [{ name: "zod", version: "^3" }]), factId: "f3", seq: 3, batchId: 0 }),
      seq({ fact: commandExecuted(tsOf(0, 3), "pnpm test"), factId: "f4", seq: 4, batchId: 0 }),
      seq({
        fact: testResult(tsOf(0, 4), { passed: 0, failed: 1, failures: [{ file: "src/a.ts", testName: "run works", message: "boom" }] }),
        factId: "f5",
        seq: 5,
        batchId: 0,
      }),
    ];
    const graph = graphFor(facts);
    const edgeTypes = new Set(graph.edges.map((edge) => edge.type));
    expect(edgeTypes.has("ADDS")).toBe(true);
    expect(edgeTypes.has("MODIFIES")).toBe(true);
    expect(edgeTypes.has("DEPENDS_ON")).toBe(true);
    expect(edgeTypes.has("VALIDATES")).toBe(true);
    expect(edgeTypes.has("FAILS")).toBe(true);
    expect(edgeTypes.has("REQUIRES")).toBe(true);
    expect(edgeTypes.has("CAUSED_BY")).toBe(true);
    const symbolEdges = graph.edges.filter((edge) => edge.type === "DEPENDS_ON");
    expect(symbolEdges.length).toBeGreaterThan(0);
  });

  it("links decision nodes to units via IMPLEMENTS and AFFECTS", () => {
    const facts: SequencedFact[] = [
      seq({ fact: fileChanged("src/a.ts", "added", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
    ];
    const projection = clusterSession({
      sessionId: SESSION,
      facts,
      agentEvents: [],
      semanticEvents: [
        {
          id: "se-dec",
          sessionId: SESSION,
          kind: "decision_candidate",
          summary: "q",
          evidence: [],
          files: ["src/a.ts"],
          symbols: [],
          createdAt: tsOf(0, 1),
        },
      ],
      decisions: [
        {
          id: "dec-1",
          sessionId: SESSION,
          title: "t",
          context: "c",
          severity: "optional",
          options: [],
          affectedChangeUnits: [],
          evidence: ["se-dec"],
          status: "open",
        },
      ],
    });
    const graph = projectGraph({
      sessionId: SESSION,
      units: projection.units,
      facts,
      agentEvents: [],
      decisions: [
        {
          id: "dec-1",
          sessionId: SESSION,
          title: "t",
          context: "c",
          severity: "optional",
          options: [],
          affectedChangeUnits: [],
          evidence: ["se-dec"],
          status: "open",
        },
      ],
      validations: [],
      failures: [],
      unitEvidenceFacts: projection.unitEvidenceFacts,
      importEdges: projection.importEdges,
      packageImports: projection.packageImports,
      fileKinds: projection.fileKinds,
      failureUnitIds: new Map(),
    });
    const decisionNode = graph.nodes.find((node) => node.type === "Decision");
    expect(decisionNode).toBeDefined();
    const affects = graph.edges.filter((edge) => edge.type === "AFFECTS");
    const implementsEdges = graph.edges.filter((edge) => edge.type === "IMPLEMENTS");
    expect(affects.length).toBeGreaterThan(0);
    expect(implementsEdges.length).toBeGreaterThan(0);
  });

  it("emits EVIDENCED_BY edges from agent events inside the unit time window", () => {
    const facts: SequencedFact[] = [
      seq({ fact: fileChanged("src/a.ts", "added", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
      seq({ fact: hunk("src/a.ts", tsOf(0, 1)), factId: "f2", seq: 2, batchId: 0 }),
    ];
    const projection = clusterSession({
      sessionId: SESSION,
      facts,
      agentEvents: [],
      semanticEvents: [],
      decisions: [],
    });
    const graph = projectGraph({
      sessionId: SESSION,
      units: projection.units,
      facts,
      agentEvents: [
        { type: "agent_message", sessionId: SESSION, role: "assistant", text: "hi", ts: tsOf(0, 1) },
      ],
      decisions: [],
      validations: [],
      failures: [],
      unitEvidenceFacts: projection.unitEvidenceFacts,
      importEdges: projection.importEdges,
      packageImports: projection.packageImports,
      fileKinds: projection.fileKinds,
      failureUnitIds: new Map(),
    });
    expect(graph.nodes.some((node) => node.type === "AgentEvent")).toBe(true);
    expect(graph.edges.some((edge) => edge.type === "EVIDENCED_BY")).toBe(true);
  });

  it("is deterministic for identical inputs", () => {
    const facts: SequencedFact[] = [
      seq({ fact: fileChanged("src/a.ts", "added", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
      seq({ fact: hunk("src/a.ts", tsOf(0, 1)), factId: "f2", seq: 2, batchId: 0 }),
    ];
    const first = graphFor(facts);
    const second = graphFor(facts);
    expect(second.nodes).toEqual(first.nodes);
    expect(second.edges).toEqual(first.edges);
  });

  it("attributes fact edges to the owning unit when several units exist", () => {
    const facts: SequencedFact[] = [
      seq({ fact: fileChanged("src/a.ts", "added", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
      seq({ fact: hunk("src/a.ts", tsOf(0, 1)), factId: "f2", seq: 2, batchId: 0 }),
      seq({ fact: fileChanged("src/x.ts", "added", tsOf(0, 2)), factId: "f3", seq: 3, batchId: 1 }),
      seq({
        fact: symbolDelta("src/x.ts", tsOf(0, 3), { added: [functionSymbol("runX")], removed: [], modified: [] }),
        factId: "f4",
        seq: 4,
        batchId: 1,
      }),
    ];
    const graph = graphFor(facts);
    const xUnit = graph.nodes.find(
      (node) => node.type === "ChangeUnit" && node.label.startsWith("Changed 1 file: src/x.ts"),
    );
    const runXSymbol = graph.nodes.find((node) => node.type === "Symbol" && node.label === "runX");
    expect(xUnit).toBeDefined();
    expect(runXSymbol).toBeDefined();
    const addsEdge = graph.edges.find(
      (edge) =>
        edge.type === "ADDS" &&
        edge.from === xUnit?.id &&
        edge.to === runXSymbol?.id,
    );
    expect(addsEdge).toBeDefined();
  });
});
