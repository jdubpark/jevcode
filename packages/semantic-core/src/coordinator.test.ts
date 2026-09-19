import { describe, expect, it } from "vitest";

import {
  applyPatch,
  mergeSameFileFacts,
  parseReplayLine,
  PipelineCoordinator,
} from "./coordinator.js";
import { createInMemoryStores } from "./persistence.js";
import type { SequencedFact } from "./clustering.js";
import {
  agentEvent,
  commandExecuted,
  fileChanged,
  hunk,
  REPO,
  SESSION,
  testResult,
  tsOf,
} from "./test-helpers.js";

describe("mergeSameFileFacts", () => {
  it("keeps the latest fact per type and file within a batch", () => {
    const entries: SequencedFact[] = [
      { fact: hunk("src/a.ts", tsOf(0), { added: 1 }), factId: "f1", seq: 1, batchId: 0 },
      { fact: hunk("src/a.ts", tsOf(0, 1), { added: 9 }), factId: "f2", seq: 2, batchId: 0 },
      { fact: fileChanged("src/a.ts", "added", tsOf(0)), factId: "f3", seq: 3, batchId: 0 },
      { fact: fileChanged("src/b.ts", "modified", tsOf(0, 1)), factId: "f4", seq: 4, batchId: 0 },
    ];
    const merged = mergeSameFileFacts(entries);
    expect(merged).toHaveLength(3);
    const hunks = merged.filter((entry) => entry.fact.type === "git_hunk");
    expect(hunks).toHaveLength(1);
    expect((hunks[0]?.fact as Extract<typeof hunks[number]["fact"], { type: "git_hunk" }>).added).toBe(9);
    const changed = merged.filter((entry) => entry.fact.type === "file_changed");
    expect(changed.map((entry) => (entry.fact as Extract<typeof changed[number]["fact"], { type: "file_changed" }>).path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("does not merge command_executed facts", () => {
    const entries: SequencedFact[] = [
      { fact: commandExecuted(tsOf(0), "pnpm a"), factId: "f1", seq: 1, batchId: 0 },
      { fact: commandExecuted(tsOf(0, 1), "pnpm b"), factId: "f2", seq: 2, batchId: 0 },
    ];
    expect(mergeSameFileFacts(entries)).toHaveLength(2);
  });
});

describe("PipelineCoordinator batching", () => {
  it("flushes a 500ms window when a later record exceeds it", () => {
    const coordinator = new PipelineCoordinator();
    coordinator.ingest(fileChanged("src/a.ts", "modified", tsOf(0)));
    coordinator.ingest(hunk("src/a.ts", tsOf(0)));
    expect(coordinator.snapshot().units).toHaveLength(0);
    coordinator.ingest(fileChanged("src/b.ts", "modified", tsOf(0, 2)));
    expect(coordinator.snapshot().units).toHaveLength(1);
    expect(coordinator.snapshot().units[0]?.files).toEqual(["src/a.ts"]);
    coordinator.flush();
    expect(coordinator.snapshot().units.map((unit) => unit.files.join("|")).sort()).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("caps batches at maxBatchSize", () => {
    const coordinator = new PipelineCoordinator({ maxBatchSize: 5 });
    for (let i = 0; i < 12; i += 1) {
      coordinator.ingest(fileChanged(`src/f${i}.ts`, "modified", tsOf(0)));
    }
    coordinator.flush();
    expect(coordinator.snapshot().units).toHaveLength(1);
    expect(coordinator.snapshot().units[0]?.files).toHaveLength(12);
  });

  it("coalesces a burst of flushes into at most one rebuild per trailing idle", () => {
    const defaults = createInMemoryStores();
    let rebuilds = 0;
    const graphStore = {
      upsertNodes: (nodes: Parameters<typeof defaults.graph.upsertNodes>[0]): void => {
        rebuilds += 1;
        defaults.graph.upsertNodes(nodes);
      },
      upsertEdges: (edges: Parameters<typeof defaults.graph.upsertEdges>[0]): void => {
        defaults.graph.upsertEdges(edges);
      },
      nodes: (): ReturnType<typeof defaults.graph.nodes> => defaults.graph.nodes(),
      edges: (): ReturnType<typeof defaults.graph.edges> => defaults.graph.edges(),
      clear: (): void => defaults.graph.clear(),
    };
    const coordinator = new PipelineCoordinator({ maxBatchSize: 3, stores: { graph: graphStore } });
    for (let i = 0; i < 10; i += 1) {
      coordinator.ingest(fileChanged(`src/f${i}.ts`, "modified", tsOf(0)));
    }
    coordinator.flush();
    expect(rebuilds).toBe(2);
    expect(coordinator.snapshot().units).toHaveLength(1);
    expect(coordinator.snapshot().units[0]?.files).toHaveLength(10);
  });

  it("assigns a monotonically increasing sequence", () => {
    const coordinator = new PipelineCoordinator();
    coordinator.ingest(fileChanged("src/a.ts", "modified", tsOf(0)));
    coordinator.ingest(fileChanged("src/b.ts", "modified", tsOf(0, 1)));
    coordinator.flush();
    expect(coordinator.snapshot().sequence).toBe(2);
  });

  it("uses the injected clock for records without timestamps", () => {
    let now = 0;
    const coordinator = new PipelineCoordinator({ clock: () => now });
    const decision = {
      id: "dec-1",
      sessionId: SESSION,
      title: "t",
      context: "c",
      severity: "optional" as const,
      options: [],
      affectedChangeUnits: [],
      evidence: [],
      status: "open" as const,
    };
    coordinator.ingest(decision);
    expect(coordinator.snapshot().decisions).toHaveLength(0);
    now = 600;
    coordinator.ingest({ ...decision, id: "dec-2" });
    expect(coordinator.snapshot().decisions.map((d) => d.id)).toEqual(["dec-1"]);
  });
});

describe("PipelineCoordinator dedup and idempotency", () => {
  it("ignores duplicate records by content", () => {
    const coordinator = new PipelineCoordinator();
    const fact = fileChanged("src/a.ts", "modified", tsOf(0));
    coordinator.ingest(fact);
    coordinator.ingest(fact);
    coordinator.flush();
    const unit = coordinator.snapshot().units[0];
    expect(unit?.files).toEqual(["src/a.ts"]);
    expect(unit?.evidence).toHaveLength(1);
  });

  it("replaying the same stream twice yields identical units", () => {
    const records = [
      fileChanged("src/a.ts", "modified", tsOf(0)),
      hunk("src/a.ts", tsOf(0, 1)),
      fileChanged("src/b.ts", "added", tsOf(0, 2)),
      testResult(tsOf(0, 3), { passed: 2 }),
    ];
    const first = new PipelineCoordinator();
    for (const record of records) first.ingest(record);
    first.flush();
    const second = new PipelineCoordinator();
    for (const record of [...records, ...records]) second.ingest(record);
    second.flush();
    const firstKey = first.snapshot().units.map((unit) => `${unit.category}:${unit.files.join("|")}`).sort();
    const secondKey = second.snapshot().units.map((unit) => `${unit.category}:${unit.files.join("|")}`).sort();
    expect(secondKey).toEqual(firstKey);
  });
});

describe("PipelineCoordinator stale-result discard", () => {
  function buildUnit(coordinator: PipelineCoordinator): string {
    coordinator.ingest(fileChanged("src/a.ts", "modified", tsOf(0)));
    coordinator.flush();
    const unit = coordinator.snapshot().units[0];
    expect(unit).toBeDefined();
    return unit?.id ?? "";
  }

  it("discards a label result older than the current decision version", () => {
    const coordinator = new PipelineCoordinator();
    const unitId = buildUnit(coordinator);
    const version = coordinator.decisionVersionOf(unitId);
    expect(coordinator.applyLabelResult({ changeUnitId: unitId, decisionVersion: version - 1, patch: { title: "stale" } })).toBe(false);
    expect(coordinator.getUnit(unitId)?.title).not.toBe("stale");
  });

  it("applies a label result at the current version and preserves it across unrelated rebuilds", () => {
    const coordinator = new PipelineCoordinator();
    const unitId = buildUnit(coordinator);
    const version = coordinator.decisionVersionOf(unitId);
    expect(coordinator.applyLabelResult({ changeUnitId: unitId, decisionVersion: version, patch: { title: "labeled", category: "architecture" } })).toBe(true);
    expect(coordinator.getUnit(unitId)?.title).toBe("labeled");
    coordinator.ingest(fileChanged("src/z.ts", "modified", tsOf(5)));
    coordinator.flush();
    expect(coordinator.getUnit(unitId)?.title).toBe("labeled");
    expect(coordinator.getUnit(unitId)?.category).toBe("architecture");
  });

  it("drops a label overlay once the unit changes version", () => {
    const coordinator = new PipelineCoordinator();
    const unitId = buildUnit(coordinator);
    const version = coordinator.decisionVersionOf(unitId);
    expect(coordinator.applyLabelResult({ changeUnitId: unitId, decisionVersion: version, patch: { title: "labeled" } })).toBe(true);
    coordinator.ingest(fileChanged("src/a.ts", "deleted", tsOf(1)));
    coordinator.flush();
    expect(coordinator.decisionVersionOf(unitId)).toBe(version + 1);
    expect(coordinator.getUnit(unitId)?.title).not.toBe("labeled");
    expect(coordinator.applyLabelResult({ changeUnitId: unitId, decisionVersion: version, patch: { title: "late" } })).toBe(false);
  });
});

describe("PipelineCoordinator supersede", () => {
  it("marks units containing superseded files as superseded", () => {
    const coordinator = new PipelineCoordinator();
    coordinator.ingest(fileChanged("src/a.ts", "modified", tsOf(0)));
    coordinator.ingest(fileChanged("src/b.ts", "modified", tsOf(0, 1)));
    coordinator.flush();
    coordinator.markSuperseded(["src/a.ts"]);
    const unit = coordinator.snapshot().units.find((candidate) => candidate.files.includes("src/a.ts"));
    expect(unit?.status).toBe("superseded");
  });
});

describe("PipelineCoordinator semantic event emission", () => {
  it("emits deterministic events with attached changeUnitId", () => {
    const coordinator = new PipelineCoordinator();
    coordinator.ingest(fileChanged("src/a.ts", "modified", tsOf(0)));
    coordinator.flush();
    const events = coordinator.snapshot().events;
    expect(events).toHaveLength(1);
    expect(events[0]?.changeUnitId).toBeDefined();
    expect(events[0]?.kind).toBe("implementation_change");
  });

  it("attaches changeUnitId to ingested semantic events", () => {
    const coordinator = new PipelineCoordinator();
    coordinator.ingest(fileChanged("src/a.ts", "modified", tsOf(0)));
    coordinator.ingest({
      id: "se-1",
      sessionId: SESSION,
      kind: "architecture_change",
      summary: "label",
      evidence: [],
      files: ["src/a.ts"],
      symbols: [],
      createdAt: tsOf(0, 1),
    });
    coordinator.flush();
    const event = coordinator.snapshot().events.find((candidate) => candidate.id === "se-1");
    expect(event?.changeUnitId).toBeDefined();
    const unit = coordinator.snapshot().units[0];
    expect(unit?.category).toBe("architecture");
  });
});

describe("parseReplayLine", () => {
  it("parses agent events, facts, semantic events, and decisions", () => {
    const agent = parseReplayLine(JSON.stringify(agentEvent("agent_started", tsOf(0), { prompt: "p" })));
    expect(agent).toMatchObject({ type: "agent_started" });
    const fact = parseReplayLine(JSON.stringify(fileChanged("src/a.ts", "modified", tsOf(0))));
    expect(fact).toMatchObject({ type: "file_changed", repoId: REPO });
    const event = parseReplayLine(
      JSON.stringify({
        id: "se-1",
        sessionId: SESSION,
        kind: "behavior_change",
        summary: "s",
        evidence: [],
        files: ["src/a.ts"],
        symbols: [],
        createdAt: tsOf(0),
      }),
    );
    expect(event).toMatchObject({ id: "se-1" });
    const decision = parseReplayLine(
      JSON.stringify({
        id: "dec-1",
        sessionId: SESSION,
        title: "t",
        context: "c",
        severity: "optional",
        options: [],
        affectedChangeUnits: [],
        evidence: [],
        status: "open",
      }),
    );
    expect(decision).toMatchObject({ id: "dec-1" });
    expect(parseReplayLine("")).toBeNull();
  });

  it("throws for unknown records", () => {
    expect(() => parseReplayLine('{"type":"totally_unknown"}')).toThrow();
  });
});

describe("applyPatch", () => {
  it("leaves unset fields untouched", () => {
    const unit = {
      id: "u1",
      sessionId: SESSION,
      title: "t",
      category: "implementation" as const,
      status: "detected" as const,
      files: ["src/a.ts"],
      symbols: [],
      interfacesChanged: [],
      schemaChanges: [],
      dependencyChanges: [],
      relatedDecisions: [],
      validationResults: [],
      evidence: ["e1"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const patched = applyPatch(unit, { importance: 0.5 });
    expect(patched.importance).toBe(0.5);
    expect(patched.title).toBe("t");
    expect(patched.category).toBe("implementation");
  });
});
