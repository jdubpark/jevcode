import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import type { z } from "zod";

import {
  ChangeUnitSchema,
  DecisionSchema,
  EvidenceFactSchema,
  JevDecisionLogSchema,
  NormalizedAgentEventSchema,
  ValidationResultSchema,
} from "@jevcode/contracts";
import type {
  AgentState,
  ChangeUnit,
  Decision,
  EvidenceFact,
  JevDecisionLog,
  NormalizedAgentEvent,
  ValidationResult,
} from "@jevcode/contracts";
import { newId, nowIso, classifyDestructive } from "@jevcode/contracts";

import {
  CommandRecordSchema,
  FailureRecordSchema,
  GraphEdgeRecordSchema,
  GraphNodeRecordSchema,
  PreferenceRecordSchema,
  SemanticEventRecordSchema,
  TelemetryEventSchema,
  UiIntentRecordSchema,
  UiSnapshotSchema,
} from "./local-schemas.js";
import type {
  CommandRecord,
  FailureRecord,
  GraphEdgeRecord,
  GraphNodeRecord,
  PreferenceRecord,
  SemanticEventRecord,
  TelemetryEvent,
  UiIntentRecord,
  UiSnapshot,
} from "./local-schemas.js";
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";

export const EVENT_TYPES = [
  "agent_event",
  "evidence_fact",
  "change_unit",
  "decision",
  "validation",
  "failure",
  "jev_decision",
  "ui_intent",
  "ui_snapshot",
  "graph_node",
  "graph_edge",
  "command",
  "semantic_event",
  "telemetry",
] as const;

export type EventStoreType = (typeof EVENT_TYPES)[number];

const eventStoreSchemas = {
  agent_event: NormalizedAgentEventSchema,
  evidence_fact: EvidenceFactSchema,
  change_unit: ChangeUnitSchema,
  decision: DecisionSchema,
  validation: ValidationResultSchema,
  failure: FailureRecordSchema,
  jev_decision: JevDecisionLogSchema,
  ui_intent: UiIntentRecordSchema,
  ui_snapshot: UiSnapshotSchema,
  graph_node: GraphNodeRecordSchema,
  graph_edge: GraphEdgeRecordSchema,
  command: CommandRecordSchema,
  semantic_event: SemanticEventRecordSchema,
  telemetry: TelemetryEventSchema,
} as const satisfies Record<EventStoreType, z.ZodTypeAny>;

export function isEventStoreType(value: string): value is EventStoreType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}

export interface StoredEvent {
  id: string;
  sessionId: string;
  seq: number;
  type: EventStoreType;
  payloadJson: string;
  ts: string;
}

export interface RepositoryRecord {
  id: string;
  path: string;
  gitRoot: string;
  name: string;
  branch: string;
  baseCommit: string;
  lastOpenedAt: string;
  createdAt: string;
}

export interface SessionRecord {
  id: string;
  repoId: string;
  prompt: string;
  baseCommit: string;
  branch: string;
  state: AgentState;
  lastEventSeq: number;
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
  executionClaimTs: string | null;
  resumeAttempts: number;
}

export type InstructionStatus = "pending" | "delivered" | "cancelled";

export type InstructionMode = "queue" | "steer";

export interface InstructionInboxRecord {
  sessionId: string;
  instructionId: string;
  mode: InstructionMode;
  text: string;
  status: InstructionStatus;
  seq: number;
  createdAt: string;
  deliveredAt: string | null;
}

export interface UpsertInstructionInput {
  sessionId: string;
  instructionId: string;
  mode: InstructionMode;
  text: string;
}

export interface RebuildStats {
  sessionId: string;
  replayed: number;
}

export interface UpsertRepositoryInput {
  id?: string;
  path: string;
  gitRoot: string;
  name?: string;
  branch?: string;
  baseCommit?: string;
}

export interface CreateSessionInput {
  id?: string;
  repoId: string;
  prompt?: string;
  baseCommit?: string;
  branch?: string;
  state?: AgentState;
}

export function defaultDbPath(): string {
  const override = process.env.JEVCODE_DB;
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), ".jevcode", "jevcode.db");
}

export interface OpenDbOptions {
  dbPath?: string;
}

