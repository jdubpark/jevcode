import { readFileSync } from "node:fs";
import path from "node:path";

import {
  AttentionDecisionSchema,
  ChangeCategorySchema,
  DecisionSchema,
  EvidenceFactSchema,
  NormalizedAgentEventSchema,
  SemanticEventSchema,
  UIIntentSchema,
  type AttentionDecision,
  type ChangeCategory,
  type Decision,
  type EvidenceFact,
  type NormalizedAgentEvent,
  type SemanticEvent,
  type UIIntent,
} from "@jevcode/contracts";
import {
  collectAttentionHints,
  type AttentionInput,
  type EvidenceHints,
} from "@jevcode/jev-router";

export const SCENARIOS = [
  "oauth",
  "rate-limit",
  "schema-change",
  "api-break",
  "dep-change",
] as const;

export type ScenarioName = (typeof SCENARIOS)[number];

interface SafeParseSchema<T> {
  safeParse(input: unknown): {
    success: boolean;
    data?: T;
    error?: { message: string };
  };
}

function parseLabelMap<T>(
  raw: unknown,
  schema: SafeParseSchema<T>,
  label: string,
): Record<string, T> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${label} must be a JSON object keyed by unit slug`);
  }
  const out: Record<string, T> = {};
  for (const [slug, value] of Object.entries(raw)) {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new Error(`invalid ${label} entry "${slug}": ${result.error?.message}`);
    }
    out[slug] = result.data as T;
  }
  return out;
}

export interface ExpectedUnit {
  id: string;
  title: string;
  category: ChangeCategory;
  files: string[];
  symbolNames: string[];
}

function parseExpectedUnits(raw: unknown): ExpectedUnit[] {
  if (!Array.isArray(raw)) {
    throw new Error("expected_units.json must be an array");
  }
  return raw.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`expected unit at index ${index} must be an object`);
    }
    const record = item as Record<string, unknown>;
    const id = record["id"];
    const title = record["title"];
    const files = record["files"];
    const symbolNames = record["symbolNames"];
    const categoryResult = ChangeCategorySchema.safeParse(record["category"]);
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`expected unit ${index}: missing id`);
    }
    if (typeof title !== "string") {
      throw new Error(`expected unit ${index} (${id}): missing title`);
    }
    if (!categoryResult.success) {
      throw new Error(
        `expected unit ${index} (${id}): invalid category: ${categoryResult.error.message}`,
      );
    }
    if (
      !Array.isArray(files) ||
      files.some((file) => typeof file !== "string" || file.length === 0)
    ) {
      throw new Error(`expected unit ${index} (${id}): files must be strings`);
    }
    if (
      !Array.isArray(symbolNames) ||
      symbolNames.some((name) => typeof name !== "string")
    ) {
      throw new Error(`expected unit ${index} (${id}): symbolNames must be strings`);
    }
    return {
      id,
      title,
      category: categoryResult.data,
      files: [...(files as string[])],
      symbolNames: [...(symbolNames as string[])],
    };
  });
}

export interface ParsedStream {
  agentEvents: NormalizedAgentEvent[];
  facts: EvidenceFact[];
  semanticEvents: SemanticEvent[];
  decisions: Decision[];
}

export function parseEventsJsonl(text: string): ParsedStream {
  const parsed: ParsedStream = {
    agentEvents: [],
    facts: [],
    semanticEvents: [],
    decisions: [],
  };
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  lines.forEach((line, index) => {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`invalid JSON in events.jsonl line ${index + 1}`);
    }
    const fact = EvidenceFactSchema.safeParse(raw);
    if (fact.success) {
      parsed.facts.push(fact.data);
      return;
    }
    const agentEvent = NormalizedAgentEventSchema.safeParse(raw);
    if (agentEvent.success) {
      parsed.agentEvents.push(agentEvent.data);
      return;
    }
    const semanticEvent = SemanticEventSchema.safeParse(raw);
    if (semanticEvent.success) {
      parsed.semanticEvents.push(semanticEvent.data);
      return;
    }
    const decision = DecisionSchema.safeParse(raw);
    if (decision.success) {
      parsed.decisions.push(decision.data);
      return;
    }
    throw new Error(
      `events.jsonl line ${index + 1} matches no known record schema`,
    );
  });
  return parsed;
}

export interface ScenarioData {
  name: ScenarioName;
  dir: string;
  stream: ParsedStream;
  expectedUnits: ExpectedUnit[];
  attentionLabels: Record<string, AttentionDecision>;
  projectionLabels: Record<string, UIIntent>;
}

export function loadScenario(scenarioDir: string, name: ScenarioName): ScenarioData {
  const stream = parseEventsJsonl(
    readFileSync(path.join(scenarioDir, "events.jsonl"), "utf8"),
  );
  const expectedUnits = parseExpectedUnits(
    JSON.parse(
      readFileSync(path.join(scenarioDir, "expected_units.json"), "utf8"),
    ),
  );
  const attentionLabels = parseLabelMap(
    JSON.parse(
      readFileSync(path.join(scenarioDir, "labels", "attention.json"), "utf8"),
    ),
    AttentionDecisionSchema,
    "attention label",
  );
  const projectionLabels = parseLabelMap(
    JSON.parse(
      readFileSync(path.join(scenarioDir, "labels", "projection.json"), "utf8"),
    ),
    UIIntentSchema,
    "projection label",
  );

  const unitIds = new Set(expectedUnits.map((unit) => unit.id));
  for (const slug of Object.keys(attentionLabels)) {
    if (!unitIds.has(slug)) {
      throw new Error(
        `scenario ${name}: attention label "${slug}" has no expected unit`,
      );
    }
  }
  for (const unit of expectedUnits) {
    if (attentionLabels[unit.id] === undefined) {
      throw new Error(
        `scenario ${name}: unit "${unit.id}" has no attention label`,
      );
    }
  }
  for (const slug of Object.keys(projectionLabels)) {
    if (attentionLabels[slug] === undefined) {
      throw new Error(
        `scenario ${name}: projection label "${slug}" has no attention label`,
      );
    }
    if (attentionLabels[slug]?.shouldSurface !== true) {
      throw new Error(
        `scenario ${name}: projection label "${slug}" belongs to a suppressed unit`,
      );
    }
  }

  return {
    name,
    dir: scenarioDir,
    stream,
    expectedUnits,
    attentionLabels,
    projectionLabels,
  };
}

function sameFileSet(a: readonly string[], b: readonly string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const file of setA) {
    if (!setB.has(file)) return false;
  }
  return true;
}

function interfacesChangedFor(
  unit: ExpectedUnit,
  facts: readonly EvidenceFact[],
): number {
  let count = 0;
  for (const fact of facts) {
    if (fact.type !== "symbol_delta" || !unit.files.includes(fact.path)) {
      continue;
    }
    const all = [...fact.added, ...fact.modified, ...fact.removed];
    for (const symbol of all) {
      if (symbol.kind === "interface" || symbol.kind === "export") {
        count += 1;
      }
    }
  }
  return count;
}

function behaviorChangeFor(
  unit: ExpectedUnit,
  semanticEvents: readonly SemanticEvent[],
): boolean {
  return semanticEvents.some(
    (event) =>
      event.kind === "behavior_change" &&
      event.files.some((file) => unit.files.includes(file)),
  );
}

function decisionIdsFor(
  unit: ExpectedUnit,
  semanticEvents: readonly SemanticEvent[],
  decisions: readonly Decision[],
): string[] {
  const relatedEventIds = semanticEvents
    .filter((event) => sameFileSet(event.files, unit.files))
    .map((event) => event.id);
  return [
    ...new Set(
      decisions
        .filter(
          (decision) =>
            decision.affectedChangeUnits.includes(unit.id) ||
            decision.evidence.some((id) => relatedEventIds.includes(id)),
        )
        .map((decision) => decision.id),
    ),
  ];
}

function statusFor(
  unit: ExpectedUnit,
  facts: readonly EvidenceFact[],
): "detected" | "failed" {
  const failedResults = facts.filter(
    (fact): fact is Extract<EvidenceFact, { type: "test_result" }> =>
      fact.type === "test_result" && fact.failed > 0,
  );
  const hasFailureInUnit = failedResults.some((result) =>
    result.failures.some((failure) => unit.files.includes(failure.file)),
  );
  return hasFailureInUnit ? "failed" : "detected";
}

export function buildAttentionInputs(data: ScenarioData): AttentionInput[] {
  const { stream, expectedUnits } = data;
  const sessionId =
    stream.agentEvents.find((event) => event.type === "agent_started")
      ?.sessionId ?? stream.facts[0]?.sessionId ?? "sess-unknown";
  const taskPrompt =
    stream.agentEvents.find((event) => event.type === "agent_started") &&
    (stream.agentEvents.find((event) => event.type === "agent_started") as {
      prompt: string;
    }).prompt;
  const sessionStartTs =
    stream.agentEvents.find((event) => event.type === "agent_started")?.ts ??
    stream.facts[0]?.ts ??
    "1970-01-01T00:00:00.000Z";

  return expectedUnits.map((unit) => {
    const hints: EvidenceHints = {
      ...collectAttentionHints(unit.files, stream.facts),
      behaviorChange: behaviorChangeFor(unit, stream.semanticEvents),
      interfacesChanged: interfacesChangedFor(unit, stream.facts),
      decisionIds: decisionIdsFor(
        unit,
        stream.semanticEvents,
        stream.decisions,
      ),
      autoCollapsePassingTests: false,
    };
    const firstUnitFact = stream.facts.find((fact) => {
      if (fact.type === "git_hunk") return unit.files.includes(fact.file);
      if (fact.type === "symbol_delta") return unit.files.includes(fact.path);
      if (fact.type === "file_changed") return unit.files.includes(fact.path);
      if (fact.type === "dependency_change") {
        return unit.files.includes(fact.manifest);
      }
      return false;
    });
    return {
      changeUnitId: unit.id,
      decisionVersion: 1,
      sessionId,
      title: unit.title,
      categoryHint: unit.category,
      status: statusFor(unit, stream.facts),
      files: unit.files,
      symbols: unit.symbolNames,
      taskPrompt: taskPrompt ?? "",
      hints,
      createdAt: firstUnitFact?.ts ?? sessionStartTs,
    };
  });
}
