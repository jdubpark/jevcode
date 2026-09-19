import type { SemanticEventKind } from "@jevcode/contracts";

import type { AttentionInput, TypeSafeQuestion } from "./types.js";

export const SEMANTIC_KINDS: readonly SemanticEventKind[] = [
  "behavior_change",
  "architecture_change",
  "api_change",
  "schema_change",
  "dependency_change",
  "security_change",
  "test_result",
  "failure",
  "decision_candidate",
  "implementation_change",
];

export const SCOPES = ["local", "module", "subsystem", "repository"] as const;

export const HUMAN_DECISIONS = [
  "none",
  "optional",
  "recommended",
  "required",
] as const;

export const REPRESENTATIONS = [
  "summary",
  "before_after",
  "diff",
  "diagram",
  "table",
  "graph",
  "decision",
  "failure",
  "timeline",
] as const;

export const ATTENTION_LEVELS = [
  "background",
  "surface",
  "highlight",
  "interrupt",
] as const;

export const DENSITY_LEVELS = ["compact", "normal", "detailed", "expert"] as const;

export const CATALOG_COMPONENTS = [
  "ChangeOverview",
  "BehaviorDelta",
  "ArchitectureDelta",
  "SchemaDelta",
  "CodeDiff",
  "Decision",
  "TestMatrix",
  "FailureAnalysis",
  "ExecutionTimeline",
  "Terminal",
  "DependencyDelta",
] as const;

export const MAX_SECONDARY_VIEWS = 3;

const CATEGORY_DESCRIPTIONS: Record<SemanticEventKind, string> = {
  behavior_change: "Observable runtime behavior changed",
  architecture_change: "Module, service, or flow structure changed",
  api_change: "Public interface or contract changed",
  schema_change: "Database schema, data model, or migration changed",
  dependency_change: "Packages or dependencies added, removed, or changed",
  security_change: "Auth, sessions, tokens, permissions, or secrets changed",
  test_result: "Test or validation results changed",
  failure: "A test, build, or check failed",
  decision_candidate: "A human decision or tradeoff needs to be made",
  implementation_change: "Internal implementation detail changed",
};

const IMPORTANCE_LEVELS = [
  "Negligible: cosmetic or no functional consequence (formatting, comments, snapshot updates, lockfile-only churn)",
  "Minor: small local effect, e.g. an internal rename",
  "Moderate: affects one module's behavior or internal structure",
  "Major: affects subsystem behavior or public interfaces",
  "Critical: schema, security, or repository-wide consequence",
];

const RELEVANCE_LEVELS = [
  "Not useful for the developer to see at the current moment (includes noise such as formatting-only or lockfile-only churn that will be suppressed)",
  "Marginally useful to see right now",
  "Somewhat useful for the current task",
  "Useful for the developer to see at this moment",
  "Essential for the developer to see at this moment",
];

const INTERRUPTION_LEVELS = [
  "The agent should definitely not stop; no human judgment needed",
  "The agent probably should not stop",
  "Borderline: stopping is defensible but not necessary",
  "Worth stopping the agent to request human judgment",
  "The agent must stop and request human judgment",
];

const MENTAL_MODEL_LEVELS = [
  "No change to a competent developer's conceptual model",
  "Tiny conceptual update, e.g. one implementation detail",
  "Localized conceptual change within one part of the system",
  "Significant change to how a developer understands the system",
  "A developer must relearn a core part of the system",
];

const PROMPT_POLICY = `You are routing changes in a coding-agent workspace for a supervising developer.
The Jevcode component catalog is: ChangeOverview, BehaviorDelta, ArchitectureDelta, SchemaDelta,
CodeDiff, Decision, TestMatrix, FailureAnalysis, ExecutionTimeline, Terminal, DependencyDelta.
Triad definitions:
- importance: how consequential is this change to the software?
- relevance: how useful is it for the developer to see this change at the current moment?
- interruption: should the agent stop and request human judgment?
- mental_model_change: how much must a competent developer's conceptual model of the system change?
Labeled examples (PRD section 34):
- Unimportant formatting (Prettier whitespace in 8 files): importance 0.02, relevance 0.01, interruption 0.00. Suppress.
- Database migration: importance 0.96, relevance 0.88, interruption 0.10. Surface prominently, do not stop the agent.
- Destructive data decision: importance 0.99, relevance 0.99, interruption 0.98. Interrupt and ask the developer.
- New dependency (ioredis for distributed rate limiting): importance 0.72, relevance 0.81, interruption 0.08.`;

