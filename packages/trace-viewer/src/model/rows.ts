import {
  ChangeUnitSchema,
  DecisionSchema,
  EvidenceFactSchema,
  JevDecisionLogSchema,
  NormalizedAgentEventSchema,
  SemanticEventSchema,
  ValidationResultSchema,
  type EventStoreType,
  type EvidenceFact,
  type TraceRow,
} from "@jevcode/contracts";
import type { z } from "zod";

export interface PipelineRowOptions {
  /** Called for evidence facts; the harness passes semantic-core's factContentId. The model never hashes. */
  factId?: (fact: EvidenceFact) => string;
  /** Default 1. */
  firstSeq?: number;
}

// Same precedence as parseReplayLine (packages/semantic-core/src/coordinator.ts): a
// file_changed with repoId is a fact, without repoId an agent claim.
const RECORD_KINDS: readonly { type: EventStoreType; schema: z.ZodTypeAny }[] = [
  { type: "evidence_fact", schema: EvidenceFactSchema },
  { type: "agent_event", schema: NormalizedAgentEventSchema },
  { type: "decision", schema: DecisionSchema },
  { type: "change_unit", schema: ChangeUnitSchema },
  { type: "validation", schema: ValidationResultSchema },
  { type: "jev_decision", schema: JevDecisionLogSchema },
  { type: "semantic_event", schema: SemanticEventSchema },
];

function stringField(record: unknown, key: string): string | undefined {
  if (record === null || typeof record !== "object") return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Classifies each record (EvidenceFact, NormalizedAgentEvent, Decision, ChangeUnit,
 * ValidationResult, JevDecisionLog, SemanticEvent, tried in that order) into a TraceRow;
 * seq = firstSeq + index; ts = record.ts, else updatedAt, else createdAt, else the
 * previous row's ts. Throws TypeError on an unknown record.
 */
export function rowsFromPipelineRecords(
  records: readonly unknown[],
  options: PipelineRowOptions = {},
): TraceRow[] {
  const firstSeq = options.firstSeq ?? 1;
  if (!Number.isInteger(firstSeq) || firstSeq < 1) {
    throw new RangeError(`firstSeq must be a positive integer, got ${String(firstSeq)}`);
  }
  const rows: TraceRow[] = [];
  let previousTs = "";
  records.forEach((record, index) => {
    const kind = RECORD_KINDS.find((candidate) => candidate.schema.safeParse(record).success);
    if (kind === undefined) {
      throw new TypeError(`record ${index} matches no pipeline schema: ${JSON.stringify(record)?.slice(0, 80)}`);
    }
    const ts =
      stringField(record, "ts") ?? stringField(record, "updatedAt") ?? stringField(record, "createdAt") ?? previousTs;
    previousTs = ts;
    const row: TraceRow = { seq: firstSeq + index, type: kind.type, ts, payload: record };
    if (kind.type === "evidence_fact" && options.factId !== undefined) {
      row.factId = options.factId(record as EvidenceFact);
    }
    rows.push(row);
  });
  return rows;
}
