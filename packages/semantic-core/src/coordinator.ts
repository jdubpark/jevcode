import {
  DecisionSchema,
  EvidenceFactSchema,
  NormalizedAgentEventSchema,
  SemanticEventSchema,
  type ChangeCategory,
  type ChangeUnit,
  type Decision,
  type EvidenceFact,
  type NormalizedAgentEvent,
  type SemanticEvent,
  type ValidationResult,
} from "@jevcode/contracts";

import { clusterSession, type SequencedFact } from "./clustering.js";
import { buildSemanticEvent } from "./events.js";
import { projectGraph } from "./graph.js";
import { factContentId } from "./ids.js";
import {
  createInMemoryStores,
  type FailureRecord,
  type PipelineStores,
} from "./persistence.js";

export type PipelineRecord = NormalizedAgentEvent | EvidenceFact | SemanticEvent | Decision;

export interface UnitLabelPatch {
  title?: string;
  intent?: string;
  category?: ChangeCategory;
  importance?: number;
  relevance?: number;
  interruption?: number;
  uncertainty?: number;
  mentalModelChange?: number;
}

export interface UnitLabelResult {
  changeUnitId: string;
  decisionVersion: number;
  patch: UnitLabelPatch;
}

export interface CoordinatorOptions {
  stores?: Partial<PipelineStores>;
  clock?: () => number;
  batchWindowMs?: number;
  maxBatchSize?: number;
  idleGapMs?: number;
  nowIso?: () => string;
  rebuildDebounceMs?: number;
}

export interface PipelineSnapshot {
  units: ChangeUnit[];
  decisions: Decision[];
  validations: ValidationResult[];
  failures: FailureRecord[];
  events: SemanticEvent[];
  graphNodes: import("./persistence.js").GraphNode[];
  graphEdges: import("./persistence.js").GraphEdge[];
  decisionVersions: ReadonlyMap<string, number>;
  sequence: number;
}

interface LabelOverlay {
  version: number;
  patch: UnitLabelPatch;
}

const DEFAULT_BATCH_WINDOW_MS = 500;
const DEFAULT_MAX_BATCH_SIZE = 25;
const DEFAULT_IDLE_GAP_MS = 120_000;

export class PipelineCoordinator {
  private readonly stores: PipelineStores;
  private readonly clock: () => number;
  private readonly batchWindowMs: number;
  private readonly maxBatchSize: number;
  private readonly idleGapMs: number;
  private readonly nowIso: () => string;
  private readonly buffer: PipelineRecord[] = [];
  private readonly sessions = new Map<string, SessionState>();
  private readonly seenFactHashes = new Set<string>();
  private readonly seenAgentEventHashes = new Set<string>();
  private readonly seenEventIds = new Set<string>();
  private readonly seenDecisionIds = new Set<string>();
  private readonly supersedeMarkers = new Set<string>();
  private readonly decisionVersions = new Map<string, number>();
  private readonly unitSignatures = new Map<string, string>();
  private readonly labelOverlays = new Map<string, LabelOverlay>();
  private sequence = 0;
  private bufferStartClock = 0;
  private readonly rebuildDebounceMs: number;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRebuildAtMs = 0;

  constructor(options: CoordinatorOptions = {}) {
    this.clock = options.clock ?? (() => Date.now());
    this.batchWindowMs = options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.idleGapMs = options.idleGapMs ?? DEFAULT_IDLE_GAP_MS;
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.rebuildDebounceMs = options.rebuildDebounceMs ?? 25;
    const provided = options.stores ?? {};
    const defaults = createInMemoryStores();
    this.stores = {
      units: provided.units ?? defaults.units,
      graph: provided.graph ?? defaults.graph,
      events: provided.events ?? defaults.events,
      validations: provided.validations ?? defaults.validations,
      decisions: provided.decisions ?? defaults.decisions,
    };
  }

  ingest(record: PipelineRecord): void {
    this.sequence += 1;
    if (this.buffer.length > 0) {
      const first = this.buffer[0];
      const firstTs = first === undefined ? null : recordTs(first);
      const currentTs = recordTs(record);
      const overWindow =
        firstTs !== null && currentTs !== null
          ? currentTs - firstTs >= this.batchWindowMs
          : firstTs === null && currentTs === null && this.clock() - this.bufferStartClock >= this.batchWindowMs;
      if (overWindow || this.buffer.length >= this.maxBatchSize) this.flushWindow();
    } else {
      this.bufferStartClock = this.clock();
    }
    this.buffer.push(record);
  }

