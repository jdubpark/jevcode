import { canonicalJson, DecisionSchema } from "@jevcode/contracts";
import type {
  ChangeUnit,
  Decision,
  SemanticEvent,
  ValidationResult,
} from "@jevcode/contracts";
import { GraphEdgeRecordSchema, GraphNodeRecordSchema } from "@jevcode/storage";
import type { EventStoreType, GraphEdgeRecord, GraphNodeRecord, JevcodeDb } from "@jevcode/storage";
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

/**
 * A projection list read from the database and reused while the database applies no row of its type (lane 07 PL-3).
 * One sync pass read the session's change units seven times at a turn end (the rebuild, the snapshots, the session
 * state), 15 ms each at 1,459 units. The list is the database's own read, so it holds what a new read would, in the
 * same order; each caller gets its own array. The objects are shared: no reader changes them.
 */
class ProjectionCache<T extends { id: string }> {
  private version = -1;
  private items: T[] = [];
  private readonly at = new Map<string, number>();

  constructor(
    private readonly db: JevcodeDb,
    private readonly type: EventStoreType,
    private readonly read: () => T[],
  ) {}

  list(): T[] {
    const version = this.db.projectionVersion(this.type);
    if (version !== this.version) {
      this.items = this.read();
      this.at.clear();
      this.items.forEach((item, index) => this.at.set(item.id, index));
      this.version = version;
    }
    return [...this.items];
  }

  /**
   * After the store's own write of one row, given as a fresh read returns it: the list takes it in place of a read.
   * For a list read in rowid order (no ORDER BY; the graph tables), an upsert keeps a row's place and a new row comes
   * last. Taken only when that write is the one row applied since the list was current; otherwise the next list()
   * reads, so another writer's rows are never missed.
   */
  wrote(item: T): void {
    if (this.db.projectionVersion(this.type) !== this.version + 1) return;
    const index = this.at.get(item.id);
    if (index === undefined) {
      this.at.set(item.id, this.items.length);
      this.items.push(item);
    } else {
      this.items[index] = item;
    }
    this.version += 1;
  }
}

function graphNodeOf(record: GraphNodeRecord): GraphNode {
  return {
    id: record.id,
    sessionId: record.sessionId,
    type: record.nodeType as GraphNode["type"],
    label: String(record.payload["label"] ?? record.id),
    data: record.payload,
  };
}

function graphEdgeOf(record: GraphEdgeRecord): GraphEdge {
  return {
    id: record.id,
    sessionId: record.sessionId,
    from: record.fromId,
    to: record.toId,
    type: record.edgeType as GraphEdge["type"],
  };
}

class StorageChangeUnitStore implements ChangeUnitStore {
  private readonly lastJson = new Map<string, string>();
  private readonly units: ProjectionCache<ChangeUnit>;

  constructor(
    private readonly db: JevcodeDb,
    sessionId: string,
  ) {
    this.units = new ProjectionCache(db, "change_unit", () => db.listChangeUnits(sessionId));
  }

  upsert(unit: ChangeUnit): void {
    // Key order ignored: a label write rebuilds the unit from its database row, whose keys come in column order,
    // while the rebuild writes the projection's order. The stored payload is the same either way (PL-2).
    const json = canonicalJson(unit);
    if (this.lastJson.get(unit.id) === json) return;
    this.db.upsertChangeUnit(unit);
    this.lastJson.set(unit.id, json);
  }

  get(id: string): ChangeUnit | undefined {
    return this.db.getChangeUnit(id);
  }

  all(): ChangeUnit[] {
    return this.units.list();
  }

  remove(id: string): void {
    const unit = this.db.getChangeUnit(id);
    if (unit !== undefined) this.supersede(unit);
  }

  clear(): void {
    for (const unit of this.all()) this.supersede(unit);
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
  private readonly nodeList: ProjectionCache<GraphNode>;
  private readonly edgeList: ProjectionCache<GraphEdge>;

  constructor(
    private readonly db: JevcodeDb,
    private readonly sessionId: string,
  ) {
    this.nodeList = new ProjectionCache(db, "graph_node", () => db.listGraphNodes(sessionId).map(graphNodeOf));
    this.edgeList = new ProjectionCache(db, "graph_edge", () => db.listGraphEdges(sessionId).map(graphEdgeOf));
  }

  // A rebuild writes the graph rows that changed, and every snapshot lists the graph: 15,000 edges and 6,000 nodes at
  // 2,937 units, 40-70 ms to read and parse again. The lists take the rows this store writes, parsed as listGraphNodes
  // and listGraphEdges parse them, so a snapshot after a rebuild reads nothing (lane 07 PL-3).

  upsertNodes(nodes: readonly GraphNode[]): void {
    for (const node of nodes) {
      const json = JSON.stringify(node);
      if (this.lastNodes.get(node.id) === json) continue;
      const stored = this.db.upsertGraphNode(this.sessionId, {
        id: node.id,
        nodeType: node.type,
        payload: { label: node.label, ...(node.data ?? {}) },
      });
      this.nodeList.wrote(graphNodeOf(GraphNodeRecordSchema.parse(JSON.parse(stored.payloadJson))));
      this.lastNodes.set(node.id, json);
    }
  }

  upsertEdges(edges: readonly GraphEdge[]): void {
    for (const edge of edges) {
      const json = JSON.stringify(edge);
      if (this.lastEdges.get(edge.id) === json) continue;
      const stored = this.db.upsertGraphEdge(this.sessionId, {
        id: edge.id,
        fromId: edge.from,
        toId: edge.to,
        edgeType: edge.type,
        payload: {},
      });
      this.edgeList.wrote(graphEdgeOf(GraphEdgeRecordSchema.parse(JSON.parse(stored.payloadJson))));
      this.lastEdges.set(edge.id, json);
    }
  }

  nodes(): GraphNode[] {
    return this.nodeList.list();
  }

  edges(): GraphEdge[] {
    return this.edgeList.list();
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

  // Written, then listed and marked, then announced. An event whose write throws is neither listed nor marked, so the
  // next rebuild writes it and lists it once (PL-2). One whose listener throws is already marked, so no rebuild writes
  // or lists it again (fix wave minor 5).
  emit(event: SemanticEvent): void {
    const previous = this.byId.get(event.id);
    if (previous !== undefined && previous.changeUnitId === event.changeUnitId) {
      this.byId.set(event.id, event);
      return;
    }
    this.persist?.(event);
    if (previous === undefined) this.order.push(event.id);
    this.byId.set(event.id, event);
    this.onEmit?.(event);
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
