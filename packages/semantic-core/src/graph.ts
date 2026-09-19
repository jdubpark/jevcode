import type {
  ChangeUnit,
  Decision,
  EvidenceFact,
  NormalizedAgentEvent,
  ValidationResult,
} from "@jevcode/contracts";

import { hashId } from "./ids.js";
import type { FailureRecord, GraphEdge, GraphEdgeType, GraphNode, GraphNodeType } from "./persistence.js";
import type { SequencedFact } from "./clustering.js";

export interface GraphInput {
  sessionId: string;
  taskPrompt?: string;
  units: readonly ChangeUnit[];
  facts: readonly SequencedFact[];
  agentEvents: readonly NormalizedAgentEvent[];
  decisions: readonly Decision[];
  validations: readonly ValidationResult[];
  failures: readonly FailureRecord[];
  unitEvidenceFacts: ReadonlyMap<string, SequencedFact[]>;
  importEdges: readonly { from: string; to: string; weight: number }[];
  packageImports: readonly { file: string; packageName: string }[];
  fileKinds: ReadonlyMap<string, "added" | "modified" | "deleted">;
  failureUnitIds: ReadonlyMap<string, string[]>;
}

export interface GraphProjection {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

function nodeId(prefix: string, sessionId: string, key: string): string {
  return hashId(prefix, sessionId, key);
}

export function projectGraph(input: GraphInput): GraphProjection {
  const { sessionId } = input;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeSet = new Set<string>();
  const edgeSet = new Set<string>();

  const factOwnerUnit = new Map<EvidenceFact, string>();
  for (const [unitId, entries] of input.unitEvidenceFacts) {
    for (const entry of entries) factOwnerUnit.set(entry.fact, unitId);
  }
  const importSymbolNodeByFile = new Map<string, string>();
  for (const entry of input.facts) {
    if (entry.fact.type !== "symbol_delta") continue;
    const path = entry.fact.path;
    if (importSymbolNodeByFile.has(path)) continue;
    const symbol = [...entry.fact.added, ...entry.fact.modified].find(
      (candidate) => candidate.kind === "import" || candidate.kind === "export",
    );
    if (symbol !== undefined) {
      importSymbolNodeByFile.set(path, nodeId("sym", sessionId, symbol.name));
    }
  }
  const unitById = new Map(input.units.map((unit) => [unit.id, unit]));

  const addNode = (type: GraphNodeType, id: string, label: string, data?: Record<string, unknown>): void => {
    if (nodeSet.has(id)) return;
    nodeSet.add(id);
    nodes.push({ id, sessionId, type, label, data });
  };

  const addEdge = (type: GraphEdgeType, from: string, to: string): void => {
    if (from === "" || to === "") return;
    const key = `${from}\u0000${to}\u0000${type}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edges.push({ id: hashId("edge", sessionId, key), sessionId, from, to, type });
  };

  const taskId = nodeId("task", sessionId, "task");
  if (input.taskPrompt !== undefined && input.taskPrompt !== "") {
    addNode("Task", taskId, "Task", { prompt: input.taskPrompt });
  }

  const unitNodeIds = new Map<string, string>();
  for (const unit of input.units) {
    const id = nodeId("node", sessionId, unit.id);
    unitNodeIds.set(unit.id, id);
    addNode("ChangeUnit", id, unit.title, { category: unit.category, status: unit.status });
    if (nodeSet.has(taskId)) addEdge("IMPLEMENTS", id, taskId);
    if (nodeSet.has(taskId)) addEdge("AFFECTS", taskId, id);
  }

  const fileNodeIds = new Map<string, string>();
  for (const unit of input.units) {
    const unitNode = unitNodeIds.get(unit.id) ?? "";
    for (const file of unit.files) {
      let fileNode = fileNodeIds.get(file);
      if (fileNode === undefined) {
        fileNode = nodeId("file", sessionId, file);
        fileNodeIds.set(file, fileNode);
        addNode("File", fileNode, file);
      }
      addEdge("MODIFIES", unitNode, fileNode);
    }
  }

  const symbolNodeIds = new Map<string, string>();
  for (const unit of input.units) {
    const unitNode = unitNodeIds.get(unit.id) ?? "";
    for (const symbol of unit.symbols) {
      let symbolNode = symbolNodeIds.get(symbol.name);
      if (symbolNode === undefined) {
        symbolNode = nodeId("sym", sessionId, symbol.name);
        symbolNodeIds.set(symbol.name, symbolNode);
        addNode("Symbol", symbolNode, symbol.name, { kind: symbol.kind });
      }
      addEdge("MODIFIES", unitNode, symbolNode);
    }
  }

  for (const entry of input.facts) {
    const fact = entry.fact;
    const owner = factOwnerUnit.get(fact) ?? null;
    const ownerNode = owner !== null ? unitNodeIds.get(owner) ?? "" : "";
    if (fact.type === "file_changed") {
      const fileNode = fileNodeIds.get(fact.path);
      if (fileNode !== undefined && ownerNode !== "") {
        if (fact.kind === "added") addEdge("ADDS", ownerNode, fileNode);
        else if (fact.kind === "deleted") addEdge("REMOVES", ownerNode, fileNode);
        else addEdge("MODIFIES", ownerNode, fileNode);
      }
    }
    if (fact.type === "symbol_delta") {
      const ownerSymbols = owner !== null ? unitById.get(owner)?.symbols ?? [] : [];
      const addedNames = new Set(fact.added.map((symbol) => symbol.name));
      const removedNames = new Set(fact.removed.map((symbol) => symbol.name));
      const ownerSymbolNames = new Set(ownerSymbols.map((symbol) => symbol.name));
      for (const symbol of [...fact.added, ...fact.modified, ...fact.removed]) {
        const symbolNode = symbolNodeIds.get(symbol.name);
        if (symbolNode === undefined || ownerNode === "") continue;
        if (!ownerSymbolNames.has(symbol.name)) continue;
        if (addedNames.has(symbol.name)) addEdge("ADDS", ownerNode, symbolNode);
        else if (removedNames.has(symbol.name)) addEdge("REMOVES", ownerNode, symbolNode);
        else addEdge("MODIFIES", ownerNode, symbolNode);
      }
    }
    if (fact.type === "dependency_change") {
      const manifestNode = fileNodeIds.get(fact.manifest);
      if (manifestNode !== undefined && ownerNode !== "") {
        addEdge("MODIFIES", ownerNode, manifestNode);
      }
      for (const added of fact.added) {
        const depNode = nodeId("dep", sessionId, `${added.name}@${added.version}`);
        addNode("Dependency", depNode, `${added.name}@${added.version}`);
        addEdge("DEPENDS_ON", ownerNode, depNode);
      }
      for (const removed of fact.removed) {
        const depNode = nodeId("dep", sessionId, `${removed.name}@${removed.version}`);
        addNode("Dependency", depNode, `${removed.name}@${removed.version}`);
        addEdge("DEPENDS_ON", ownerNode, depNode);
      }
    }
    if (fact.type === "command_executed") {
      const commandNode = nodeId("cmd", sessionId, fact.command);
      addNode("Command", commandNode, fact.command, { isDestructive: fact.isDestructive });
      if (ownerNode !== "") addEdge("REQUIRES", ownerNode, commandNode);
    }
  }

  for (const edge of input.importEdges) {
    const fromSymbolNode = importSymbolNodeByFile.get(edge.from) ?? null;
    const toSymbolNode = importSymbolNodeByFile.get(edge.to) ?? null;
    if (fromSymbolNode !== null && toSymbolNode !== null) {
      addEdge("DEPENDS_ON", fromSymbolNode, toSymbolNode);
    }
    const fromFile = fileNodeIds.get(edge.from);
    const toFile = fileNodeIds.get(edge.to);
    if (fromFile !== undefined && toFile !== undefined) {
      addEdge("DEPENDS_ON", fromFile, toFile);
    }
  }

  for (const unit of input.units) {
    const unitNode = unitNodeIds.get(unit.id) ?? "";
    for (const file of unit.files) {
      if (file.includes("migrations/") || file.endsWith(".sql")) {
        const fileNode = fileNodeIds.get(file);
        if (fileNode !== undefined) addEdge("REQUIRES", unitNode, fileNode);
      }
    }
  }

  const dependencyNames = new Set(
    input.facts
      .filter((entry): entry is SequencedFact & { fact: Extract<EvidenceFact, { type: "dependency_change" }> } =>
        entry.fact.type === "dependency_change",
      )
      .flatMap((entry) => [...entry.fact.added, ...entry.fact.removed].map((dep) => dep.name)),
  );
  for (const importRef of input.packageImports) {
    if (!dependencyNames.has(importRef.packageName)) continue;
    const symbolNode = importSymbolNodeByFile.get(importRef.file) ?? null;
    if (symbolNode === null) continue;
    const depNode = nodeId("dep", sessionId, importRef.packageName);
    addNode("Dependency", depNode, importRef.packageName);
    addEdge("DEPENDS_ON", symbolNode, depNode);
  }

  for (const validation of input.validations) {
    const validationNode = nodeId("val", sessionId, validation.id);
    addNode("Validation", validationNode, validation.command, {
      status: validation.status,
      passed: validation.passed,
      failed: validation.failed,
    });
    for (const unit of input.units) {
      if (!unit.validationResults.includes(validation.id)) continue;
      const unitNode = unitNodeIds.get(unit.id) ?? "";
      addEdge("VALIDATES", validationNode, unitNode);
      addEdge("EVIDENCED_BY", unitNode, validationNode);
    }
  }

  for (const failure of input.failures) {
    const failureNode = nodeId("fail", sessionId, failure.id);
    addNode("Failure", failureNode, failure.testName, { file: failure.file });
    const hosts = input.failureUnitIds.get(failure.id) ?? [];
    for (const hostId of hosts) {
      const unitNode = unitNodeIds.get(hostId) ?? "";
      addEdge("FAILS", failureNode, unitNode);
      addEdge("CAUSED_BY", failureNode, unitNode);
    }
    const validationNode = nodeId("val", sessionId, failure.validationId);
    addEdge("FAILS", validationNode, failureNode);
  }

  for (const decision of input.decisions) {
    const decisionNode = nodeId("dec", sessionId, decision.id);
    addNode("Decision", decisionNode, decision.title, { severity: decision.severity, status: decision.status });
    for (const unit of input.units) {
      if (!unit.relatedDecisions.includes(decision.id)) continue;
      const unitNode = unitNodeIds.get(unit.id) ?? "";
      addEdge("AFFECTS", decisionNode, unitNode);
      addEdge("IMPLEMENTS", unitNode, decisionNode);
    }
    for (const ref of decision.evidence) {
      for (const unit of input.units) {
        if (!unit.evidence.includes(ref)) continue;
        const unitNode = unitNodeIds.get(unit.id) ?? "";
        addEdge("EXPLAINS", decisionNode, unitNode);
      }
    }
  }

  for (const event of input.agentEvents) {
    const eventNode = nodeId("evt", sessionId, event.type + event.ts);
    addNode("AgentEvent", eventNode, event.type, { ts: event.ts });
    const windowUnit = findUnitContainingTs(event.ts, input.units);
    if (windowUnit !== null) {
      const unitNode = unitNodeIds.get(windowUnit) ?? "";
      addEdge("EVIDENCED_BY", unitNode, eventNode);
    }
  }

  for (const unit of input.units) {
    if (unit.status !== "superseded") continue;
    const unitNode = unitNodeIds.get(unit.id) ?? "";
    for (const candidate of input.units) {
      if (candidate.id === unit.id) continue;
      const overlap = candidate.files.some((file) => unit.files.includes(file));
      if (!overlap) continue;
      const candidateNode = unitNodeIds.get(candidate.id) ?? "";
      addEdge("SUPERSEDES", unitNode, candidateNode);
    }
  }

  return { nodes, edges };
}

function findUnitContainingTs(ts: string, units: readonly ChangeUnit[]): string | null {
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return null;
  for (const unit of units) {
    const start = Date.parse(unit.createdAt);
    const end = Date.parse(unit.updatedAt);
    if (Number.isFinite(start) && Number.isFinite(end) && ms >= start && ms <= end) {
      return unit.id;
    }
  }
  return null;
}