  flush(): void {
    this.flushWindow();
    if (this.rebuildTimer !== null) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
      this.rebuildNow();
    }
  }

  applyLabelResult(result: UnitLabelResult): boolean {
    const current = this.decisionVersions.get(result.changeUnitId) ?? 0;
    if (result.decisionVersion < current) return false;
    const unit = this.stores.units.get(result.changeUnitId);
    if (unit === undefined) return false;
    this.stores.units.upsert(applyPatch(unit, result.patch));
    this.labelOverlays.set(result.changeUnitId, {
      version: result.decisionVersion,
      patch: result.patch,
    });
    return true;
  }

  markSuperseded(files: readonly string[]): void {
    for (const file of files) this.supersedeMarkers.add(file);
    this.rebuildNow();
  }

  getUnit(id: string): ChangeUnit | undefined {
    return this.stores.units.get(id);
  }

  decisionVersionOf(unitId: string): number {
    return this.decisionVersions.get(unitId) ?? 0;
  }

  snapshot(): PipelineSnapshot {
    return {
      units: this.stores.units.all(),
      decisions: this.stores.decisions.all(),
      validations: this.stores.validations.validations(),
      failures: this.stores.validations.failures(),
      events: this.stores.events.all(),
      graphNodes: this.stores.graph.nodes(),
      graphEdges: this.stores.graph.edges(),
      decisionVersions: new Map(this.decisionVersions),
      sequence: this.sequence,
    };
  }

  private flushWindow(): void {
    if (this.buffer.length === 0) return;
    const records = this.buffer.splice(0, this.buffer.length);
    this.drain(records);
    this.requestRebuild();
  }

  // Trailing-edge rebuild debounce: at most one rebuild per burst of flushes;
  // the projection recomputes once a short trailing idle elapses.
  private requestRebuild(): void {
    const now = this.clock();
    if (now - this.lastRebuildAtMs >= this.rebuildDebounceMs) {
      this.rebuildNow();
      return;
    }
    if (this.rebuildTimer !== null) return;
    const timer = setTimeout(() => {
      this.rebuildTimer = null;
      this.rebuildNow();
    }, this.rebuildDebounceMs);
    timer.unref?.();
    this.rebuildTimer = timer;
  }

  private rebuildNow(): void {
    this.lastRebuildAtMs = this.clock();
    this.rebuild();
  }

  private drain(records: readonly PipelineRecord[]): void {
    const windowFacts: SequencedFact[] = [];
    const agentEvents: NormalizedAgentEvent[] = [];
    const semanticEvents: SemanticEvent[] = [];
    for (const record of records) {
      const sessionId = sessionOf(record);
      if (sessionId === null) continue;
      const state = this.stateFor(sessionId);
      const seq = state.nextSeq();
      if (EvidenceFactSchema.safeParse(record).success) {
        const fact = record as EvidenceFact;
        const hash = factContentId(sessionId, fact);
        if (this.seenFactHashes.has(hash)) continue;
        this.seenFactHashes.add(hash);
        windowFacts.push({ fact, factId: hash, seq, batchId: 0 });
        continue;
      }
      if (NormalizedAgentEventSchema.safeParse(record).success) {
        const hash = factContentId(sessionId, record);
        if (this.seenAgentEventHashes.has(hash)) continue;
        this.seenAgentEventHashes.add(hash);
        agentEvents.push(record as NormalizedAgentEvent);
        continue;
      }
      if (SemanticEventSchema.safeParse(record).success) {
        const event = record as SemanticEvent;
        if (this.seenEventIds.has(event.id)) continue;
        this.seenEventIds.add(event.id);
        semanticEvents.push(event);
        continue;
      }
      if (DecisionSchema.safeParse(record).success) {
        const decision = record as Decision;
        if (this.seenDecisionIds.has(decision.id)) {
          state.replaceDecision(decision);
        } else {
          this.seenDecisionIds.add(decision.id);
          state.addDecision(decision);
        }
      }
    }
    const merged = mergeSameFileFacts(windowFacts);
    const windowId = drainWindowId(windowFacts, this.batchWindowMs);
    for (const entry of merged) {
      entry.batchId = windowId;
    }
    for (const entry of merged) {
      this.stateFor(entry.fact.sessionId).addFact(entry);
    }
    for (const event of agentEvents) {
      this.stateFor(event.sessionId).addAgentEvent(event);
    }
    for (const event of semanticEvents) {
      this.stateFor(event.sessionId).addSemanticEvent(event);
    }
  }

  private rebuild(): void {
    const failureUnitIds = new Map<string, string[]>();
    const projectedUnitIds = new Set<string>();
    for (const [sessionId, state] of this.sessions) {
      const facts = state.facts();
      if (facts.length === 0 && state.semanticEvents().length === 0 && state.decisions().length === 0) continue;
      const ingestedEventIds = new Set(state.semanticEvents().map((event) => event.id));
      const projection = clusterSession({
        sessionId,
        taskPrompt: state.taskPrompt(),
        facts,
        agentEvents: state.agentEvents(),
        semanticEvents: state.semanticEvents(),
        decisions: state.decisions(),
        revertMarkers: [],
        supersedeMarkers: [...this.supersedeMarkers],
        idleGapMs: this.idleGapMs,
      });
      for (const validation of projection.validations) {
        this.stores.validations.upsertValidation(validation);
      }
      for (const failure of projection.failures) {
        this.stores.validations.upsertFailure(failure);
        const hosts: string[] = [];
        for (const unit of projection.units) {
          if (unit.files.includes(failure.file)) {
            hosts.push(unit.id);
          } else if (unit.symbols.some((symbol) => failure.testName.includes(symbol.name))) {
            hosts.push(unit.id);
          }
        }
        failureUnitIds.set(failure.id, hosts);
      }
      for (const unit of projection.units) {
        projectedUnitIds.add(unit.id);
        const signature = unitSignature(unit);
        const previousSignature = this.unitSignatures.get(unit.id);
        const previousVersion = this.decisionVersions.get(unit.id);
        const version =
          previousVersion === undefined
            ? 1
            : previousSignature === signature
              ? previousVersion
              : previousVersion + 1;
        this.unitSignatures.set(unit.id, signature);
        this.decisionVersions.set(unit.id, version);
        const overlay = this.labelOverlays.get(unit.id);
        const stored = overlay !== undefined && overlay.version >= version ? applyPatch(unit, overlay.patch) : unit;
        this.stores.units.upsert(stored);
      }
      for (const decision of state.decisions()) {
        const linked = projection.decisionChangeUnitIds.get(decision.id) ?? [];
        this.stores.decisions.upsert({ ...decision, affectedChangeUnits: linked });
      }
      for (const event of state.semanticEvents()) {
        const changeUnitId = projection.eventChangeUnitIds.get(event.id);
        this.stores.events.emit({ ...event, changeUnitId });
      }
      const failedUnitIds = new Set<string>();
      for (const hosts of failureUnitIds.values()) {
        for (const id of hosts) failedUnitIds.add(id);
      }
      for (const unit of projection.units) {
        const labeled = unit.evidence.some((id) => ingestedEventIds.has(id));
        if (labeled) continue;
        const unitFacts = projection.unitEvidenceFacts.get(unit.id) ?? [];
        const event = buildSemanticEvent(
          {
            unit,
            facts: unitFacts.map((entry) => entry.fact),
            unitValidationIds: unit.validationResults,
            hasFailures: failedUnitIds.has(unit.id),
          },
          this.nowIso(),
        );
        this.stores.events.emit(event);
      }
      const graph = projectGraph({
        sessionId,
        taskPrompt: state.taskPrompt(),
        units: projection.units,
        facts,
        agentEvents: state.agentEvents(),
        decisions: state.decisions(),
        validations: projection.validations,
        failures: projection.failures,
        unitEvidenceFacts: projection.unitEvidenceFacts,
        importEdges: projection.importEdges,
        packageImports: projection.packageImports,
        fileKinds: projection.fileKinds,
        failureUnitIds,
      });
      this.stores.graph.upsertNodes(graph.nodes);
      this.stores.graph.upsertEdges(graph.edges);
    }
    for (const unit of this.stores.units.all()) {
      if (this.sessions.has(unit.sessionId) && !projectedUnitIds.has(unit.id)) {
        this.stores.units.remove(unit.id);
      }
    }
    const storedUnitIds = new Set(
      this.stores.units.all().map((unit) => unit.id),
    );
    for (const id of [...this.unitSignatures.keys()]) {
      if (!storedUnitIds.has(id)) {
        this.unitSignatures.delete(id);
        this.decisionVersions.delete(id);
      }
    }
  }

  private stateFor(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (state === undefined) {
      state = new SessionState();
      this.sessions.set(sessionId, state);
    }
    return state;
  }
}

