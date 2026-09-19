import { createHash } from "node:crypto";

import type {
  ActionRef,
  ArchitectureEdge,
  ArchitectureNode,
  ChangeUnit,
  Decision,
  DependencyDeltaItem,
  EvidenceFact,
  JsonRenderElement,
  JsonRenderSpec,
  JsonRenderSpecPatch,
  MatrixRow,
  NormalizedAgentEvent,
  SemanticEvent,
  TimelineEvent,
  UIIntent,
  ValidationResult,
} from "@jevcode/contracts";
import { compileUI } from "@jevcode/ui-compiler";
import type { CompilePayload, FailureData, TimelineData } from "@jevcode/ui-compiler";
import type {
  FailureRecord,
  GraphEdge,
  GraphNode,
} from "@jevcode/semantic-core";

export interface UiStageContext {
  sessionId: string;
  facts: readonly EvidenceFact[];
  validations: readonly ValidationResult[];
  failures: readonly FailureRecord[];
  decisions: readonly Decision[];
  semanticEvents: readonly SemanticEvent[];
  graphNodes: readonly GraphNode[];
  graphEdges: readonly GraphEdge[];
  agentEvents: readonly NormalizedAgentEvent[];
  units: readonly ChangeUnit[];
}

export function surfaceIdForUnit(unitId: string): string {
  return `changeunit:${unitId}`;
}

export function surfaceIdForDecision(decisionId: string): string {
  return `decision:${decisionId}`;
}

export function surfaceIdForValidation(ts: string): string {
  return `validation:${ts}`;
}

export function surfaceIdForDiff(files: readonly string[]): string {
  // Hash the file list itself: two requests with different files (even of
  // equal length) must produce distinct surface ids.
  const hash = createHash("sha1")
    .update(JSON.stringify(files))
    .digest("hex")
    .slice(0, 16);
  return `diff:${hash}`;
}

export const TERMINAL_SURFACE_ID = "terminal";
export const TIMELINE_SURFACE_ID = "timeline";
export const COMPLETION_SURFACE_ID = "completion";

export function specHash(spec: JsonRenderSpec): string {
  return createHash("sha1").update(JSON.stringify(spec)).digest("hex").slice(0, 16);
}

export function diffSpecs(
  previous: JsonRenderSpec,
  next: JsonRenderSpec,
): { patch: JsonRenderSpecPatch; full: JsonRenderSpec } | null {
  const prevRoot = previous.elements[previous.root];
  const nextRoot = next.elements[next.root];
  if (prevRoot === undefined || nextRoot === undefined) {
    return null;
  }
  if (prevRoot.type !== nextRoot.type || previous.root !== next.root) {
    return null;
  }
  const elements: JsonRenderSpecPatch["elements"] = {};
  for (const [id, element] of Object.entries(next.elements)) {
    const previousElement = previous.elements[id];
    if (
      previousElement === undefined ||
      JSON.stringify(previousElement) !== JSON.stringify(element)
    ) {
      elements[id] = element;
    }
  }
  if (Object.keys(elements).length === 0) {
    return null;
  }
  return {
    patch: { root: next.root, elements },
    full: next,
  };
}

export function compileChangeUnitSurface(
  unit: ChangeUnit,
  intent: UIIntent,
  ctx: UiStageContext,
): JsonRenderSpec {
  if (intent.representation === "diff") {
    const summaryIntent: UIIntent = { ...intent, representation: "summary" };
    return compileUI(summaryIntent, buildChangeUnitPayload(unit, summaryIntent, ctx));
  }
  if (intent.representation === "failure") {
    const linkedFailures = ctx.failures.filter((failure) =>
      unit.files.includes(failure.file),
    );
    if (linkedFailures.length === 0) {
      const summaryIntent: UIIntent = { ...intent, representation: "summary" };
      return compileUI(summaryIntent, buildChangeUnitPayload(unit, summaryIntent, ctx));
    }
    const payload: CompilePayload = {
      kind: "failure",
      failure: buildFailureData(unit, linkedFailures, ctx),
      matrix: buildMatrixData(ctx, unit),
      actions: [
        { action: "show_exact_diff", params: { files: unit.files.slice(0, 3) } },
        { action: "pin_surface", params: { surfaceId: surfaceIdForUnit(unit.id) } },
        { action: "dismiss_surface", params: { surfaceId: surfaceIdForUnit(unit.id) } },
      ],
    };
    return compileUI(intent, payload);
  }
  const payload = buildChangeUnitPayload(unit, intent, ctx);
  return compileUI(intent, payload);
}

