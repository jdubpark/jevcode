import type {
  ChangeUnit,
  EvidenceFact,
  EvidenceRef,
  SemanticEvent,
  SemanticEventKind,
} from "@jevcode/contracts";

import { isSchemaPath, isSecurityPath, isRoutePath } from "./categories.js";
import { hashId } from "./ids.js";

type EvidenceRefType = EvidenceRef["type"];

export interface UnitEventInput {
  unit: ChangeUnit;
  facts: readonly EvidenceFact[];
  unitValidationIds: readonly string[];
  hasFailures: boolean;
}

const FACT_REF_TYPE: Record<EvidenceFact["type"], EvidenceRefType> = {
  git_hunk: "git_hunk",
  file_changed: "file",
  symbol_delta: "symbol",
  dependency_change: "file",
  test_result: "test_output",
  command_executed: "command",
  revert_detected: "file",
};

export function evidenceRefForFact(fact: EvidenceFact): EvidenceRef {
  const sourceId = factSourceId(fact);
  return {
    id: hashId("ev", fact.type, fact.ts, sourceId),
    type: FACT_REF_TYPE[fact.type],
    sourceId,
  };
}

export function factSourceId(fact: EvidenceFact): string {
  switch (fact.type) {
    case "git_hunk":
      return fact.file;
    case "file_changed":
      return fact.path;
    case "symbol_delta":
      return fact.path;
    case "dependency_change":
      return fact.manifest;
    case "test_result":
      return fact.command;
    case "command_executed":
      return fact.command;
    case "revert_detected":
      return fact.files.join(",");
  }
}

export function kindForUnit(input: UnitEventInput): SemanticEventKind {
  if (input.hasFailures) return "failure";
  if (input.unit.validationResults.length > 0) return "test_result";
  if (input.facts.some((fact) => fact.type === "dependency_change")) return "dependency_change";
  const files = input.unit.files;
  if (files.some((file) => isSecurityPath(file))) return "security_change";
  if (files.some((file) => isSchemaPath(file))) return "schema_change";
  if (files.some((file) => isRoutePath(file))) return "behavior_change";
  return "implementation_change";
}

export function buildSemanticEvent(input: UnitEventInput, nowIso: string): SemanticEvent {
  const evidence = input.facts.map((fact) => evidenceRefForFact(fact));
  const symbols = input.unit.symbols.map((symbol) => symbol.name);
  return {
    id: hashId("sem", input.unit.id),
    sessionId: input.unit.sessionId,
    kind: kindForUnit(input),
    summary: input.unit.title,
    changeUnitId: input.unit.id,
    evidence,
    files: [...input.unit.files],
    symbols,
    createdAt: nowIso,
  };
}