class SessionState {
  private readonly factList: SequencedFact[] = [];
  private readonly agentEventList: NormalizedAgentEvent[] = [];
  private readonly semanticEventList: SemanticEvent[] = [];
  private readonly decisionList: Decision[] = [];
  private readonly decisionIds = new Set<string>();
  private seqCounter = 0;
  private prompt: string | undefined;

  nextSeq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  addFact(fact: SequencedFact): void {
    this.factList.push(fact);
  }

  addAgentEvent(event: NormalizedAgentEvent): void {
    if (event.type === "agent_started") this.prompt = event.prompt;
    this.agentEventList.push(event);
  }

  addSemanticEvent(event: SemanticEvent): void {
    this.semanticEventList.push(event);
  }

  addDecision(decision: Decision): void {
    if (!this.decisionIds.has(decision.id)) {
      this.decisionIds.add(decision.id);
      this.decisionList.push(decision);
    }
  }

  replaceDecision(decision: Decision): void {
    const index = this.decisionList.findIndex((candidate) => candidate.id === decision.id);
    if (index >= 0) this.decisionList[index] = decision;
  }

  facts(): readonly SequencedFact[] {
    return this.factList;
  }

  agentEvents(): readonly NormalizedAgentEvent[] {
    return this.agentEventList;
  }