export function passAQuestions(unitKey: string): Record<string, TypeSafeQuestion> {
  const key = (name: string) => `${unitKey}:${name}`;
  return {
    [key("should_surface")]: {
      type: "noul",
      instructions:
        `Judging \`units\` entry \`${unitKey}\` against its title, category hint, files, symbols, ` +
        "diff stats, test outcomes, and decision presence: does this change deserve a developer-visible surface?",
      criteria: {
        true: "The developer should see a semantic surface for this change.",
        false: "This change is noise: formatting, lockfile churn, trivial internals, or passing-only validation.",
      },
    },
    [key("semantic_category")]: {
      type: "choice",
      instructions:
        `What semantic category best describes the change in \`units\` entry \`${unitKey}\`?`,
      criteria: CATEGORY_DESCRIPTIONS,
    },
    [key("importance")]: {
      type: "score",
      instructions:
        `How consequential is the change in \`units\` entry \`${unitKey}\` to the software? ` +
        "Weigh the formatting_only, lockfile_only, diff_stats, category_hint, and security/schema paths carefully.",
      criteria: IMPORTANCE_LEVELS,
    },
    [key("relevance")]: {
      type: "score",
      instructions:
        `How useful is it for the developer to see the change in \`units\` entry \`${unitKey}\` ` +
        "at the current moment of this task? Noise (formatting_only or lockfile_only) is never useful to see.",
      criteria: RELEVANCE_LEVELS,
    },
    [key("interruption")]: {
      type: "score",
      instructions:
        `Should the agent stop and request human judgment about the change in \`units\` entry \`${unitKey}\`?`,
      criteria: INTERRUPTION_LEVELS,
    },
    [key("mental_model_change")]: {
      type: "score",
      instructions:
        `How much must a competent developer's conceptual model of the system change because of ` +
        `\`units\` entry \`${unitKey}\`?`,
      criteria: MENTAL_MODEL_LEVELS,
    },
    [key("scope")]: {
      type: "choice",
      instructions:
        `What is the scope of the change in \`units\` entry \`${unitKey}\`?`,
      criteria: {
        local: "A single file or function; no wider effect",
        module: "One module or a few closely related files",
        subsystem: "A feature area or subsystem spanning several modules",
        repository: "Repository-wide impact",
      },
    },
    [key("human_decision")]: {
      type: "choice",
      instructions:
        `Does the change in \`units\` entry \`${unitKey}\` require a human decision before the agent continues?`,
      criteria: {
        none: "No decision needed; the agent should proceed",
        optional: "A decision is possible but the agent may proceed without it",
        recommended: "A decision should be made; stopping is recommended",
        required: "The agent must stop and wait for a human decision",
      },
    },
    [key("needs_system2")]: {
      type: "noul",
      instructions:
        `Judging \`units\` entry \`${unitKey}\`: would deeper System-2 analysis of this change ` +
        "be worthwhile for the developer?",
      criteria: {
        true: "A slower, deeper analysis would add real value here.",
        false: "The developer can understand this change without deeper analysis.",
      },
    },
  };
}