export function compileDecisionSurface(
  decision: Decision,
  ctx: UiStageContext,
): JsonRenderSpec {
  const relatedUnitId = decision.affectedChangeUnits[0];
  const relatedUnit = relatedUnitId !== undefined
    ? ctx.units.find((unit) => unit.id === relatedUnitId)
    : undefined;
  const intent: UIIntent = {
    attention: "interrupt",
    subject: "decision",
    representation: "decision",
    density: "normal",
    confidence: 1,
    showEvidence: true,
    showCode: false,
    secondaryViews: relatedUnit !== undefined ? ["ChangeOverview"] : [],
    renderMode: "autonomous",
  };
  const payload: CompilePayload = {
    kind: "decision",
    decision,
    suggestedAnswer: decision.answer !== undefined
      ? { decision: decision.answer.decision, evidence: decision.answer.evidence }
      : undefined,
    relatedUnit: relatedUnit !== undefined
      ? {
          unit: relatedUnit,
          confidence: 1,
          overview: overviewFor(relatedUnit),
        }
      : undefined,
  };
  return compileUI(intent, payload);
}

export function compileTerminalSurface(): JsonRenderSpec {
  return {
    root: "root",
    elements: {
      root: { type: "Terminal", props: { title: "Terminal" } },
    },
  };
}

const COMPLETION_OVERVIEW_LIMIT = 20;
const COMPLETION_CHANGED_FILES_LIMIT = 3;

export function compileCompletionSurface(ctx: UiStageContext): JsonRenderSpec {
  const elements: Record<string, JsonRenderElement> = {};
  const children: string[] = [];

  for (const [index, unit] of ctx.units.entries()) {
    if (index >= COMPLETION_OVERVIEW_LIMIT) break;
    const id = `unit-${index}`;
    elements[id] = {
      type: "ChangeOverview",
      props: {
        title: unit.title,
        category: unit.category,
        status: unit.status,
        evidenceLinks: unit.evidence.slice(0, 10),
      },
      children: [],
    };
    children.push(id);
  }

  for (const [index, failure] of ctx.failures.entries()) {
    const id = `failure-${index}`;
    const linkedChangeUnits = ctx.units
      .filter((unit) => unit.files.includes(failure.file))
      .map((unit) => unit.id);
    elements[id] = {
      type: "FailureAnalysis",
      props: {
        title: `Failing test: ${failure.testName}`,
        command: "test",
        runner: "vitest",
        exitCode: 1,
        failures: [
          {
            file: failure.file,
            testName: failure.testName,
            message: failure.message,
          },
        ],
        linkedChangeUnits,
      },
      children: [],
    };
    children.push(id);
  }

  for (const [index, decision] of ctx.decisions.entries()) {
    if (decision.status !== "open") continue;
    const id = `decision-${index}`;
    elements[id] = {
      type: "Decision",
      props: {
        decisionId: decision.id,
        title: decision.title,
        severity: decision.severity,
        context: decision.context,
        options: decision.options.map((option) => ({
          id: option.id,
          label: option.label,
          description: option.description,
        })),
      },
      children: [],
    };
    children.push(id);
  }

  const rows: MatrixRow[] = ctx.validations.map((validation) => ({
    name: validation.command,
    status: validation.status,
    passed: validation.passed,
    failed: validation.failed,
    skipped: validation.skipped,
  }));

  const changedFiles = [
    ...new Set(ctx.units.flatMap((unit) => unit.files)),
  ].slice(0, COMPLETION_CHANGED_FILES_LIMIT);
  const openDecisions = ctx.decisions.filter(
    (decision) => decision.status === "open",
  ).length;
  const summary =
    `${ctx.units.length} change unit(s), ` +
    `${ctx.failures.length} failing test(s), ` +
    `${openDecisions} open decision(s)`;

  const actions: ActionRef[] = [
    {
      action: "accept_changes",
      params: {},
    },
    {
      action: "request_changes",
      params: {},
    },
    ...(changedFiles.length > 0
      ? ([
          {
            action: "show_exact_diff",
            params: { files: changedFiles },
          } as ActionRef,
        ] as ActionRef[])
      : []),
  ];

  elements["root"] = {
    type: "TestMatrix",
    props: {
      title: "Completion summary",
      summary,
      rows,
      actions,
    },
    children,
  };

  return { root: "root", elements };
}