  semanticEvents(): readonly SemanticEvent[] {
    return this.semanticEventList;
  }

  decisions(): readonly Decision[] {
    return this.decisionList;
  }

  taskPrompt(): string | undefined {
    return this.prompt;
  }
}

function sessionOf(record: PipelineRecord): string | null {
  if ("sessionId" in record && typeof record.sessionId === "string" && record.sessionId !== "") {
    return record.sessionId;
  }
  return null;
}

function recordTs(record: PipelineRecord): number | null {
  if ("ts" in record && typeof record.ts === "string") {
    const parsed = Date.parse(record.ts);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if ("createdAt" in record && typeof record.createdAt === "string") {
    const parsed = Date.parse(record.createdAt);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function drainWindowId(windowFacts: readonly SequencedFact[], windowMs: number): number {
  for (const entry of windowFacts) {
    const ms = recordTs(entry.fact);
    if (ms !== null && ms >= 0) return Math.floor(ms / windowMs);
  }
  return 0;
}

function fileScope(fact: EvidenceFact): string | null {
  switch (fact.type) {
    case "git_hunk":
      return fact.file;
    case "file_changed":
      return fact.path;
    case "symbol_delta":
      return fact.path;
    case "dependency_change":
      return fact.manifest;
    case "revert_detected":
      return fact.files.join("\u0000");
    case "test_result":
      return `${fact.runner}\u0000${fact.command}`;
    case "command_executed":
      return null;
  }
}

export function mergeSameFileFacts(entries: readonly SequencedFact[]): SequencedFact[] {
  const latestByKey = new Map<string, SequencedFact>();
  const nonScoped: SequencedFact[] = [];
  for (const entry of entries) {
    const scope = fileScope(entry.fact);
    if (scope === null) {
      nonScoped.push(entry);
      continue;
    }
    const key = `${entry.fact.type}\u0000${scope}`;
    const existing = latestByKey.get(key);
    if (existing === undefined || entry.seq > existing.seq) {
      latestByKey.set(key, entry);
    }
  }
  const merged = [...latestByKey.values(), ...nonScoped];
  merged.sort((a, b) => a.seq - b.seq);
  return merged;
}

export function applyPatch(unit: ChangeUnit, patch: UnitLabelPatch): ChangeUnit {
  return {
    ...unit,
    title: patch.title ?? unit.title,
    intent: patch.intent ?? unit.intent,
    category: patch.category ?? unit.category,
    importance: patch.importance ?? unit.importance,
    relevance: patch.relevance ?? unit.relevance,
    interruption: patch.interruption ?? unit.interruption,
    uncertainty: patch.uncertainty ?? unit.uncertainty,
    mentalModelChange: patch.mentalModelChange ?? unit.mentalModelChange,
  };
}

function unitSignature(unit: ChangeUnit): string {
  return JSON.stringify({
    files: unit.files,
    symbols: unit.symbols.map((symbol) => symbol.name),
    evidence: unit.evidence,
    status: unit.status,
    category: unit.category,
    depChanges: unit.dependencyChanges,
  });
}

export function parseReplayLine(line: string): PipelineRecord | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let record: unknown;
  try {
    record = JSON.parse(trimmed);
  } catch {
    throw new Error(`replay line is not valid JSON: ${trimmed.slice(0, 80)}`);
  }
  for (const schema of [EvidenceFactSchema, NormalizedAgentEventSchema, SemanticEventSchema, DecisionSchema]) {
    const result = schema.safeParse(record);
    if (result.success) return result.data as PipelineRecord;
  }
  throw new Error(`replay record matches no contracts schema: ${trimmed.slice(0, 80)}`);
}
