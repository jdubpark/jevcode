import type {
  AttentionDecision,
  ChangeUnit,
  EvidenceFact,
  SemanticEventKind,
  UIIntent,
} from "@jevcode/contracts";

import { isDestructiveCommand, isSchemaPath, isSecurityPath, isTestPath } from "./patterns.js";
import type { AttentionInput, EvidenceHints, ProjectionInput, SessionContext } from "./types.js";

export const MAX_FILES = 40;
export const MAX_SYMBOLS = 60;
export const MAX_TASK_PROMPT_CHARS = 4096;

export function truncateTaskPrompt(
  prompt: string,
  max = MAX_TASK_PROMPT_CHARS,
): string {
  if (prompt.length <= max) return prompt;
  return prompt.slice(0, max);
}

const EMPTY_HINTS: EvidenceHints = {
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
};

function diffStatsFor(files: readonly string[], facts: readonly EvidenceFact[]) {
  const fileSet = new Set(files);
  const hunks = facts.filter(
    (fact): fact is Extract<EvidenceFact, { type: "git_hunk" }> =>
      fact.type === "git_hunk" && fileSet.has(fact.file),
  );
  const added = hunks.reduce((sum, hunk) => sum + hunk.added, 0);
  const removed = hunks.reduce((sum, hunk) => sum + hunk.removed, 0);
  const formattingOnly = hunks.length > 0 && hunks.every((h) => h.isFormattingOnly);
  const lockfileOnly = hunks.length > 0 && hunks.every((h) => h.isLockfile);
  const configOnly = hunks.length > 0 && hunks.every((h) => h.isConfigOnly);
  return { added, removed, formattingOnly, lockfileOnly, configOnly };
}

function destructiveCommandsFor(facts: readonly EvidenceFact[]): string[] {
  return facts
    .filter(
      (fact): fact is Extract<EvidenceFact, { type: "command_executed" }> =>
        fact.type === "command_executed" &&
        (fact.isDestructive || isDestructiveCommand(fact.command)),
    )
    .map((fact) => fact.command);
}

const SPECIFIER_NAME_RE = /(^\.)|[\\/]/;

const NAMED_IMPORT_CLAUSE_RE = /\{([^}]*)\}/;

// The evidence-engine tree-sitter parser emits one "import" symbol per local
// binding: the symbol name is the local binding and the full import statement
// lives in the signature. To match against the exporting module's binding
// names, recover the original imported names from the signature's import
// clause (handling `import { name as alias }`), falling back to the local
// binding for default and side-effect imports.
function importedNamesFromSignature(signature: string): string[] {
  const names: string[] = [];
  const clause = NAMED_IMPORT_CLAUSE_RE.exec(signature);
  if (clause) {
    for (const rawSpec of clause[1]?.split(",") ?? []) {
      const spec = rawSpec.trim();
      if (spec.length === 0) continue;
      const original = spec.split(/\s+as\s+/)[0]?.trim();
      if (original && original.length > 0) names.push(original);
    }
  }
  return names;
}

// Public-export heuristic (SPEC 8.3.4) against current parser shapes: kind
// "export" symbols are named by the exported binding, kind "import" symbols
// are named by the local binding with the specifier in the signature.
// Module-specifier pseudo-names (`export * from "./x"`, side-effect imports)
// are skipped so paths never collide with binding names.
function publicExportsFor(files: readonly string[], facts: readonly EvidenceFact[]): string[] {
  const fileSet = new Set(files);
  const exported = new Set<string>();
  const importedElsewhere = new Set<string>();
  for (const fact of facts) {
    if (fact.type !== "symbol_delta") continue;
    const all = [...fact.added, ...fact.modified, ...fact.removed];
    for (const symbol of all) {
      if (symbol.kind === "export" && fileSet.has(fact.path)) {
        if (!SPECIFIER_NAME_RE.test(symbol.name)) exported.add(symbol.name);
      }
      if (symbol.kind === "import" && !fileSet.has(fact.path)) {
        const imported = importedNamesFromSignature(symbol.signature);
        const names = imported.length > 0 ? imported : [symbol.name];
        for (const name of names) {
          if (!SPECIFIER_NAME_RE.test(name)) importedElsewhere.add(name);
        }
      }
    }
  }
  return [...exported].filter((name) => importedElsewhere.has(name)).sort();
}

function dependencyChangesFor(files: readonly string[], facts: readonly EvidenceFact[]) {
  const fileSet = new Set(files);
  const changes: EvidenceHints["dependencyChanges"] = [];
  for (const fact of facts) {
    if (fact.type !== "dependency_change") continue;
    if (!fileSet.has(fact.manifest)) continue;
    for (const added of fact.added) {
      changes.push({ name: added.name, change: "added" });
    }
    for (const removed of fact.removed) {
      changes.push({ name: removed.name, change: "removed" });
    }
  }
  return changes;
}