export function passBQuestions(): Record<string, TypeSafeQuestion> {
  const questions: Record<string, TypeSafeQuestion> = {
    representation: {
      type: "choice",
      instructions:
        "Which UI representation best presents this change to the developer?",
      criteria: {
        summary: "A plain semantic summary of the change (ChangeOverview)",
        before_after: "Before/after behavior comparison (BehaviorDelta)",
        diff: "The raw code diff (CodeDiff)",
        diagram: "A node/edge architecture diagram (ArchitectureDelta)",
        table: "A table of schema or validation rows (SchemaDelta or TestMatrix)",
        graph: "A dependency graph (DependencyDelta)",
        decision: "A decision card with options and tradeoffs (Decision)",
        failure: "A failure analysis with linked changes and next actions (FailureAnalysis)",
        timeline: "A timeline of meaningful milestones (ExecutionTimeline)",
      },
    },
    attention: {
      type: "choice",
      instructions: "How much developer attention should this surface demand?",
      criteria: {
        background: "Keep in the background; do not disturb the developer",
        surface: "Show as a normal surface in the workspace",
        highlight: "Show prominently as the developer should see this soon",
        interrupt: "Interrupt the developer immediately",
      },
    },
    density: {
      type: "choice",
      instructions: "What information density fits this surface?",
      criteria: {
        compact: "Minimal: title, category, and confidence only",
        normal: "Standard summary with evidence chips",
        detailed: "Summary plus evidence, symbols, and affected files",
        expert: "Everything: evidence, symbols, code, and validation detail",
      },
    },
    show_evidence: {
      type: "noul",
      instructions:
        "Should this surface show its supporting evidence (files, symbols, test outcomes) to the developer?",
      criteria: {
        true: "Evidence helps the developer trust or verify this surface.",
        false: "Evidence would be noise here.",
      },
    },
    show_code: {
      type: "noul",
      instructions:
        "Should this surface include code excerpts or diffs inline?",
      criteria: {
        true: "Code detail is essential to understand this change.",
        false: "Code detail is unnecessary here.",
      },
    },
  };
  for (const component of CATALOG_COMPONENTS) {
    questions[`secondary:${component}`] = {
      type: "noul",
      instructions:
        `Would the developer benefit from a secondary \`${component}\` view alongside the main representation of this change?`,
      criteria: {
        true: `A secondary ${component} view adds real value.`,
        false: `A secondary ${component} view adds no value.`,
      },
    };
  }
  return questions;
}

export interface UnitModelState {
  id: string;
  title: string;
  intent: string;
  category_hint: string;
  status: string;
  files: string[];
  symbols: string[];
  diff_stats: { added: number; removed: number };
  formatting_only: boolean;
  lockfile_only: boolean;
  destructive_commands: string[];
  security_paths: string[];
  schema_paths: string[];
  public_exports: string[];
  behavior_change: boolean;
  interfaces_changed: number;
  dependency_changes: { name: string; change: "added" | "removed" }[];
  test_outcomes: { runner: string; passed: number; failed: number; skipped: number }[];
  decision_presence: boolean;
  decision_ids: string[];
}

export function unitModelState(input: AttentionInput): UnitModelState {
  return {
    id: input.changeUnitId,
    title: input.title,
    intent: input.intent ?? "",
    category_hint: input.categoryHint ?? "unknown",
    status: input.status,
    files: input.files,
    symbols: input.symbols,
    diff_stats: input.hints.diffStats,
    formatting_only: input.hints.formattingOnly,
    lockfile_only: input.hints.lockfileOnly,
    destructive_commands: input.hints.destructiveCommands,
    security_paths: input.hints.securityPaths,
    schema_paths: input.hints.schemaPaths,
    public_exports: input.hints.publicExports,
    behavior_change: input.hints.behaviorChange,
    interfaces_changed: input.hints.interfacesChanged,
    dependency_changes: input.hints.dependencyChanges,
    test_outcomes: input.hints.testResults,
    decision_presence: input.hints.decisionIds.length > 0,
    decision_ids: input.hints.decisionIds,
  };
}

export interface ComposedRequest {
  state: {
    system_policy: string;
    task_prompt: string;
    units: UnitModelState[];
  };
  questions: Record<string, TypeSafeQuestion>;
}

export function composeAttentionRequest(batch: AttentionInput[]): ComposedRequest {
  const state: ComposedRequest["state"] = {
    system_policy: PROMPT_POLICY,
    task_prompt: batch[0]?.taskPrompt ?? "",
    units: batch.map((input) => unitModelState(input)),
  };
  const questions: Record<string, TypeSafeQuestion> = {};
  batch.forEach((_input, index) => {
    Object.assign(questions, passAQuestions(`u${index}`));
  });
  return { state, questions };
}

export function composeProjectionRequest(
  input: AttentionInput,
): ComposedRequest {
  return {
    state: {
      system_policy: PROMPT_POLICY,
      task_prompt: input.taskPrompt,
      units: [unitModelState(input)],
    },
    questions: passBQuestions(),
  };
}
