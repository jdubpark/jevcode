// Test-only: builds TraceRow sequences for model unit tests. Excluded from the build.
import type {
  ChangeUnit,
  Decision,
  EvidenceFact,
  JevDecisionLog,
  NormalizedAgentEvent,
  TraceRow,
  TraceSessionSummary,
  ValidationResult,
} from "@jevcode/contracts";

export const SESSION_ID = "sess-test";
export const REPO_ID = "repo-test";
export const T0_ISO = "2026-09-18T09:00:00.000Z";
const T0 = Date.parse(T0_ISO);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type AgentInput = DistributiveOmit<NormalizedAgentEvent, "sessionId" | "ts"> & { ts?: string };
export type FactInput = DistributiveOmit<EvidenceFact, "sessionId" | "ts" | "repoId"> & { ts?: string };
export type UnitInput = Partial<ChangeUnit> & Pick<ChangeUnit, "id" | "files">;
export type DecisionInput = Partial<Decision> & Pick<Decision, "id">;
export type ValidationInput = Omit<ValidationResult, "ts"> & { ts?: string };
export type JevInput = Partial<JevDecisionLog> & Pick<JevDecisionLog, "id" | "clamps">;

export function testMeta(overrides: Partial<TraceSessionSummary> = {}): TraceSessionSummary {
  return {
    sessionId: SESSION_ID,
    repoId: REPO_ID,
    repoName: "test",
    prompt: "Test task",
    state: "completed",
    startedAt: T0_ISO,
    endedAt: null,
    lastEventSeq: 0,
    ...overrides,
  };
}

/** Appends rows with seq 1, 2, 3, … and, unless a ts is given, ts = T0 + (seq - 1) s. */
export class TraceBuilder {
  readonly rows: TraceRow[] = [];

  /** ISO ts `seconds` after T0. */
  static at(seconds: number): string {
    return new Date(T0 + seconds * 1000).toISOString();
  }

  private nextTs(ts: string | undefined): string {
    return ts ?? new Date(T0 + this.rows.length * 1000).toISOString();
  }

  raw(type: string, payload: unknown, ts?: string, extra: Partial<TraceRow> = {}): number {
    const seq = this.rows.length + 1;
    this.rows.push({ seq, type, ts: this.nextTs(ts), payload, ...extra });
    return seq;
  }

  agent(input: AgentInput): number {
    const ts = this.nextTs(input.ts);
    return this.raw("agent_event", { ...input, sessionId: SESSION_ID, ts }, ts);
  }

  fact(input: FactInput, factId?: string): number {
    const ts = this.nextTs(input.ts);
    return this.raw(
      "evidence_fact",
      { ...input, repoId: REPO_ID, sessionId: SESSION_ID, ts },
      ts,
      factId !== undefined ? { factId } : {},
    );
  }

  unit(input: UnitInput): number {
    const ts = this.nextTs(input.updatedAt);
    const unit: ChangeUnit = {
      sessionId: SESSION_ID,
      title: `Unit ${input.id}`,
      category: "implementation",
      status: "in_progress",
      symbols: [],
      interfacesChanged: [],
      schemaChanges: [],
      dependencyChanges: [],
      relatedDecisions: [],
      validationResults: [],
      evidence: [],
      createdAt: ts,
      updatedAt: ts,
      ...input,
    };
    return this.raw("change_unit", unit, ts);
  }

  decision(input: DecisionInput): number {
    const decision: Decision = {
      sessionId: SESSION_ID,
      title: `Decision ${input.id}`,
      context: "",
      severity: "required",
      options: [
        { id: "a", label: "Option A", description: "" },
        { id: "b", label: "Option B", description: "" },
      ],
      affectedChangeUnits: [],
      evidence: [],
      status: "open",
      ...input,
    };
    return this.raw("decision", decision, this.nextTs(input.ts));
  }

  validation(input: ValidationInput): number {
    const ts = this.nextTs(input.ts);
    return this.raw("validation", { ...input, ts }, ts);
  }

  jev(input: JevInput): number {
    const ts = this.nextTs(input.ts);
    const log: JevDecisionLog = {
      sessionId: SESSION_ID,
      inputHash: "hash",
      output: {},
      confidence: 0.9,
      latencyMs: 10,
      clientKind: "typesafe",
      ...input,
      ts,
    };
    return this.raw("jev_decision", log, ts);
  }
}