export function compileCallsiteSurface(
  symbol: string,
  files: readonly string[],
): JsonRenderSpec {
  return {
    root: "root",
    elements: {
      root: {
        type: "ChangeOverview",
        props: {
          title: `Call sites of ${symbol}`,
          category: "api",
          status: "detected",
          confidence: 1,
          scope: "local",
          evidenceLinks: [...files],
        },
      },
    },
  };
}

export function compileDiffSurface(file: string, diff: string): JsonRenderSpec {
  return {
    root: "root",
    elements: {
      root: {
        type: "CodeDiff",
        props: { file, diff },
      },
    },
  };
}

function overviewFor(unit: ChangeUnit): {
  title: string;
  evidenceLinks?: string[];
} {
  return {
    title: unit.title,
    evidenceLinks: unit.evidence.slice(0, 10),
  };
}

function buildChangeUnitPayload(
  unit: ChangeUnit,
  intent: UIIntent,
  ctx: UiStageContext,
): CompilePayload {
  const linkedFailures = ctx.failures.filter((failure) =>
    unit.files.includes(failure.file),
  );
  const overview = overviewFor(unit);
  const actions: ActionRef[] = [
    { action: "show_exact_diff", params: { files: unit.files.slice(0, 3) } },
    { action: "pin_surface", params: { surfaceId: surfaceIdForUnit(unit.id) } },
    { action: "dismiss_surface", params: { surfaceId: surfaceIdForUnit(unit.id) } },
    ...(unit.interfacesChanged.length > 0
      ? ([
          {
            action: "restore_previous_api_semantics",
            params: { symbol: unit.symbols[0]?.name ?? unit.title },
          },
        ] as ActionRef[])
      : []),
  ];

  return {
    kind: "changeUnit",
    unit,
    confidence: intent.confidence,
    overview: {
      title: overview.title,
      evidenceLinks: overview.evidenceLinks,
    },
    behavior: {
      subject: unit.title,
      before: unit.behaviorBefore ?? "No recorded prior behavior.",
      after: unit.behaviorAfter ?? unit.title,
    },
    architecture: buildArchitectureData(unit, ctx),
    schema:
      intent.subject === "schema" || unit.schemaChanges.length > 0
        ? {
            title: unit.title,
            migration: unit.schemaChanges[0]?.migration ?? "",
            changes: unit.schemaChanges,
          }
        : undefined,
    dependencies: buildDependencyData(unit),
    matrix: buildMatrixData(ctx, unit),
    failure:
      linkedFailures.length > 0
        ? buildFailureData(unit, linkedFailures, ctx)
        : undefined,
    timeline: buildTimelineData(ctx),
    actions,
  };
}

