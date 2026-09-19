import type { JevClientKind, JevDecisionLog } from "@jevcode/contracts";

export function hashInput(input: unknown): string {
  const serialized = stableSerialize(input);
  let hash = 5381;
  for (let i = 0; i < serialized.length; i += 1) {
    hash = ((hash << 5) + hash + serialized.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function stableSerialize(input: unknown): string {
  if (input === null || typeof input !== "object") {
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) {
    return `[${input.map(stableSerialize).join(",")}]`;
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(",")}}`;
}

export interface BuildJevDecisionRecordInput {
  sessionId: string;
  changeUnitId?: string;
  inputHash: string;
  output: unknown;
  confidence: number;
  probabilities?: Record<string, number>;
  latencyMs: number;
  clientKind: JevClientKind;
  clamps: string[];
  ts?: string;
}

export function buildJevDecisionRecord(
  input: BuildJevDecisionRecordInput,
): JevDecisionLog {
  const ts = input.ts ?? new Date().toISOString();
  return {
    id: `jev:${input.inputHash}:${hashInput(`${input.inputHash}:${ts}`)}`,
    sessionId: input.sessionId,
    changeUnitId: input.changeUnitId,
    inputHash: input.inputHash,
    output: input.output,
    confidence: input.confidence,
    probabilities: input.probabilities,
    latencyMs: input.latencyMs,
    clientKind: input.clientKind,
    clamps: input.clamps,
    ts,
  };
}
