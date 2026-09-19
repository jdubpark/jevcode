import type {
  ChangeUnit,
  Decision,
  SemanticEvent,
  ValidationResult,
} from "@jevcode/contracts";

export type GraphNodeType =
  | "Task"
  | "ChangeUnit"
  | "File"
  | "Symbol"
  | "Dependency"
  | "Decision"
  | "Validation"
  | "Failure"
  | "Command"
  | "AgentEvent";

export type GraphEdgeType =
  | "MODIFIES"
  | "ADDS"
  | "REMOVES"
  | "DEPENDS_ON"
  | "AFFECTS"
  | "VALIDATES"
  | "FAILS"
  | "REQUIRES"
  | "IMPLEMENTS"
  | "EXPLAINS"
  | "EVIDENCED_BY"
  | "SUPERSEDES"
  | "CAUSED_BY";

export interface GraphNode {
  id: string;
  sessionId: string;
  type: GraphNodeType;
  label: string;
  data?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  sessionId: string;
  from: string;
  to: string;
  type: GraphEdgeType;
}

export interface FailureRecord {
  id: string;
  sessionId: string;
  validationId: string;
  file: string;
  testName: string;
  message: string;
  ts: string;
}

export interface ChangeUnitStore {
  upsert(unit: ChangeUnit): void;
  get(id: string): ChangeUnit | undefined;
  all(): ChangeUnit[];
  remove(id: string): void;
  clear(): void;
}

export interface GraphStore {
  upsertNodes(nodes: readonly GraphNode[]): void;
  upsertEdges(edges: readonly GraphEdge[]): void;
  nodes(): GraphNode[];
  edges(): GraphEdge[];
  clear(): void;
}

export interface SemanticEventSink {
  emit(event: SemanticEvent): void;
  all(): SemanticEvent[];
  clear(): void;
}

export interface ValidationStore {
  upsertValidation(validation: ValidationResult): void;
  upsertFailure(failure: FailureRecord): void;
  validations(): ValidationResult[];
  failures(): FailureRecord[];
  clear(): void;
}

export interface DecisionStore {
  upsert(decision: Decision): void;
  get(id: string): Decision | undefined;
  all(): Decision[];
  clear(): void;
}

export interface PipelineStores {
  units: ChangeUnitStore;
  graph: GraphStore;
  events: SemanticEventSink;
  validations: ValidationStore;
  decisions: DecisionStore;
}

export class InMemoryChangeUnitStore implements ChangeUnitStore {
  private readonly byId = new Map<string, ChangeUnit>();

  upsert(unit: ChangeUnit): void {
    this.byId.set(unit.id, unit);
  }

  get(id: string): ChangeUnit | undefined {
    return this.byId.get(id);
  }

  all(): ChangeUnit[] {
    return [...this.byId.values()];
  }

  remove(id: string): void {
    this.byId.delete(id);
  }

  clear(): void {
    this.byId.clear();
  }
}

export class InMemoryGraphStore implements GraphStore {
  private readonly nodeMap = new Map<string, GraphNode>();
  private readonly edgeMap = new Map<string, GraphEdge>();

  upsertNodes(nodes: readonly GraphNode[]): void {
    for (const node of nodes) this.nodeMap.set(node.id, node);
  }

  upsertEdges(edges: readonly GraphEdge[]): void {
    for (const edge of edges) this.edgeMap.set(edge.id, edge);
  }

  nodes(): GraphNode[] {
    return [...this.nodeMap.values()];
  }

  edges(): GraphEdge[] {
    return [...this.edgeMap.values()];
  }

  clear(): void {
    this.nodeMap.clear();
    this.edgeMap.clear();
  }
}

export class InMemorySemanticEventSink implements SemanticEventSink {
  private readonly byId = new Map<string, SemanticEvent>();
  private readonly order: string[] = [];

  emit(event: SemanticEvent): void {
    if (!this.byId.has(event.id)) this.order.push(event.id);
    this.byId.set(event.id, event);
  }

  all(): SemanticEvent[] {
    return this.order
      .map((id) => this.byId.get(id))
      .filter((event): event is SemanticEvent => event !== undefined);
  }

  clear(): void {
    this.byId.clear();
    this.order.length = 0;
  }
}

export class InMemoryValidationStore implements ValidationStore {
  private readonly validationMap = new Map<string, ValidationResult>();
  private readonly failureMap = new Map<string, FailureRecord>();

  upsertValidation(validation: ValidationResult): void {
    this.validationMap.set(validation.id, validation);
  }

  upsertFailure(failure: FailureRecord): void {
    this.failureMap.set(failure.id, failure);
  }

  validations(): ValidationResult[] {
    return [...this.validationMap.values()];
  }

  failures(): FailureRecord[] {
    return [...this.failureMap.values()];
  }

  clear(): void {
    this.validationMap.clear();
    this.failureMap.clear();
  }
}

export class InMemoryDecisionStore implements DecisionStore {
  private readonly byId = new Map<string, Decision>();

  upsert(decision: Decision): void {
    this.byId.set(decision.id, decision);
  }

  get(id: string): Decision | undefined {
    return this.byId.get(id);
  }

  all(): Decision[] {
    return [...this.byId.values()];
  }

  clear(): void {
    this.byId.clear();
  }
}

export function createInMemoryStores(): PipelineStores {
  return {
    units: new InMemoryChangeUnitStore(),
    graph: new InMemoryGraphStore(),
    events: new InMemorySemanticEventSink(),
    validations: new InMemoryValidationStore(),
    decisions: new InMemoryDecisionStore(),
  };
}
