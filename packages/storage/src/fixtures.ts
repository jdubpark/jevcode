import type {
  ChangeUnit,
  Decision,
  EvidenceFact,
  ExplainerRecord,
  JevDecisionLog,
  NormalizedAgentEvent,
  OverviewSnapshot,
} from "@jevcode/contracts";

export const SESSION = "sess_fixture";
export const REPO = "repo_fixture";
export const TS = "2026-01-01T00:00:00.000Z";

export function makeAgentEvent(overrides: Partial<NormalizedAgentEvent> = {}): NormalizedAgentEvent {
  return {
    type: "agent_message",
    sessionId: SESSION,
    role: "assistant",
    text: "hello",
    ts: TS,
    ...overrides,
  } as NormalizedAgentEvent;
}

export function makeFact(overrides: Partial<EvidenceFact> = {}): EvidenceFact {
  return {
    type: "file_changed",
    repoId: REPO,
    sessionId: SESSION,
    path: "src/a.ts",
    kind: "modified",
    ts: TS,
    ...overrides,
  } as EvidenceFact;
}

export function makeChangeUnit(overrides: Partial<ChangeUnit> = {}): ChangeUnit {
  return {
    id: "cu_1",
    sessionId: SESSION,
    title: "Changed 1 file: src/a.ts",
    category: "implementation",
    status: "detected",
    files: ["src/a.ts"],
    symbols: [{ id: "sym_1", name: "f", path: "src/a.ts", kind: "function" }],
    interfacesChanged: [],
    schemaChanges: [],
    dependencyChanges: [],
    relatedDecisions: [],
    validationResults: [],
    evidence: ["fact_1"],
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

export function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "dec_1",
    sessionId: SESSION,
    title: "Fail open or closed?",
    context: "rate limit",
    severity: "required",
    options: [
      {
        id: "opt_a",
        label: "Fail open",
        description: "serve anyway",
        tradeoffs: [{ dimension: "availability", consequence: "higher" }],
      },
      { id: "opt_b", label: "Fail closed", description: "reject" },
    ],
    affectedChangeUnits: ["cu_1"],
    evidence: ["fact_1"],
    status: "open",
    ...overrides,
  };
}

export function makeJevLog(overrides: Partial<JevDecisionLog> = {}): JevDecisionLog {
  return {
    id: "jev_1",
    sessionId: SESSION,
    changeUnitId: "cu_1",
    inputHash: "abc123",
    output: { shouldSurface: true },
    confidence: 0.9,
    probabilities: { behavior_change: 0.9, other: 0.1 },
    latencyMs: 120,
    clientKind: "degrade",
    clamps: ["guardrail.security"],
    ts: TS,
    ...overrides,
  };
}

export const COMPONENT_ID = "cmp_0123456789ab";

export function makeOverviewSnapshot(overrides: Partial<OverviewSnapshot> = {}): OverviewSnapshot {
  return {
    sessionId: SESSION,
    repoRoot: "/work/fixture",
    scanId: "scan_1",
    partial: false,
    counts: { files: 2, components: 1, edges: 0, languages: ["TypeScript"] },
    components: [
      {
        id: COMPONENT_ID,
        rootPath: "packages/core",
        name: "@fixture/core",
        fileCount: 2,
        files: ["packages/core/src/a.ts", "packages/core/src/b.ts"],
        language: "TypeScript",
        roleGuess: "domain",
        role: "domain",
        purpose: null,
        provenance: "rule",
        contentHash: "0".repeat(40),
        externalDeps: [],
        entryPoints: ["packages/core/src/a.ts"],
        importsAnalyzed: true,
      },
    ],
    edges: [],
    externals: [],
    narrative: null,
    generatedAt: TS,
    ...overrides,
  };
}

export function makeExplainerStory(overrides: { sessionId?: string; basisSeq?: number } = {}): ExplainerRecord {
  return {
    sessionId: overrides.sessionId ?? SESSION,
    kind: "story",
    sentences: [{ text: "The agent added a session cache.", citations: [{ kind: "component", id: COMPONENT_ID }] }],
    basisSeq: overrides.basisSeq ?? 1,
  };
}
