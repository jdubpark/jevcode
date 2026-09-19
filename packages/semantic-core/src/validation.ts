import type { EvidenceFact, ValidationResult } from "@jevcode/contracts";

import { hashId } from "./ids.js";
import type { FailureRecord } from "./persistence.js";

export interface ExtractedValidation {
  validation: ValidationResult;
  failures: FailureRecord[];
}

export function extractTestResult(
  fact: Extract<EvidenceFact, { type: "test_result" }>,
  sessionId: string,
): ExtractedValidation {
  const key = `${fact.runner}\u0000${fact.command}\u0000${fact.ts}`;
  const validation: ValidationResult = {
    id: hashId("val", sessionId, key),
    kind: "test",
    command: fact.command,
    status: fact.failed > 0 ? "failed" : "passed",
    passed: fact.passed,
    failed: fact.failed,
    skipped: fact.skipped,
    ts: fact.ts,
  };
  const failures: FailureRecord[] = fact.failures.map((failure) => ({
    id: hashId("fail", sessionId, validation.id, failure.file, failure.testName),
    sessionId,
    validationId: validation.id,
    file: failure.file,
    testName: failure.testName,
    message: failure.message,
    ts: fact.ts,
  }));
  return { validation, failures };
}