function parseJson(text: string, ctx: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${ctx}: invalid JSON payload: ${String(error)}`);
  }
}

function parseWith<T>(schema: z.ZodType<T>, text: string, ctx: string): T {
  const raw = parseJson(text, ctx);
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(`${ctx}: payload failed validation: ${result.error.message}`);
  }
  return result.data;
}

function failureId(validationId: string, file: string, testName: string): string {
  const hash = createHash("sha1")
    .update(JSON.stringify([validationId, file, testName]))
    .digest("hex")
    .slice(0, 16);
  return `fail_${hash}`;
}

interface EventRow {
  id: string;
  sessionId: string;
  seq: number;
  type: string;
  payloadJson: string;
  ts: string;
}

function toStoredEvent(row: EventRow): StoredEvent {
  if (!isEventStoreType(row.type)) {
    throw new Error(`stored event ${row.id} has unknown type: ${row.type}`);
  }
  return {
    id: row.id,
    sessionId: row.sessionId,
    seq: row.seq,
    type: row.type,
    payloadJson: row.payloadJson,
    ts: row.ts,
  };
}

function stringArrayJson(value: readonly string[]): string {
  return JSON.stringify(value);
}

export class JevcodeDb {
  readonly dbPath: string;
  private readonly db: BetterSqlite3.Database;

  constructor(dbPath: string, db: BetterSqlite3.Database) {
    this.dbPath = dbPath;
    this.db = db;
  }

  // ------------------------------------------------------------------
  // Event store
  // ------------------------------------------------------------------

  appendEvent(
    sessionId: string,
    type: EventStoreType,
    payload: unknown,
  ): StoredEvent {
    if (sessionId !== "" && this.getSession(sessionId) === undefined) {
      // Sessionless events (sessionId "") are only allowed for telemetry rows;
      // every other event must belong to a session that exists in `sessions`.
      throw new TypeError(
        `appendEvent(${type}): unknown sessionId "${sessionId}"`,
      );
    }
    const schema = eventStoreSchemas[type];
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new TypeError(
        `appendEvent(${type}): invalid payload: ${parsed.error.message}`,
      );
    }
    const value = parsed.data as Record<string, unknown>;
    if (typeof value.sessionId === "string" && value.sessionId !== sessionId) {
      throw new TypeError(
        `appendEvent(${type}): payload sessionId ${String(value.sessionId)} does not match event sessionId ${sessionId}`,
      );
    }
    const event: EventRow = {
      id: newId("evt"),
      sessionId,
      seq: 0,
      type,
      payloadJson: JSON.stringify(value),
      ts: nowIso(),
    };
    const apply = this.db.transaction(() => {
      const seqRow = this.db
        .prepare(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE sessionId = ?",
        )
        .get(sessionId) as { next: number };
      event.seq = seqRow.next;
      this.db
        .prepare(
          "INSERT INTO events (id, sessionId, seq, type, payloadJson, ts) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(event.id, event.sessionId, event.seq, event.type, event.payloadJson, event.ts);
      this.db
        .prepare("UPDATE sessions SET lastEventSeq = ? WHERE id = ?")
        .run(event.seq, sessionId);
      this.applyProjection(toStoredEvent(event));
    });
    apply();
    return toStoredEvent(event);
  }

  listEvents(sessionId: string, opts?: { fromSeq?: number; limit?: number }): StoredEvent[] {
    const fromSeq = opts?.fromSeq ?? 0;
    const limit = opts?.limit ?? 1000;
    const rows = this.db
      .prepare(
        "SELECT id, sessionId, seq, type, payloadJson, ts FROM events WHERE sessionId = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
      )
      .all(sessionId, fromSeq, limit) as EventRow[];
    return rows.map(toStoredEvent);
  }

  getEventCount(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE sessionId = ?")
      .get(sessionId) as { n: number };
    return row.n;
  }

  getLatestSeq(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE sessionId = ?")
      .get(sessionId) as { seq: number };
    return row.seq;
  }

  // ------------------------------------------------------------------
  // Typed append helpers (all flow through the event store)
  // ------------------------------------------------------------------

  appendAgentEvent(sessionId: string, event: NormalizedAgentEvent): StoredEvent {
    return this.appendEvent(sessionId, "agent_event", event);
  }

  appendEvidenceFact(sessionId: string, fact: EvidenceFact): StoredEvent {
    return this.appendEvent(sessionId, "evidence_fact", fact);
  }

  upsertChangeUnit(unit: ChangeUnit): StoredEvent {
    return this.appendEvent(unit.sessionId, "change_unit", unit);
  }

  upsertDecision(decision: Decision): StoredEvent {
    return this.appendEvent(decision.sessionId, "decision", decision);
  }

  upsertValidation(sessionId: string, validation: ValidationResult): StoredEvent {
    return this.appendEvent(sessionId, "validation", validation);
  }

  upsertFailure(sessionId: string, failure: Omit<FailureRecord, "id" | "sessionId" | "ts"> & { ts?: string }): StoredEvent {
    return this.appendEvent(sessionId, "failure", {
      ...failure,
      sessionId,
      ts: failure.ts ?? nowIso(),
    });
  }

  upsertJevDecision(log: JevDecisionLog): StoredEvent {
    return this.appendEvent(log.sessionId, "jev_decision", log);
  }

  upsertUiIntent(
    sessionId: string,
    input: { changeUnitId: string; intent: UiIntentRecord["intent"] },
  ): StoredEvent {
    return this.appendEvent(sessionId, "ui_intent", {
      sessionId,
      changeUnitId: input.changeUnitId,
      intent: input.intent,
      ts: nowIso(),
    });
  }

  upsertUiSnapshot(sessionId: string, snapshot: Omit<UiSnapshot, "id" | "sessionId" | "ts"> & { ts?: string }): StoredEvent {
    return this.appendEvent(sessionId, "ui_snapshot", {
      ...snapshot,
      sessionId,
      ts: snapshot.ts ?? nowIso(),
    });
  }

  upsertGraphNode(sessionId: string, node: Omit<GraphNodeRecord, "sessionId" | "ts"> & { ts?: string }): StoredEvent {
    return this.appendEvent(sessionId, "graph_node", {
      ...node,
      sessionId,
      ts: node.ts ?? nowIso(),
    });
  }

  upsertGraphEdge(sessionId: string, edge: Omit<GraphEdgeRecord, "sessionId" | "ts"> & { ts?: string }): StoredEvent {
    return this.appendEvent(sessionId, "graph_edge", {
      ...edge,
      sessionId,
      ts: edge.ts ?? nowIso(),
    });
  }

  recordCommand(sessionId: string, command: Omit<CommandRecord, "id" | "sessionId" | "ts"> & { ts?: string }): StoredEvent {
    return this.appendEvent(sessionId, "command", {
      ...command,
      sessionId,
      ts: command.ts ?? nowIso(),
    });
  }

  appendSemanticEvent(sessionId: string, event: SemanticEventRecord): StoredEvent {
    return this.appendEvent(sessionId, "semantic_event", event);
  }

  appendTelemetry(
    type: string,
    payload: Record<string, unknown>,
    sessionId?: string,
  ): StoredEvent {
    // Telemetry payloads are validated (non-strict: unknown keys stripped)
    // at the @jevcode/telemetry boundary before they reach storage; storage
    // persists the record as-is so older schemas keep reading newer rows.
    return this.appendEvent(sessionId ?? "", "telemetry", {
      sessionId: sessionId ?? undefined,
      type,
      payload,
      ts: nowIso(),
    });
  }

  // ------------------------------------------------------------------
  // Rebuild
  // ------------------------------------------------------------------

  rebuildSession(sessionId: string): RebuildStats {
    const rows = this.db
      .prepare(
        "SELECT id, sessionId, seq, type, payloadJson, ts FROM events WHERE sessionId = ? ORDER BY seq ASC",
      )
      .all(sessionId) as EventRow[];
    const replay = this.db.transaction(() => {
      for (const row of rows) {
        this.applyProjection(toStoredEvent(row));
      }
    });
    replay();
    return { sessionId, replayed: rows.length };
  }

  rebuildOnBoot(opts: { sinceDays?: number } = {}): RebuildStats[] {
    const sinceDays = opts.sinceDays ?? 30;
    const cutoff = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
    // Sessionless rows (sessionId "") hold telemetry written before a session
    // existed; they are replayed too so their projections survive a boot.
    const rows = this.db
      .prepare(
        "SELECT DISTINCT sessionId FROM events WHERE ts >= ? ORDER BY sessionId ASC",
      )
      .all(cutoff) as { sessionId: string }[];
    return rows.map((row) => this.rebuildSession(row.sessionId));
  }

  // ------------------------------------------------------------------
  // Repositories / sessions
  // ------------------------------------------------------------------

  upsertRepository(input: UpsertRepositoryInput): RepositoryRecord {
    const existing = this.findRepositoryByPath(input.path);
    if (existing) {
      const updated: RepositoryRecord = {
        ...existing,
        gitRoot: input.gitRoot,
        branch: input.branch ?? existing.branch,
        baseCommit: input.baseCommit ?? existing.baseCommit,
        lastOpenedAt: nowIso(),
      };
      this.db
        .prepare(
          "UPDATE repositories SET gitRoot = ?, branch = ?, baseCommit = ?, lastOpenedAt = ? WHERE id = ?",
        )
        .run(updated.gitRoot, updated.branch, updated.baseCommit, updated.lastOpenedAt, updated.id);
      return updated;
    }
    const record: RepositoryRecord = {
      id: input.id ?? newId("repo"),
      path: input.path,
      gitRoot: input.gitRoot,
      name: input.name ?? path.basename(input.gitRoot),
      branch: input.branch ?? "",
      baseCommit: input.baseCommit ?? "",
      lastOpenedAt: nowIso(),
      createdAt: nowIso(),
    };
    this.db
      .prepare(
        "INSERT INTO repositories (id, path, gitRoot, name, branch, baseCommit, lastOpenedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        record.id,
        record.path,
        record.gitRoot,
        record.name,
        record.branch,
        record.baseCommit,
        record.lastOpenedAt,
        record.createdAt,
      );
    return record;
  }

  findRepositoryByPath(repoPath: string): RepositoryRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT id, path, gitRoot, name, branch, baseCommit, lastOpenedAt, createdAt FROM repositories WHERE path = ?",
      )
      .get(repoPath) as unknown;
    return (row as RepositoryRecord | undefined) ?? undefined;
  }

  getRepository(id: string): RepositoryRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT id, path, gitRoot, name, branch, baseCommit, lastOpenedAt, createdAt FROM repositories WHERE id = ?",
      )
      .get(id) as unknown;
    return (row as RepositoryRecord | undefined) ?? undefined;
  }

  listRecentRepositories(limit = 10): RepositoryRecord[] {
    const rows = this.db
      .prepare(
        "SELECT id, path, gitRoot, name, branch, baseCommit, lastOpenedAt, createdAt FROM repositories ORDER BY lastOpenedAt DESC LIMIT ?",
      )
      .all(limit) as RepositoryRecord[];
    return rows;
  }

  createSession(input: CreateSessionInput): SessionRecord {
    const record: SessionRecord = {
      id: input.id ?? newId("sess"),
      repoId: input.repoId,
      prompt: input.prompt ?? "",
      baseCommit: input.baseCommit ?? "",
      branch: input.branch ?? "",
      state: input.state ?? "starting",
      lastEventSeq: 0,
      startedAt: nowIso(),
      endedAt: null,
      createdAt: nowIso(),
      executionClaimTs: null,
      resumeAttempts: 0,
    };
    this.db
      .prepare(
        "INSERT INTO sessions (id, repoId, prompt, baseCommit, branch, state, lastEventSeq, startedAt, endedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        record.id,
        record.repoId,
        record.prompt,
        record.baseCommit,
        record.branch,
        record.state,
        record.lastEventSeq,
        record.startedAt,
        null,
        record.createdAt,
      );
    return record;
  }

  getSession(id: string): SessionRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT id, repoId, prompt, baseCommit, branch, state, lastEventSeq, startedAt, endedAt, createdAt, execution_claim_ts AS executionClaimTs, resume_attempts AS resumeAttempts FROM sessions WHERE id = ?",
      )
      .get(id) as unknown;
    return (row as SessionRecord | undefined) ?? undefined;
  }

  listSessions(repoId: string, limit = 50): SessionRecord[] {
    const rows = this.db
      .prepare(
        "SELECT id, repoId, prompt, baseCommit, branch, state, lastEventSeq, startedAt, endedAt, createdAt, execution_claim_ts AS executionClaimTs, resume_attempts AS resumeAttempts FROM sessions WHERE repoId = ? ORDER BY startedAt DESC LIMIT ?",
      )
      .all(repoId, limit) as SessionRecord[];
    return rows;
  }

  listSessionsByStates(states: readonly AgentState[]): SessionRecord[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT id, repoId, prompt, baseCommit, branch, state, lastEventSeq, startedAt, endedAt, createdAt, execution_claim_ts AS executionClaimTs, resume_attempts AS resumeAttempts FROM sessions WHERE state IN (${placeholders}) ORDER BY startedAt ASC`,
      )
      .all(...states) as SessionRecord[];
    return rows;
  }

  setSessionState(id: string, state: AgentState): void {
    this.db.prepare("UPDATE sessions SET state = ? WHERE id = ?").run(state, id);
  }

  setExecutionClaim(id: string, ts: string | null): void {
    this.db
      .prepare("UPDATE sessions SET execution_claim_ts = ? WHERE id = ?")
      .run(ts, id);
  }

  incrementResumeAttempts(id: string): number {
    const row = this.db
      .prepare(
        "UPDATE sessions SET resume_attempts = resume_attempts + 1 WHERE id = ? RETURNING resume_attempts",
      )
      .get(id) as { resume_attempts: number } | undefined;
    return row?.resume_attempts ?? 0;
  }

  getResumeAttempts(id: string): number {
    const row = this.db
      .prepare("SELECT resume_attempts FROM sessions WHERE id = ?")
      .get(id) as { resume_attempts: number } | undefined;
    return row?.resume_attempts ?? 0;
  }

  setSessionPrompt(id: string, prompt: string): void {
    this.db.prepare("UPDATE sessions SET prompt = ? WHERE id = ?").run(prompt, id);
  }

  setSessionEnded(id: string, endedAt = nowIso()): void {
    this.db.prepare("UPDATE sessions SET endedAt = ? WHERE id = ?").run(endedAt, id);
  }

  // ------------------------------------------------------------------
  // Instruction inbox (durable admission; survives rebuilds and boots)
  // ------------------------------------------------------------------

  private selectInstructionColumns(): string {
    return "sessionId, instructionId, mode, text, status, seq, createdAt, deliveredAt";
  }

  listPendingInstructions(sessionId: string): InstructionInboxRecord[] {
    const rows = this.db
      .prepare(
        `SELECT ${this.selectInstructionColumns()} FROM instruction_inbox WHERE sessionId = ? AND status = 'pending' ORDER BY seq ASC`,
      )
      .all(sessionId) as InstructionInboxRecord[];
    return rows;
  }

  getInstruction(
    sessionId: string,
    instructionId: string,
  ): InstructionInboxRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT ${this.selectInstructionColumns()} FROM instruction_inbox WHERE sessionId = ? AND instructionId = ?`,
      )
      .get(sessionId, instructionId) as InstructionInboxRecord | undefined;
    return row ?? undefined;
  }

  upsertInstruction(input: UpsertInstructionInput): InstructionInboxRecord {
    const upsert = this.db.transaction((): InstructionInboxRecord => {
      const existing = this.getInstruction(input.sessionId, input.instructionId);
      if (existing !== undefined) {
        // Idempotent by (sessionId, instructionId): re-admission never
        // overwrites text, seq, or a terminal (delivered/cancelled) status.
        return existing;
      }
      const seqRow = this.db
        .prepare(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM instruction_inbox WHERE sessionId = ?",
        )
        .get(input.sessionId) as { next: number };
      this.db
        .prepare(
          "INSERT INTO instruction_inbox (sessionId, instructionId, mode, text, status, seq, createdAt, deliveredAt) VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL)",
        )
        .run(
          input.sessionId,
          input.instructionId,
          input.mode,
          input.text,
          seqRow.next,
          nowIso(),
        );
      return this.getInstruction(input.sessionId, input.instructionId) as InstructionInboxRecord;
    });
    return upsert();
  }

  markInstructionDelivered(sessionId: string, instructionId: string): void {
    this.db
      .prepare(
        "UPDATE instruction_inbox SET status = 'delivered', deliveredAt = ? WHERE sessionId = ? AND instructionId = ?",
      )
      .run(nowIso(), sessionId, instructionId);
  }

  markInstructionCancelled(sessionId: string, instructionId: string): void {
    this.db
      .prepare(
        "UPDATE instruction_inbox SET status = 'cancelled' WHERE sessionId = ? AND instructionId = ?",
      )
      .run(sessionId, instructionId);
  }

  // ------------------------------------------------------------------
  // Projection queries (zod-parsed on read)
  // ------------------------------------------------------------------

  listAgentEvents(sessionId: string, opts?: { limit?: number }): NormalizedAgentEvent[] {
    const limit = opts?.limit ?? 1000;
    const rows = this.db
      .prepare(
        "SELECT payloadJson FROM agent_events WHERE sessionId = ? ORDER BY seq ASC LIMIT ?",
      )
      .all(sessionId, limit) as { payloadJson: string }[];
    return rows.map((row, i) =>
      parseWith(NormalizedAgentEventSchema, row.payloadJson, `agent_events[${i}]`),
    );
  }

  latestAgentEvents(sessionId: string, n: number): NormalizedAgentEvent[] {
    const rows = this.db
      .prepare(
        "SELECT payloadJson FROM agent_events WHERE sessionId = ? ORDER BY seq DESC LIMIT ?",
      )
      .all(sessionId, n) as { payloadJson: string }[];
    return rows.map((row, i) =>
      parseWith(NormalizedAgentEventSchema, row.payloadJson, `agent_events[${i}]`),
    );
  }

  getChangeUnit(id: string): ChangeUnit | undefined {
    const row = this.db
      .prepare(
        "SELECT sessionId, title, intent, category, status, behaviorBefore, behaviorAfter, filesJson, symbolsJson, interfacesChangedJson, schemaChangesJson, dependencyChangesJson, relatedDecisionsJson, validationResultsJson, blastRadiusJson, importance, relevance, interruption, uncertainty, mentalModelChange, evidenceJson, createdAt, updatedAt FROM change_units WHERE id = ?",
      )
      .get(id) as ChangeUnitRow | undefined;
    if (!row) return undefined;
    return changeUnitFromRow(id, row);
  }

  listChangeUnits(sessionId: string): ChangeUnit[] {
    const rows = this.db
      .prepare(
        "SELECT id, sessionId, title, intent, category, status, behaviorBefore, behaviorAfter, filesJson, symbolsJson, interfacesChangedJson, schemaChangesJson, dependencyChangesJson, relatedDecisionsJson, validationResultsJson, blastRadiusJson, importance, relevance, interruption, uncertainty, mentalModelChange, evidenceJson, createdAt, updatedAt FROM change_units WHERE sessionId = ? ORDER BY updatedAt DESC",
      )
      .all(sessionId) as (ChangeUnitRow & { id: string })[];
    return rows.map((row) => changeUnitFromRow(row.id, row));
  }

  latestChangeUnits(sessionId: string, n: number): ChangeUnit[] {
    return this.listChangeUnits(sessionId).slice(0, n);
  }

  getDecision(id: string): Decision | undefined {
    const row = this.db
      .prepare(
        "SELECT sessionId, title, context, severity, status, affectedChangeUnitsJson, evidenceJson, answerJson, createdAt, updatedAt FROM decisions WHERE id = ?",
      )
      .get(id) as DecisionRow | undefined;
    if (!row) return undefined;
    return decisionFromRow(id, row, this.listDecisionOptions(id));
  }

  listDecisions(sessionId: string): Decision[] {
    const rows = this.db
      .prepare(
        "SELECT id, sessionId, title, context, severity, status, affectedChangeUnitsJson, evidenceJson, answerJson, createdAt, updatedAt FROM decisions WHERE sessionId = ? ORDER BY updatedAt DESC",
      )
      .all(sessionId) as (DecisionRow & { id: string })[];
    return rows.map((row) => decisionFromRow(row.id, row, this.listDecisionOptions(row.id)));
  }

  private listDecisionOptions(decisionId: string): Decision["options"] {
    const rows = this.db
      .prepare(
        "SELECT optionId, label, description, tradeoffsJson FROM decision_options WHERE decisionId = ? ORDER BY optionId ASC",
      )
      .all(decisionId) as {
      optionId: string;
      label: string;
      description: string;
      tradeoffsJson: string | null;
    }[];
    return rows.map((row) => {
      const tradeoffs = row.tradeoffsJson
        ? parseJson(row.tradeoffsJson, `decision ${decisionId} option ${row.optionId} tradeoffs`)
        : undefined;
      return {
        id: row.optionId,
        label: row.label,
        description: row.description,
        tradeoffs,
      } as Decision["options"][number];
    });
  }

  latestDecisions(sessionId: string, n: number): Decision[] {
    return this.listDecisions(sessionId).slice(0, n);
  }

  listValidations(sessionId: string, opts?: { limit?: number }): ValidationResult[] {
    const limit = opts?.limit ?? 1000;
    const rows = this.db
      .prepare(
        "SELECT payloadJson FROM validations WHERE sessionId = ? ORDER BY ts DESC LIMIT ?",
      )
      .all(sessionId, limit) as { payloadJson: string }[];
    return rows.map((row, i) =>
      parseWith(ValidationResultSchema, row.payloadJson, `validations[${i}]`),
    );
  }

  latestValidations(sessionId: string, n: number): ValidationResult[] {
    return this.listValidations(sessionId, { limit: n });
  }

  listFailures(sessionId: string, opts?: { limit?: number }): FailureRecord[] {
    const limit = opts?.limit ?? 1000;
    const rows = this.db
      .prepare(
        "SELECT payloadJson FROM failures WHERE sessionId = ? ORDER BY ts DESC LIMIT ?",
      )
      .all(sessionId, limit) as { payloadJson: string }[];
    return rows.map((row, i) =>
      parseWith(FailureRecordSchema, row.payloadJson, `failures[${i}]`),
    );
  }

  listJevDecisions(sessionId: string, opts?: { limit?: number }): JevDecisionLog[] {
    const limit = opts?.limit ?? 1000;
    const rows = this.db
      .prepare(
        "SELECT payloadJson FROM jev_decisions WHERE sessionId = ? ORDER BY seq DESC LIMIT ?",
      )
      .all(sessionId, limit) as { payloadJson: string }[];
    return rows.map((row, i) =>
      parseWith(JevDecisionLogSchema, row.payloadJson, `jev_decisions[${i}]`),
    );
  }

  latestJevDecisions(sessionId: string, n: number): JevDecisionLog[] {
    return this.listJevDecisions(sessionId, { limit: n });
  }

  getUiIntent(id: string): UiIntentRecord | undefined {
    const row = this.db
      .prepare("SELECT payloadJson FROM ui_intents WHERE id = ?")
      .get(id) as { payloadJson: string } | undefined;
    if (!row) return undefined;
    return parseWith(UiIntentRecordSchema, row.payloadJson, `ui_intent ${id}`);
  }

  listUiIntents(sessionId: string): UiIntentRecord[] {
    const rows = this.db
      .prepare(
        "SELECT payloadJson FROM ui_intents WHERE sessionId = ? ORDER BY seq ASC",
      )
      .all(sessionId) as { payloadJson: string }[];
    return rows.map((row, i) =>
      parseWith(UiIntentRecordSchema, row.payloadJson, `ui_intents[${i}]`),
    );
  }

  listUiSnapshots(sessionId: string, opts?: { limit?: number }): UiSnapshot[] {
    const limit = opts?.limit ?? 1000;
    const rows = this.db
      .prepare(
        "SELECT payloadJson FROM ui_snapshots WHERE sessionId = ? ORDER BY seq DESC LIMIT ?",
      )
      .all(sessionId, limit) as { payloadJson: string }[];
    return rows.map((row, i) =>
      parseWith(UiSnapshotSchema, row.payloadJson, `ui_snapshots[${i}]`),
    );
  }

  listGraphNodes(sessionId: string): GraphNodeRecord[] {
    const rows = this.db
      .prepare("SELECT payloadJson FROM graph_nodes WHERE sessionId = ?")
      .all(sessionId) as { payloadJson: string }[];
    return rows.map((row, i) =>
      parseWith(GraphNodeRecordSchema, row.payloadJson, `graph_nodes[${i}]`),
    );
  }

  listGraphEdges(sessionId: string): GraphEdgeRecord[] {
    const rows = this.db
      .prepare("SELECT payloadJson FROM graph_edges WHERE sessionId = ?")
      .all(sessionId) as { payloadJson: string }[];
    return rows.map((row, i) =>
      parseWith(GraphEdgeRecordSchema, row.payloadJson, `graph_edges[${i}]`),
    );
  }

  listCommands(sessionId: string, opts?: { limit?: number }): CommandRecord[] {
    const limit = opts?.limit ?? 1000;
    const rows = this.db
      .prepare(
        "SELECT payloadJson FROM commands WHERE sessionId = ? ORDER BY seq ASC LIMIT ?",
      )
      .all(sessionId, limit) as { payloadJson: string }[];
    return rows.map((row, i) =>
      parseWith(CommandRecordSchema, row.payloadJson, `commands[${i}]`),
    );
  }

  latestCommands(sessionId: string, n: number): CommandRecord[] {
    const rows = this.db
      .prepare(
        "SELECT payloadJson FROM commands WHERE sessionId = ? ORDER BY seq DESC LIMIT ?",
      )
      .all(sessionId, n) as { payloadJson: string }[];
    return rows.map((row, i) =>
      parseWith(CommandRecordSchema, row.payloadJson, `commands[${i}]`),
    );
  }

  listSemanticEvents(sessionId: string, opts?: { limit?: number }): SemanticEventRecord[] {
    const limit = opts?.limit ?? 1000;
    const rows = this.db
      .prepare(
        "SELECT payloadJson FROM semantic_events WHERE sessionId = ? ORDER BY seq ASC LIMIT ?",
      )
      .all(sessionId, limit) as { payloadJson: string }[];
    return rows.map((row, i) =>
      parseWith(SemanticEventRecordSchema, row.payloadJson, `semantic_events[${i}]`),
    );
  }

  listTelemetry(opts?: { sessionId?: string; limit?: number }): TelemetryEvent[] {
    const limit = opts?.limit ?? 1000;
    const rows = opts?.sessionId
      ? (this.db
          .prepare(
            "SELECT payloadJson FROM telemetry_events WHERE sessionId = ? ORDER BY ts DESC LIMIT ?",
          )
          .all(opts.sessionId, limit) as { payloadJson: string }[])
      : (this.db
          .prepare("SELECT payloadJson FROM telemetry_events ORDER BY ts DESC LIMIT ?")
          .all(limit) as { payloadJson: string }[]);
    return rows.map((row, i) =>
      parseWith(TelemetryEventSchema, row.payloadJson, `telemetry[${i}]`),
    );
  }

  exportTelemetry(opts?: { sessionId?: string; limit?: number; pretty?: boolean }): string {
    const events = this.listTelemetry(opts);
    return JSON.stringify(events, null, opts?.pretty === false ? 0 : 2);
  }

  // ------------------------------------------------------------------
  // Preferences
  // ------------------------------------------------------------------

  setPreference(key: string, value: unknown): PreferenceRecord {
    const record: PreferenceRecord = { key, value, updatedAt: nowIso() };
    this.db
      .prepare(
        "INSERT INTO preferences (key, valueJson, updatedAt) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET valueJson = excluded.valueJson, updatedAt = excluded.updatedAt",
      )
      .run(record.key, JSON.stringify(record.value), record.updatedAt);
    return record;
  }

  getPreference(key: string): unknown {
    const row = this.db
      .prepare("SELECT valueJson FROM preferences WHERE key = ?")
      .get(key) as { valueJson: string } | undefined;
    if (!row) return undefined;
    return parseJson(row.valueJson, `preference ${key}`);
  }

  listPreferences(): PreferenceRecord[] {
    const rows = this.db
      .prepare("SELECT key, valueJson, updatedAt FROM preferences")
      .all() as { key: string; valueJson: string; updatedAt: string }[];
    return rows.map((row) =>
      parseWith(PreferenceRecordSchema, JSON.stringify(row), `preference ${row.key}`),
    );
  }

  close(): void {
    this.db.close();
  }

  schemaVersion(): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_version")
      .get() as { version: number };
    return row.version;
  }

  dbInfo(): { dbPath: string; journalMode: string; schemaVersion: number } {
    const journalMode = this.db.pragma("journal_mode", { simple: true }) as string;
    return {
      dbPath: this.dbPath,
      journalMode,
      schemaVersion: this.schemaVersion(),
    };
  }

  // ------------------------------------------------------------------
  // Projection application (idempotent upserts, keyed by stable ids)
  // ------------------------------------------------------------------

  private applyProjection(event: StoredEvent): void {
    switch (event.type) {
      case "agent_event":
        this.applyAgentEvent(event);
        break;
      case "evidence_fact":
        this.applyEvidenceFact(event);
        break;
      case "change_unit":
        this.applyChangeUnit(event);
        break;
      case "decision":
        this.applyDecision(event);
        break;
      case "validation":
        this.applyValidation(event);
        break;
      case "failure":
        this.applyFailure(event);
        break;
      case "jev_decision":
        this.applyJevDecision(event);
        break;
      case "ui_intent":
        this.applyUiIntent(event);
        break;
      case "ui_snapshot":
        this.applyUiSnapshot(event);
        break;
      case "graph_node":
        this.applyGraphNode(event);
        break;
      case "graph_edge":
        this.applyGraphEdge(event);
        break;
      case "command":
        this.applyCommand(event);
        break;
      case "semantic_event":
        this.applySemanticEvent(event);
        break;
      case "telemetry":
        this.applyTelemetry(event);
        break;
    }
  }

  private applyAgentEvent(event: StoredEvent): void {
    const parsed = parseWith(
      NormalizedAgentEventSchema,
      event.payloadJson,
      `agent_event ${event.id}`,
    );
    this.db
      .prepare(
        "INSERT INTO agent_events (id, sessionId, seq, type, payloadJson, ts) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET sessionId = excluded.sessionId, seq = excluded.seq, type = excluded.type, payloadJson = excluded.payloadJson, ts = excluded.ts",
      )
      .run(event.id, event.sessionId, event.seq, parsed.type, event.payloadJson, parsed.ts);
    if (parsed.type === "command_completed") {
      const destructive = classifyDestructive(parsed.command);
      const commandPayload = JSON.stringify({
        id: event.id,
        sessionId: event.sessionId,
        command: parsed.command,
        exitCode: parsed.exitCode,
        isDestructive: destructive,
        ts: parsed.ts,
      });
      this.db
        .prepare(
          "INSERT INTO commands (id, sessionId, seq, command, exitCode, isDestructive, ts, payloadJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET sessionId = excluded.sessionId, seq = excluded.seq, command = excluded.command, exitCode = excluded.exitCode, isDestructive = excluded.isDestructive, ts = excluded.ts, payloadJson = excluded.payloadJson",
        )
        .run(
          event.id,
          event.sessionId,
          event.seq,
          parsed.command,
          parsed.exitCode,
          destructive ? 1 : 0,
          parsed.ts,
          commandPayload,
        );
    }
  }

  private applyEvidenceFact(event: StoredEvent): void {
    const parsed = parseWith(
      EvidenceFactSchema,
      event.payloadJson,
      `evidence_fact ${event.id}`,
    );
    this.db
      .prepare(
        "INSERT INTO evidence_facts (id, repoId, sessionId, seq, type, payloadJson, ts) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET repoId = excluded.repoId, sessionId = excluded.sessionId, seq = excluded.seq, type = excluded.type, payloadJson = excluded.payloadJson, ts = excluded.ts",
      )
      .run(event.id, parsed.repoId, event.sessionId, event.seq, parsed.type, event.payloadJson, parsed.ts);

    if (parsed.type === "test_result") {
      const validationId = `${parsed.runner}|${parsed.command}|${parsed.ts}`;
      const status = parsed.failed > 0 ? "failed" : parsed.passed > 0 ? "passed" : "skipped";
      const validationPayload = JSON.stringify({
        id: validationId,
        kind: "test",
        command: parsed.command,
        status,
        passed: parsed.passed,
        failed: parsed.failed,
        skipped: parsed.skipped,
        ts: parsed.ts,
      });
      this.db
        .prepare(
          "INSERT INTO validations (id, sessionId, kind, command, status, passed, failed, skipped, ts, payloadJson) VALUES (?, ?, 'test', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET sessionId = excluded.sessionId, command = excluded.command, status = excluded.status, passed = excluded.passed, failed = excluded.failed, skipped = excluded.skipped, ts = excluded.ts, payloadJson = excluded.payloadJson",
        )
        .run(
          validationId,
          event.sessionId,
          parsed.command,
          status,
          parsed.passed,
          parsed.failed,
          parsed.skipped,
          parsed.ts,
          validationPayload,
        );
      for (const failure of parsed.failures) {
        const id = failureId(validationId, failure.file, failure.testName);
        const failurePayload = JSON.stringify({
          id,
          validationId,
          sessionId: event.sessionId,
          file: failure.file,
          testName: failure.testName,
          message: failure.message,
          ts: parsed.ts,
        });
        this.db
          .prepare(
            "INSERT INTO failures (id, sessionId, validationId, file, testName, message, ts, payloadJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET sessionId = excluded.sessionId, validationId = excluded.validationId, file = excluded.file, testName = excluded.testName, message = excluded.message, ts = excluded.ts, payloadJson = excluded.payloadJson",
          )
          .run(id, event.sessionId, validationId, failure.file, failure.testName, failure.message, parsed.ts, failurePayload);
      }
    }

    if (parsed.type === "command_executed") {
      const commandPayload = JSON.stringify({
        id: event.id,
        sessionId: event.sessionId,
        command: parsed.command,
        exitCode: parsed.exitCode,
        isDestructive: parsed.isDestructive,
        ts: parsed.ts,
      });
      this.db
        .prepare(
          "INSERT INTO commands (id, sessionId, seq, command, exitCode, isDestructive, ts, payloadJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET sessionId = excluded.sessionId, seq = excluded.seq, command = excluded.command, exitCode = excluded.exitCode, isDestructive = excluded.isDestructive, ts = excluded.ts, payloadJson = excluded.payloadJson",
        )
        .run(
          event.id,
          event.sessionId,
          event.seq,
          parsed.command,
          parsed.exitCode,
          parsed.isDestructive ? 1 : 0,
          parsed.ts,
          commandPayload,
        );
    }
  }

  private applyChangeUnit(event: StoredEvent): void {
    const unit = parseWith(ChangeUnitSchema, event.payloadJson, `change_unit ${event.id}`);
    this.db
      .prepare(
        "INSERT INTO change_units (id, sessionId, seq, title, intent, category, status, behaviorBefore, behaviorAfter, filesJson, symbolsJson, interfacesChangedJson, schemaChangesJson, dependencyChangesJson, relatedDecisionsJson, validationResultsJson, blastRadiusJson, importance, relevance, interruption, uncertainty, mentalModelChange, evidenceJson, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET sessionId = excluded.sessionId, seq = excluded.seq, title = excluded.title, intent = excluded.intent, category = excluded.category, status = excluded.status, behaviorBefore = excluded.behaviorBefore, behaviorAfter = excluded.behaviorAfter, filesJson = excluded.filesJson, symbolsJson = excluded.symbolsJson, interfacesChangedJson = excluded.interfacesChangedJson, schemaChangesJson = excluded.schemaChangesJson, dependencyChangesJson = excluded.dependencyChangesJson, relatedDecisionsJson = excluded.relatedDecisionsJson, validationResultsJson = excluded.validationResultsJson, blastRadiusJson = excluded.blastRadiusJson, importance = excluded.importance, relevance = excluded.relevance, interruption = excluded.interruption, uncertainty = excluded.uncertainty, mentalModelChange = excluded.mentalModelChange, evidenceJson = excluded.evidenceJson, createdAt = excluded.createdAt, updatedAt = excluded.updatedAt",
      )
      .run(
        unit.id,
        event.sessionId,
        event.seq,
        unit.title,
        unit.intent ?? null,
        unit.category,
        unit.status,
        unit.behaviorBefore ?? null,
        unit.behaviorAfter ?? null,
        JSON.stringify(unit.files),
        JSON.stringify(unit.symbols),
        JSON.stringify(unit.interfacesChanged),
        JSON.stringify(unit.schemaChanges),
        JSON.stringify(unit.dependencyChanges),
        stringArrayJson(unit.relatedDecisions),
        stringArrayJson(unit.validationResults),
        unit.blastRadius ? JSON.stringify(unit.blastRadius) : null,
        unit.importance ?? null,
        unit.relevance ?? null,
        unit.interruption ?? null,
        unit.uncertainty ?? null,
        unit.mentalModelChange ?? null,
        stringArrayJson(unit.evidence),
        unit.createdAt,
        unit.updatedAt,
      );
    this.db
      .prepare("DELETE FROM change_unit_files WHERE changeUnitId = ?")
      .run(unit.id);
    const insertFile = this.db.prepare(
      "INSERT INTO change_unit_files (changeUnitId, file, sessionId) VALUES (?, ?, ?)",
    );
    for (const file of unit.files) {
      insertFile.run(unit.id, file, event.sessionId);
    }
    this.db
      .prepare("DELETE FROM change_unit_symbols WHERE changeUnitId = ?")
      .run(unit.id);
    const insertSymbol = this.db.prepare(
      "INSERT INTO change_unit_symbols (changeUnitId, symbolId, name, path, kind, sessionId) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const symbol of unit.symbols) {
      insertSymbol.run(unit.id, symbol.id, symbol.name, symbol.path, symbol.kind, event.sessionId);
    }
  }

  private applyDecision(event: StoredEvent): void {
    const decision = parseWith(DecisionSchema, event.payloadJson, `decision ${event.id}`);
    this.db
      .prepare(
        "INSERT INTO decisions (id, sessionId, seq, title, context, severity, status, affectedChangeUnitsJson, evidenceJson, answerJson, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET sessionId = excluded.sessionId, seq = excluded.seq, title = excluded.title, context = excluded.context, severity = excluded.severity, status = excluded.status, affectedChangeUnitsJson = excluded.affectedChangeUnitsJson, evidenceJson = excluded.evidenceJson, answerJson = excluded.answerJson, createdAt = excluded.createdAt, updatedAt = excluded.updatedAt",
      )
      .run(
        decision.id,
        event.sessionId,
        event.seq,
        decision.title,
        decision.context,
        decision.severity,
        decision.status,
        stringArrayJson(decision.affectedChangeUnits),
        stringArrayJson(decision.evidence),
        decision.answer ? JSON.stringify(decision.answer) : null,
        event.ts,
        event.ts,
      );
    this.db
      .prepare("DELETE FROM decision_options WHERE decisionId = ?")
      .run(decision.id);
    const insertOption = this.db.prepare(
      "INSERT INTO decision_options (decisionId, optionId, label, description, tradeoffsJson) VALUES (?, ?, ?, ?, ?)",
    );
    for (const option of decision.options) {
      insertOption.run(
        decision.id,
        option.id,
        option.label,
        option.description,
        option.tradeoffs ? JSON.stringify(option.tradeoffs) : null,
      );
    }
  }

  private applyValidation(event: StoredEvent): void {
    const validation = parseWith(
      ValidationResultSchema,
      event.payloadJson,
      `validation ${event.id}`,
    );
    this.db
      .prepare(
        "INSERT INTO validations (id, sessionId, kind, command, status, passed, failed, skipped, ts, payloadJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET sessionId = excluded.sessionId, kind = excluded.kind, command = excluded.command, status = excluded.status, passed = excluded.passed, failed = excluded.failed, skipped = excluded.skipped, ts = excluded.ts, payloadJson = excluded.payloadJson",
      )
      .run(
        validation.id,
        event.sessionId,
        validation.kind,
        validation.command,
        validation.status,
        validation.passed,
        validation.failed,
        validation.skipped,
        validation.ts,
        event.payloadJson,
      );
  }

  private applyFailure(event: StoredEvent): void {
    const failure = parseWith(FailureRecordSchema, event.payloadJson, `failure ${event.id}`);
    const id = failure.id ?? failureId(failure.validationId, failure.file, failure.testName);
    const full = JSON.stringify({ ...failure, id });
    this.db
      .prepare(
        "INSERT INTO failures (id, sessionId, validationId, file, testName, message, ts, payloadJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET sessionId = excluded.sessionId, validationId = excluded.validationId, file = excluded.file, testName = excluded.testName, message = excluded.message, ts = excluded.ts, payloadJson = excluded.payloadJson",
      )
      .run(id, event.sessionId, failure.validationId, failure.file, failure.testName, failure.message, failure.ts, full);
  }

  private applyJevDecision(event: StoredEvent): void {
    const log = parseWith(JevDecisionLogSchema, event.payloadJson, `jev_decision ${event.id}`);
    this.db
      .prepare(
        "INSERT INTO jev_decisions (id, sessionId, seq, changeUnitId, inputHash, outputJson, confidence, probabilitiesJson, latencyMs, clientKind, clampsJson, ts, payloadJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET sessionId = excluded.sessionId, seq = excluded.seq, changeUnitId = excluded.changeUnitId, inputHash = excluded.inputHash, outputJson = excluded.outputJson, confidence = excluded.confidence, probabilitiesJson = excluded.probabilitiesJson, latencyMs = excluded.latencyMs, clientKind = excluded.clientKind, clampsJson = excluded.clampsJson, ts = excluded.ts, payloadJson = excluded.payloadJson",
      )
      .run(
        log.id,
        event.sessionId,
        event.seq,
        log.changeUnitId ?? null,
        log.inputHash,
        JSON.stringify(log.output),
        log.confidence,
        log.probabilities ? JSON.stringify(log.probabilities) : null,
        log.latencyMs,
        log.clientKind,
        JSON.stringify(log.clamps),
        log.ts,
        event.payloadJson,
      );
  }

  private applyUiIntent(event: StoredEvent): void {
    const record = parseWith(UiIntentRecordSchema, event.payloadJson, `ui_intent ${event.id}`);
    this.db
      .prepare(
        "INSERT INTO ui_intents (id, sessionId, seq, changeUnitId, intentJson, ts, payloadJson) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET sessionId = excluded.sessionId, seq = excluded.seq, changeUnitId = excluded.changeUnitId, intentJson = excluded.intentJson, ts = excluded.ts, payloadJson = excluded.payloadJson",
      )
      .run(
        event.id,
        event.sessionId,
        event.seq,
        record.changeUnitId,
        JSON.stringify(record.intent),
        record.ts,
        event.payloadJson,
      );
  }

  private applyUiSnapshot(event: StoredEvent): void {
    const snapshot = parseWith(UiSnapshotSchema, event.payloadJson, `ui_snapshot ${event.id}`);
    this.db
      .prepare(
        "INSERT INTO ui_snapshots (id, sessionId, seq, surfaceId, changeUnitId, semanticEventId, intentJson, specJson, ts, payloadJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET sessionId = excluded.sessionId, seq = excluded.seq, surfaceId = excluded.surfaceId, changeUnitId = excluded.changeUnitId, semanticEventId = excluded.semanticEventId, intentJson = excluded.intentJson, specJson = excluded.specJson, ts = excluded.ts, payloadJson = excluded.payloadJson",
      )
      .run(
        event.id,
        event.sessionId,
        event.seq,
        snapshot.surfaceId,
        snapshot.changeUnitId ?? null,
        snapshot.semanticEventId ?? null,
        snapshot.intent ? JSON.stringify(snapshot.intent) : null,
        JSON.stringify(snapshot.spec),
        snapshot.ts,
        event.payloadJson,
      );
  }

  private applyGraphNode(event: StoredEvent): void {
    const node = parseWith(GraphNodeRecordSchema, event.payloadJson, `graph_node ${event.id}`);
    this.db
      .prepare(
        "INSERT INTO graph_nodes (id, sessionId, nodeType, payloadJson, ts) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET sessionId = excluded.sessionId, nodeType = excluded.nodeType, payloadJson = excluded.payloadJson, ts = excluded.ts",
      )
      .run(node.id, event.sessionId, node.nodeType, event.payloadJson, node.ts);
  }

  private applyGraphEdge(event: StoredEvent): void {
    const edge = parseWith(GraphEdgeRecordSchema, event.payloadJson, `graph_edge ${event.id}`);
    this.db
      .prepare(
        "INSERT INTO graph_edges (id, sessionId, fromId, toId, edgeType, payloadJson, ts) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET sessionId = excluded.sessionId, fromId = excluded.fromId, toId = excluded.toId, edgeType = excluded.edgeType, payloadJson = excluded.payloadJson, ts = excluded.ts",
      )
      .run(edge.id, event.sessionId, edge.fromId, edge.toId, edge.edgeType, event.payloadJson, edge.ts);
  }

  private applyCommand(event: StoredEvent): void {
    const command = parseWith(CommandRecordSchema, event.payloadJson, `command ${event.id}`);
    this.db
      .prepare(
        "INSERT INTO commands (id, sessionId, seq, command, exitCode, isDestructive, ts, payloadJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET sessionId = excluded.sessionId, seq = excluded.seq, command = excluded.command, exitCode = excluded.exitCode, isDestructive = excluded.isDestructive, ts = excluded.ts, payloadJson = excluded.payloadJson",
      )
      .run(
        event.id,
        event.sessionId,
        event.seq,
        command.command,
        command.exitCode ?? null,
        command.isDestructive ? 1 : 0,
        command.ts,
        event.payloadJson,
      );
  }

  private applySemanticEvent(event: StoredEvent): void {
    const semantic = parseWith(
      SemanticEventRecordSchema,
      event.payloadJson,
      `semantic_event ${event.id}`,
    );
    this.db
      .prepare(
        "INSERT INTO semantic_events (id, sessionId, seq, kind, summary, changeUnitId, evidenceJson, filesJson, symbolsJson, createdAt, ts, payloadJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET sessionId = excluded.sessionId, seq = excluded.seq, kind = excluded.kind, summary = excluded.summary, changeUnitId = excluded.changeUnitId, evidenceJson = excluded.evidenceJson, filesJson = excluded.filesJson, symbolsJson = excluded.symbolsJson, createdAt = excluded.createdAt, ts = excluded.ts, payloadJson = excluded.payloadJson",
      )
      .run(
        semantic.id,
        event.sessionId,
        event.seq,
        semantic.kind,
        semantic.summary,
        semantic.changeUnitId ?? null,
        JSON.stringify(semantic.evidence),
        JSON.stringify(semantic.files),
        JSON.stringify(semantic.symbols),
        semantic.createdAt,
        event.ts,
        event.payloadJson,
      );
  }

  private applyTelemetry(event: StoredEvent): void {
    const telemetry = parseWith(TelemetryEventSchema, event.payloadJson, `telemetry ${event.id}`);
    this.db
      .prepare(
        "INSERT INTO telemetry_events (id, sessionId, type, payloadJson, ts) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET sessionId = excluded.sessionId, type = excluded.type, payloadJson = excluded.payloadJson, ts = excluded.ts",
      )
      .run(event.id, telemetry.sessionId ?? null, telemetry.type, event.payloadJson, telemetry.ts);
  }
}

interface ChangeUnitRow {
  sessionId: string;
  title: string;
  intent: string | null;
  category: string;
  status: string;
  behaviorBefore: string | null;
  behaviorAfter: string | null;
  filesJson: string;
  symbolsJson: string;
  interfacesChangedJson: string;
  schemaChangesJson: string;
  dependencyChangesJson: string;
  relatedDecisionsJson: string;
  validationResultsJson: string;
  blastRadiusJson: string | null;
  importance: number | null;
  relevance: number | null;
  interruption: number | null;
  uncertainty: number | null;
  mentalModelChange: number | null;
  evidenceJson: string;
  createdAt: string;
  updatedAt: string;
}

function changeUnitFromRow(id: string, row: ChangeUnitRow): ChangeUnit {
  const payload = {
    id,
    sessionId: row.sessionId,
    title: row.title,
    intent: row.intent ?? undefined,
    category: row.category,
    status: row.status,
    behaviorBefore: row.behaviorBefore ?? undefined,
    behaviorAfter: row.behaviorAfter ?? undefined,
    files: parseJson(row.filesJson, `change_unit ${id} files`),
    symbols: parseJson(row.symbolsJson, `change_unit ${id} symbols`),
    interfacesChanged: parseJson(row.interfacesChangedJson, `change_unit ${id} interfaces`),
    schemaChanges: parseJson(row.schemaChangesJson, `change_unit ${id} schema`),
    dependencyChanges: parseJson(row.dependencyChangesJson, `change_unit ${id} deps`),
    relatedDecisions: parseJson(row.relatedDecisionsJson, `change_unit ${id} decisions`),
    validationResults: parseJson(row.validationResultsJson, `change_unit ${id} validations`),
    blastRadius: row.blastRadiusJson
      ? parseJson(row.blastRadiusJson, `change_unit ${id} blastRadius`)
      : undefined,
    importance: row.importance ?? undefined,
    relevance: row.relevance ?? undefined,
    interruption: row.interruption ?? undefined,
    uncertainty: row.uncertainty ?? undefined,
    mentalModelChange: row.mentalModelChange ?? undefined,
    evidence: parseJson(row.evidenceJson, `change_unit ${id} evidence`),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  return parseWith(ChangeUnitSchema, JSON.stringify(payload), `change_unit ${id}`);
}

interface DecisionRow {
  sessionId: string;
  title: string;
  context: string;
  severity: string;
  status: string;
  affectedChangeUnitsJson: string;
  evidenceJson: string;
  answerJson: string | null;
  createdAt: string;
  updatedAt: string;
}

function decisionFromRow(id: string, row: DecisionRow, options: Decision["options"]): Decision {
  const payload = {
    id,
    sessionId: row.sessionId,
    title: row.title,
    context: row.context,
    severity: row.severity,
    options,
    affectedChangeUnits: parseJson(row.affectedChangeUnitsJson, `decision ${id} units`),
    evidence: parseJson(row.evidenceJson, `decision ${id} evidence`),
    status: row.status,
    answer: row.answerJson
      ? parseJson(row.answerJson, `decision ${id} answer`)
      : undefined,
  };
  return parseWith(DecisionSchema, JSON.stringify(payload), `decision ${id}`);
}

export function openDb(options: OpenDbOptions = {}): JevcodeDb {
  const dbPath = options.dbPath ?? defaultDbPath();
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return new JevcodeDb(dbPath, db);
}

function migrate(db: BetterSqlite3.Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL, appliedAt TEXT NOT NULL)",
  );
  const row = db
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_version")
    .get() as { version: number };
  const current = row.version;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      migration.up(db);
      db.prepare("INSERT INTO schema_version (version, appliedAt) VALUES (?, ?)").run(
        migration.version,
        nowIso(),
      );
    })();
  }
  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `database schema version ${current} is newer than supported ${LATEST_SCHEMA_VERSION}`,
    );
  }
}