function buildArchitectureData(
  unit: ChangeUnit,
  ctx: UiStageContext,
): { nodes: ArchitectureNode[]; edges: ArchitectureEdge[]; scope?: "local" | "module" | "subsystem" | "repository"; evidenceCount?: number } | undefined {
  const nodes: ArchitectureNode[] = [];
  const ids = new Set<string>();
  const addNode = (node: ArchitectureNode): void => {
    if (ids.has(node.id) || nodes.length >= 50) return;
    ids.add(node.id);
    nodes.push(node);
  };
  for (const file of unit.files) {
    if (file.includes("test") || file.includes("spec")) continue;
    addNode({ id: `file:${file}`, label: file, kind: "module", path: file });
  }
  for (const symbol of unit.symbols) {
    const kind: ArchitectureNode["kind"] =
      symbol.kind === "class" ? "class"
      : symbol.kind === "function" || symbol.kind === "method" ? "function"
      : symbol.kind === "interface" || symbol.kind === "type" ? "type"
      : "config";
    addNode({
      id: `sym:${symbol.id}`,
      label: symbol.name,
      kind,
      path: symbol.path,
    });
  }
  const dependencyFacts = ctx.facts.filter(
    (fact): fact is Extract<EvidenceFact, { type: "dependency_change" }> =>
      fact.type === "dependency_change",
  );
  for (const fact of dependencyFacts) {
    for (const added of fact.added) {
      addNode({ id: `dep:${added.name}`, label: added.name, kind: "external" });
    }
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: ArchitectureEdge[] = [];
  for (const edge of ctx.graphEdges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    if (edges.length >= 50) break;
    edges.push({ from: edge.from, to: edge.to, label: edge.type });
  }
  return {
    nodes,
    edges,
    scope: unit.blastRadius?.scope,
    evidenceCount: unit.evidence.length,
  };
}

function buildDependencyData(unit: ChangeUnit): {
  title: string;
  added: DependencyDeltaItem[];
  removed: DependencyDeltaItem[];
} {
  const added: DependencyDeltaItem[] = [];
  const removed: DependencyDeltaItem[] = [];
  for (const change of unit.dependencyChanges) {
    const item: DependencyDeltaItem = {
      name: change.name,
      version: change.version ?? change.to,
    };
    if (change.change === "added" || change.change === "upgraded") {
      added.push(item);
    } else {
      removed.push(item);
    }
  }
  return {
    title: added.length > 0 ? (added[0]?.name ?? "dependencies") : "dependencies",
    added,
    removed,
  };
}

function buildMatrixData(
  ctx: UiStageContext,
  unit: ChangeUnit,
): { rows: MatrixRow[] } {
  const rows: MatrixRow[] = [];
  for (const validation of ctx.validations) {
    const row: MatrixRow = {
      name: validation.command,
      status: validation.status,
      passed: validation.passed,
      failed: validation.failed,
      skipped: validation.skipped,
    };
    rows.push(row);
  }
  void unit;
  return { rows };
}

function buildFailureData(
  unit: ChangeUnit,
  failures: readonly FailureRecord[],
  ctx: UiStageContext,
): FailureData {
  const validationByFailure = new Map<string, ValidationResult>();
  for (const validation of ctx.validations) {
    validationByFailure.set(validation.id, validation);
  }
  const firstFailure = failures[0];
  const validation = firstFailure !== undefined
    ? validationByFailure.get(firstFailure.validationId)
    : undefined;
  const linkedUnits = new Set<string>();
  for (const failure of failures) {
    for (const candidate of ctx.units) {
      if (candidate.files.includes(failure.file)) {
        linkedUnits.add(candidate.id);
      }
    }
  }
  return {
    title: unit.title,
    command: validation?.command ?? "test",
    runner: "vitest",
    exitCode: validation !== undefined && validation.status === "failed" ? 1 : 0,
    failures: failures.map((failure) => ({
      file: failure.file,
      testName: failure.testName,
      message: failure.message,
    })),
    linkedChangeUnits: [...linkedUnits],
  };
}

function buildTimelineData(ctx: UiStageContext): TimelineData {
  const events: TimelineEvent[] = [];
  const add = (ts: string, label: string, kind: TimelineEvent["kind"]): void => {
    events.push({
      id: `tl-${events.length}-${ts}`,
      ts,
      label,
      kind,
    });
  };
  for (const event of ctx.agentEvents) {
    switch (event.type) {
      case "command_started":
        add(event.ts, event.command, "command");
        break;
      case "command_completed":
        add(event.ts, `${event.command} (exit ${event.exitCode})`, "command");
        break;
      case "test_completed":
        add(event.ts, `${event.command} (exit ${event.exitCode})`, "validation");
        break;
      case "agent_completed":
        add(event.ts, "agent completed", "agent");
        break;
      case "agent_failed":
        add(event.ts, `agent failed: ${event.error}`, "failure");
        break;
      default:
        break;
    }
  }
  return { title: "Execution timeline", events };
}