function testResultsFor(files: readonly string[], facts: readonly EvidenceFact[]) {
  const fileSet = new Set(files);
  return facts
    .filter(
      (fact): fact is Extract<EvidenceFact, { type: "test_result" }> =>
        fact.type === "test_result",
    )
    .filter((fact) => {
      if (fact.failed > 0) {
        if (fact.failures.length === 0) return true;
        return fact.failures.some((failure) => fileSet.has(failure.file));
      }
      return files.some((file) => isTestPath(file));
    })
    .map((fact) => ({
      runner: fact.runner,
      passed: fact.passed,
      failed: fact.failed,
      skipped: fact.skipped,
      failureFiles: fact.failures.map((failure) => failure.file),
    }));
}

export type EvidenceHintFields = Pick<
  EvidenceHints,
  | "diffStats"
  | "formattingOnly"
  | "lockfileOnly"
  | "configOnly"
  | "destructiveCommands"
  | "securityPaths"
  | "schemaPaths"
  | "publicExports"
  | "dependencyChanges"
  | "testResults"
>;

// Shared, pure derivation of the evidence-derived hint fields from a unit's
// file set and the session facts. Consumed by both the jev-router pipeline
// (attentionInputFromChangeUnit) and the evals scenario loader so the two
// cannot drift.
export function collectAttentionHints(
  files: readonly string[],
  facts: readonly EvidenceFact[],
): EvidenceHintFields {
  const diff = diffStatsFor(files, facts);
  return {
    diffStats: { added: diff.added, removed: diff.removed },
    formattingOnly: diff.formattingOnly,
    lockfileOnly: diff.lockfileOnly,
    configOnly: diff.configOnly,
    destructiveCommands: destructiveCommandsFor(facts),
    securityPaths: files.filter((f) => isSecurityPath(f)),
    schemaPaths: files.filter((f) => isSchemaPath(f)),
    publicExports: publicExportsFor(files, facts),
    dependencyChanges: dependencyChangesFor(files, facts),
    testResults: testResultsFor(files, facts),
  };
}

function collectHints(
  unit: ChangeUnit,
  sessionCtx: SessionContext,
  unitFacts: EvidenceFact[],
): EvidenceHints {
  const decisionIds = Array.from(
    new Set([
      ...unit.relatedDecisions,
      ...(sessionCtx.decisionsForUnit?.[unit.id] ?? []),
    ]),
  );
  return {
    ...collectAttentionHints(unit.files, unitFacts),
    behaviorChange: Boolean(unit.behaviorBefore ?? unit.behaviorAfter),
    interfacesChanged: unit.interfacesChanged.length,
    decisionIds,
    autoCollapsePassingTests: sessionCtx.autoCollapsePassingTests ?? false,
  };
}

export function attentionInputFromChangeUnit(
  unit: ChangeUnit,
  sessionCtx: SessionContext,
  decisionVersion: number,
): AttentionInput {
  const hints = collectHints(unit, sessionCtx, sessionCtx.facts);
  return {
    changeUnitId: unit.id,
    decisionVersion,
    sessionId: unit.sessionId,
    title: unit.title,
    intent: unit.intent,
    categoryHint: unit.category,
    status: unit.status,
    files: unit.files.slice(0, MAX_FILES),
    symbols: unit.symbols.map((s) => s.name).slice(0, MAX_SYMBOLS),
    taskPrompt: truncateTaskPrompt(sessionCtx.taskPrompt),
    hints,
    createdAt: unit.createdAt,
  };
}

export function projectionInput(
  unit: ChangeUnit,
  attention: AttentionDecision,
  sessionCtx: SessionContext,
  decisionVersion: number,
): ProjectionInput {
  return {
    ...attentionInputFromChangeUnit(unit, sessionCtx, decisionVersion),
    attention,
  };
}

export function attentionInputFromHints(
  input: Omit<AttentionInput, "hints" | "taskPrompt" | "symbols" | "files"> & {
    files?: string[];
    symbols?: string[];
    taskPrompt?: string;
    hints?: Partial<EvidenceHints>;
  },
): AttentionInput {
  return {
    ...input,
    files: (input.files ?? []).slice(0, MAX_FILES),
    symbols: (input.symbols ?? []).slice(0, MAX_SYMBOLS),
    taskPrompt: truncateTaskPrompt(input.taskPrompt ?? ""),
    hints: { ...EMPTY_HINTS, ...(input.hints ?? {}) },
  };
}

export function subjectFromCategory(category: SemanticEventKind): UIIntent["subject"] {
  switch (category) {
    case "behavior_change":
      return "behavior";
    case "architecture_change":
      return "architecture";
    case "api_change":
      return "api";
    case "schema_change":
      return "schema";
    case "dependency_change":
      return "dependency";
    case "security_change":
      return "security";
    case "test_result":
    case "failure":
      return "tests";
    case "decision_candidate":
      return "decision";
    case "implementation_change":
      return "code";
  }
}
