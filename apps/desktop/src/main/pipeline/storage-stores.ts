import { canonicalJson, DecisionSchema } from "@jevcode/contracts";
import type {
  ChangeUnit,
  Decision,
  SemanticEvent,
  ValidationResult,
} from "@jevcode/contracts";
import type { JevcodeDb } from "@jevcode/storage";
import type {
  ChangeUnitStore,
  DecisionStore,
  FailureRecord,
  GraphEdge,
  GraphNode,
  GraphStore,
  PipelineStores,
  SemanticEventSink,
  ValidationStore,
} from "@jevcode/semantic-core";

export interface StorageStoresOptions {
  onSemanticEvent?: (event: SemanticEvent) => void;
  persistSemanticEvents?: boolean;
}

export function createStorageStores(
  db: JevcodeDb,
  sessionId: string,
  options: StorageStoresOptions = {},
): PipelineStores {
  return {
    units: new StorageChangeUnitStore(db, sessionId),
    graph: new StorageGraphStore(db, sessionId),
    events: new StorageSemanticEventSink(
      options.onSemanticEvent,
      options.persistSemanticEvents === true
        ? (event) => {
            db.appendSemanticEvent(sessionId, event);
          }
        : undefined,
    ),
    validations: new StorageValidationStore(db, sessionId),
    decisions: new StorageDecisionStore(db, sessionId),
  };
}

class StorageChangeUnitStore implements ChangeUnitStore {
  private readonly lastJson = new Map<string, string>();

  constructor(
    private readonly db: JevcodeDb,
    private readonly sessionId: string,
  ) {}

  upsert(unit: ChangeUnit): void {
    const json = JSON.stringify(unit);
    if (this.lastJson.get(unit.id) === json) return;
    this.db.upsertChangeUnit(unit);
    this.lastJson.set(unit.id, json);
  }

  get(id: string): ChangeUnit | undefined {
    return this.db.getChangeUnit(id);
  }

  all(): ChangeUnit[] {
    return this.db.listChangeUnits(this.sessionId);
  }

  remove(id: string): void {
    const unit = this.db.getChangeUnit(id);
    if (unit !== undefined) this.supersede(unit);
  }

  clear(): void {
    for (const unit of this.db.listChangeUnits(this.sessionId)) this.supersede(unit);
  }

  // Every rebuild, the coordinator removes each stored unit its projection no longer has, and a
  // removed unit stays stored as superseded, so it is removed again on every later rebuild. A unit
  // the database already holds as superseded would be written with an identical payload, so it is
  // skipped (PL-2: one such row per rebuild before). The write replaces the row upsert() last wrote,
  // so its cached payload is dropped: a unit the projection brings back unchanged is written again.
  private supersede(unit: ChangeUnit): void {
    if (unit.status === "superseded") return;
    this.lastJson.delete(unit.id);
    this.db.upsertChangeUnit({ ...unit, status: "superseded" });
  }
}

class StorageGraphStore implements GraphStore {
  private readonly lastNodes = new Map<string, string>();
  private readonly lastEdges = new Map<string, string>();

  constructor(
    private readonly db: JevcodeDb,
    private readonly sessionId: string,
  ) {}

  upsertNodes(nodes: readonly GraphNode[]): void {
    for (const node of nodes) {
      const json = JSON.stringify(node);
      if (this.lastNodes.get(node.id) === json) continue;
      this.db.upsertGraphNode(this.sessionId, {
        id: node.id,
        nodeType: node.type,
        payload: { label: node.label, ...(node.data ?? {}) },
      });
      this.lastNodes.set(node.id, json);
    }
  }

  upsertEdges(edges: readonly GraphEdge[]): void {
    for (const edge of edges) {
      const json = JSON.stringify(edge);
      if (this.lastEdges.get(edge.id) === json) continue;
      this.db.upsertGraphEdge(this.sessionId, {
        id: edge.id,
        fromId: edge.from,
        toId: edge.to,
        edgeType: edge.type,
        payload: {},
      });
      this.lastEdges.set(edge.id, json);
    }
  }

  nodes(): GraphNode[] {
    return this.db.listGraphNodes(this.sessionId).map((record) => ({
      id: record.id,
      sessionId: record.sessionId,
      type: record.nodeType as GraphNode["type"],
      label: String(record.payload["label"] ?? record.id),
      data: record.payload,
    }));
  }

