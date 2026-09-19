import type {
  AttentionDecision,
  ChangeUnit,
  EvidenceFact,
  SemanticEventKind,
  SymbolRef,
} from "@jevcode/contracts";

import type { AttentionInput, EvidenceHints, ProjectionInput } from "../types.js";
import { attentionInputFromHints } from "../state.js";

export const SESSION_ID = "sess-test-0001";
export const UNIT_ID = "cu-test-0001";

export function makeHints(overrides: Partial<EvidenceHints> = {}): EvidenceHints {
  return {
    diffStats: { added: 0, removed: 0 },
    formattingOnly: false,
    lockfileOnly: false,
    configOnly: false,
    destructiveCommands: [],
    securityPaths: [],
    schemaPaths: [],
    publicExports: [],
    behaviorChange: false,
    interfacesChanged: 0,
    dependencyChanges: [],
    testResults: [],
    decisionIds: [],
    autoCollapsePassingTests: false,
    ...overrides,
  };
}

export function makeInput(
  overrides: Omit<Partial<AttentionInput>, "hints"> & {
    hints?: Partial<EvidenceHints>;
  } = {},
): AttentionInput {
  const { hints, ...rest } = overrides;
  return attentionInputFromHints({
    changeUnitId: UNIT_ID,
    decisionVersion: 1,
    sessionId: SESSION_ID,
    title: "Changed files",
    status: "detected",
    files: ["src/app.ts"],
    symbols: ["run"],
    taskPrompt: "Add rate limiting to the public API.",
    createdAt: "2026-09-18T09:00:00.000Z",
    ...rest,
    hints,
  });
}

export function makeProjectionInput(
  attention: Partial<AttentionDecision> = {},
  overrides: Omit<Partial<AttentionInput>, "hints"> & {
    hints?: Partial<EvidenceHints>;
  } = {},
): ProjectionInput {
  return {
    ...makeInput(overrides),
    attention: {
      shouldSurface: true,
      importance: 0.6,
      relevance: 0.6,
      interruption: 0.1,
      mentalModelChange: 0.4,
      semanticCategory: "implementation_change" as SemanticEventKind,
      scope: "module",
      humanDecision: "none",
      needsSystem2: false,
      confidence: 0.8,
      probabilities: { implementation_change: 0.8 },
      ...attention,
    },
  };
}

export function makeSymbolRef(name: string, path = "src/app.ts"): SymbolRef {
  return { id: `sym-${name}`, name, path, kind: "function" };
}

export function makeUnit(overrides: Partial<ChangeUnit> = {}): ChangeUnit {
  return {
    id: UNIT_ID,
    sessionId: SESSION_ID,
    title: "Changed 1 file: src/app.ts",
    category: "implementation",
    status: "detected",
    files: ["src/app.ts"],
    symbols: [makeSymbolRef("run")],
    interfacesChanged: [],
    schemaChanges: [],
    dependencyChanges: [],
    relatedDecisions: [],
    validationResults: [],
    evidence: ["fact-hunk-1"],
    createdAt: "2026-09-18T09:00:00.000Z",
    updatedAt: "2026-09-18T09:00:05.000Z",
    ...overrides,
  };
}

export function hunkFact(
  file: string,
  overrides: Partial<Extract<EvidenceFact, { type: "git_hunk" }>> = {},
): EvidenceFact {
  return {
    type: "git_hunk",
    repoId: "repo-test",
    sessionId: SESSION_ID,
    ts: "2026-09-18T09:00:05.000Z",
    file,
    added: 4,
    removed: 1,
    isFormattingOnly: false,
    isConfigOnly: false,
    isLockfile: false,
    ...overrides,
  };
}

export function commandFact(
  command: string,
  isDestructive = false,
): EvidenceFact {
  return {
    type: "command_executed",
    repoId: "repo-test",
    sessionId: SESSION_ID,
    ts: "2026-09-18T09:00:06.000Z",
    command,
    exitCode: 0,
    isDestructive,
  };
}

export function testResultFact(
  overrides: Partial<Extract<EvidenceFact, { type: "test_result" }>> = {},
): EvidenceFact {
  return {
    type: "test_result",
    repoId: "repo-test",
    sessionId: SESSION_ID,
    ts: "2026-09-18T09:00:07.000Z",
    runner: "vitest",
    command: "pnpm test",
    passed: 5,
    failed: 0,
    skipped: 0,
    failures: [],
    ...overrides,
  };
}

export function symbolDeltaFact(
  path: string,
  overrides: Partial<Extract<EvidenceFact, { type: "symbol_delta" }>> = {},
): EvidenceFact {
  return {
    type: "symbol_delta",
    repoId: "repo-test",
    sessionId: SESSION_ID,
    ts: "2026-09-18T09:00:05.500Z",
    path,
    added: [],
    removed: [],
    modified: [],
    ...overrides,
  };
}