  edges(): GraphEdge[] {
    return this.db.listGraphEdges(this.sessionId).map((record) => ({
      id: record.id,
      sessionId: record.sessionId,
      from: record.fromId,
      to: record.toId,
      type: record.edgeType as GraphEdge["type"],
    }));
  }

  clear(): void {
    // graph nodes/edges are idempotently upserted; no projection removal in v0
  }
}

class StorageSemanticEventSink implements SemanticEventSink {
  private readonly byId = new Map<string, SemanticEvent>();
  private readonly order: string[] = [];

  constructor(
    private readonly onEmit?: (event: SemanticEvent) => void,
    private readonly persist?: (event: SemanticEvent) => void,
  ) {}

  emit(event: SemanticEvent): void {
    if (!this.byId.has(event.id)) {
      this.order.push(event.id);
      this.onEmit?.(event);
      this.persist?.(event);
    } else {
      const previous = this.byId.get(event.id);
      if (previous !== undefined && previous.changeUnitId !== event.changeUnitId) {
        this.onEmit?.(event);
        this.persist?.(event);
      }
    }
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

// Every store write appends an event row, and the coordinator re-upserts every
// validation, failure and decision on each rebuild. Like the change-unit store,
// these stores write only when the payload differs from the last one written for
// that id. Only this store writes validation and failure rows, so a private map
// of the last payload is the database's current row. Each map is set after its
// write succeeds, so a write that throws is tried again on the next rebuild.
class StorageValidationStore implements ValidationStore {
  private readonly lastValidationJson = new Map<string, string>();
  private readonly lastFailureJson = new Map<string, string>();

  constructor(
    private readonly db: JevcodeDb,
    private readonly sessionId: string,
  ) {}

  upsertValidation(validation: ValidationResult): void {
    const json = JSON.stringify(validation);
    if (this.lastValidationJson.get(validation.id) === json) return;
    this.db.upsertValidation(this.sessionId, validation);
    this.lastValidationJson.set(validation.id, json);
  }

  upsertFailure(failure: FailureRecord): void {
    const json = JSON.stringify(failure);
    if (this.lastFailureJson.get(failure.id) === json) return;
    this.db.upsertFailure(this.sessionId, {
      validationId: failure.validationId,
      file: failure.file,
      testName: failure.testName,
      message: failure.message,
      ts: failure.ts,
    });
    this.lastFailureJson.set(failure.id, json);
  }

  validations(): ValidationResult[] {
    return this.db.listValidations(this.sessionId);
  }

  failures(): FailureRecord[] {
    return this.db.listFailures(this.sessionId).map((record) => ({
      id: record.id ?? `${record.validationId}:${record.file}:${record.testName}`,
      sessionId: record.sessionId,
      validationId: record.validationId,
      file: record.file,
      testName: record.testName,
      message: record.message,
      ts: record.ts,
    }));
  }

  clear(): void {
    // no v0 removal path; rebuild-on-boot derives projections from events
  }
}

// The runtime also writes each incoming decision record straight to the database,
// so a private map of the last payload can go stale: the store compares against the
// database's current row instead. The decisions projection keeps neither `ts` nor
// the option order, so both sides are compared in that projected form.
function projectedDecisionJson(decision: Decision | undefined): string | null {
  const parsed = DecisionSchema.safeParse(decision);
  if (!parsed.success) return null;
  const { ts: _ts, ...rest } = parsed.data;
  const options = [...rest.options].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return canonicalJson({ ...rest, options });
}

class StorageDecisionStore implements DecisionStore {
  constructor(
    private readonly db: JevcodeDb,
    private readonly sessionId: string,
  ) {}

  upsert(decision: Decision): void {
    const next = projectedDecisionJson(decision);
    if (next !== null && next === projectedDecisionJson(this.db.getDecision(decision.id))) return;
    this.db.upsertDecision(decision);
  }

  get(id: string): Decision | undefined {
    return this.db.getDecision(id);
  }

  all(): Decision[] {
    return this.db.listDecisions(this.sessionId);
  }

  clear(): void {
    // decisions are upserted by id; answered/expired states overwrite open ones
  }
}
