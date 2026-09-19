import {
  CATALOG_ACTION_NAMES,
  CATALOG_COMPONENT_NAMES,
  type ActionRef,
  type CatalogComponentName,
  type ChangeUnit,
  type DecisionOption,
  type JsonRenderElement,
  type JsonRenderSpec,
  type UIIntent,
} from "@jevcode/contracts";

import type {
  ArchitectureData,
  ChangeUnitPayload,
  CompilePayload,
  DecisionPayload,
  DependencyDeltaData,
  FailureData,
  FailurePayload,
  MatrixData,
  OverviewData,
  SchemaDeltaData,
  TimelineData,
  ValidationPayload,
} from "./payload.js";

export const ROOT_ELEMENT_ID = "root";

const MAX_GRAPH_ITEMS = 50;
const MAX_OPTION_TRADEOFFS = 2;

const CATALOG_ACTION_NAME_SET = new Set<string>(CATALOG_ACTION_NAMES);
const CATALOG_COMPONENT_NAME_SET = new Set<string>(CATALOG_COMPONENT_NAMES);

const COMPONENT_ELEMENT_IDS: Record<CatalogComponentName, string> = {
  ChangeOverview: "overview",
  BehaviorDelta: "behavior-delta",
  ArchitectureDelta: "architecture-delta",
  SchemaDelta: "schema-delta",
  CodeDiff: "diff",
  Decision: "decision",
  TestMatrix: "test-matrix",
  FailureAnalysis: "failure-analysis",
  ExecutionTimeline: "execution-timeline",
  Terminal: "terminal",
  DependencyDelta: "dependency-delta",
};

interface ChildElement {
  id: string;
  element: JsonRenderElement;
}

export function compileUI(
  intent: UIIntent,
  payload: CompilePayload,
): JsonRenderSpec {
  assertKnownSecondaryViews(intent.secondaryViews);
  const { element, children } = compileRoot(intent, payload);
  const elements: Record<string, JsonRenderElement> = {};
  elements[ROOT_ELEMENT_ID] = {
    ...element,
    children: children.map((c) => c.id),
  };
  for (const child of children) {
    elements[child.id] = child.element;
  }
  return { root: ROOT_ELEMENT_ID, elements };
}

function compileRoot(
  intent: UIIntent,
  payload: CompilePayload,
): { element: JsonRenderElement; children: ChildElement[] } {
  switch (intent.representation) {
    case "summary": {
      const p = requireChangeUnit(payload);
      return {
        element: element("ChangeOverview", overviewProps(p.unit, p.confidence, p.overview), []),
        children: changeUnitChildren(intent, p),
      };
    }
    case "before_after": {
      const p = requireChangeUnit(payload);
      assertData(p.behavior, "behavior", "before_after");
      return {
        element: element("BehaviorDelta", behaviorProps(p, p.actions), []),
        children: changeUnitChildren(intent, p),
      };
    }
    case "diff": {
      const p = requireChangeUnit(payload);
      assertData(p.diff, "diff", "diff");
      return {
        element: element("CodeDiff", { file: p.diff.file, diff: p.diff.diff }, []),
        children: changeUnitChildren(intent, p),
      };
    }
    case "diagram": {
      const p = requireChangeUnit(payload);
      assertData(p.architecture, "architecture", "diagram");
      return {
        element: element(
          "ArchitectureDelta",
          architectureProps(p.unit, p.confidence, p.architecture, p.actions),
          [],
        ),
        children: changeUnitChildren(intent, p),
      };
    }
    case "table": {
      if (payload.kind === "validation") {
        const p = payload;
        assertKnownActions(p.actions);
        return {
          element: element("TestMatrix", matrixProps(p.matrix, p.actions), []),
          children: validationChildren(intent, p),
        };
      }
      const p = requireChangeUnit(payload);
      if (intent.subject === "schema") {
        assertData(p.schema, "schema", "table/schema");
        return {
          element: element("SchemaDelta", schemaDeltaProps(p.schema, p.actions), []),
          children: changeUnitChildren(intent, p),
        };
      }
      assertData(p.matrix, "matrix", "table");
      return {
        element: element("TestMatrix", matrixProps(p.matrix, p.actions), []),
        children: changeUnitChildren(intent, p),
      };
    }
    case "graph": {
      const p = requireChangeUnit(payload);
      assertData(p.dependencies, "dependencies", "graph");
      return {
        element: element(
          "DependencyDelta",
          dependencyDeltaProps(p.dependencies, p.actions),
          [],
        ),
        children: changeUnitChildren(intent, p),
      };
    }
    case "decision": {
      const p = requireDecision(payload);
      return {
        element: element("Decision", decisionProps(p), []),
        children: decisionChildren(intent, p),
      };
    }
    case "failure": {
      const p = requireFailure(payload);
      return {
        element: element("FailureAnalysis", failureProps(p.failure, p.actions), []),
        children: failureChildren(intent, p),
      };
    }
    case "timeline": {
      const timeline = timelineFromPayload(payload);
      return {
        element: element("ExecutionTimeline", timelineProps(timeline), []),
        children: [],
      };
    }
  }
}

function changeUnitChildren(
  intent: UIIntent,
  p: ChangeUnitPayload,
): ChildElement[] {
  const children: ChildElement[] = [];
  const seen = new Set<string>();
  for (const view of intent.secondaryViews) {
    const child = changeUnitChildElement(view, p);
    if (child !== undefined && !seen.has(child.id)) {
      seen.add(child.id);
      children.push(child);
    }
  }
  return children;
}

function changeUnitChildElement(
  view: string,
  p: ChangeUnitPayload,
): ChildElement | undefined {
  switch (view) {
    case "ChangeOverview":
      return {
        id: COMPONENT_ELEMENT_IDS.ChangeOverview,
        element: element(
          "ChangeOverview",
          overviewProps(p.unit, p.confidence, p.overview),
          [],
        ),
      };
    case "CodeDiff":
      if (p.diff === undefined) return undefined;
      return {
        id: COMPONENT_ELEMENT_IDS.CodeDiff,
        element: element(
          "CodeDiff",
          { file: p.diff.file, diff: p.diff.diff },
          [],
        ),
      };
    case "TestMatrix":
      if (p.matrix === undefined) return undefined;
      return {
        id: COMPONENT_ELEMENT_IDS.TestMatrix,
        element: element("TestMatrix", matrixProps(p.matrix, undefined), []),
      };
    case "FailureAnalysis":
      if (p.failure === undefined) return undefined;
      return {
        id: COMPONENT_ELEMENT_IDS.FailureAnalysis,
        element: element("FailureAnalysis", failureProps(p.failure, undefined), []),
      };
    case "SchemaDelta":
      if (p.schema === undefined) return undefined;
      return {
        id: COMPONENT_ELEMENT_IDS.SchemaDelta,
        element: element("SchemaDelta", schemaDeltaProps(p.schema, undefined), []),
      };
    case "DependencyDelta":
      if (p.dependencies === undefined) return undefined;
      return {
        id: COMPONENT_ELEMENT_IDS.DependencyDelta,
        element: element(
          "DependencyDelta",
          dependencyDeltaProps(p.dependencies, undefined),
          [],
        ),
      };
    case "ArchitectureDelta":
      if (p.architecture === undefined) return undefined;
      return {
        id: COMPONENT_ELEMENT_IDS.ArchitectureDelta,
        element: element(
          "ArchitectureDelta",
          architectureProps(p.unit, p.confidence, p.architecture, undefined),
          [],
        ),
      };
    case "ExecutionTimeline":
      if (p.timeline === undefined) return undefined;
      return {
        id: COMPONENT_ELEMENT_IDS.ExecutionTimeline,
        element: element("ExecutionTimeline", timelineProps(p.timeline), []),
      };
    case "BehaviorDelta":
      if (p.behavior === undefined) return undefined;
      return {
        id: COMPONENT_ELEMENT_IDS.BehaviorDelta,
        element: element("BehaviorDelta", behaviorProps(p, undefined), []),
      };
    case "Decision":
    case "Terminal":
      return undefined;
    default:
      return undefined;
  }
}

function decisionChildren(
  intent: UIIntent,
  p: DecisionPayload,
): ChildElement[] {
  const children: ChildElement[] = [];
  if (p.relatedUnit !== undefined) {
    children.push({
      id: COMPONENT_ELEMENT_IDS.ChangeOverview,
      element: element(
        "ChangeOverview",
        overviewProps(
          p.relatedUnit.unit,
          p.relatedUnit.confidence,
          p.relatedUnit.overview,
        ),
        [],
      ),
    });
  }
  for (const view of intent.secondaryViews) {
    if (view === "ChangeOverview") {
      continue;
    }
    void view;
  }
  return children;
}

function validationChildren(
  intent: UIIntent,
  p: ValidationPayload,
): ChildElement[] {
  const children: ChildElement[] = [];
  for (const view of intent.secondaryViews) {
    if (view === "ChangeOverview" && p.overview !== undefined) {
      children.push({
        id: COMPONENT_ELEMENT_IDS.ChangeOverview,
        element: element("ChangeOverview", validationOverviewProps(p.overview), []),
      });
    }
    if (view === "ExecutionTimeline" && p.timeline !== undefined) {
      children.push({
        id: COMPONENT_ELEMENT_IDS.ExecutionTimeline,
        element: element("ExecutionTimeline", timelineProps(p.timeline), []),
      });
    }
  }
  return children;
}

function failureChildren(intent: UIIntent, p: FailurePayload): ChildElement[] {
  const children: ChildElement[] = [];
  for (const view of intent.secondaryViews) {
    if (view === "TestMatrix" && p.matrix !== undefined) {
      children.push({
        id: COMPONENT_ELEMENT_IDS.TestMatrix,
        element: element("TestMatrix", matrixProps(p.matrix, undefined), []),
      });
    }
    if (view === "CodeDiff" && p.diff !== undefined) {
      children.push({
        id: COMPONENT_ELEMENT_IDS.CodeDiff,
        element: element("CodeDiff", { file: p.diff.file, diff: p.diff.diff }, []),
      });
    }
  }
  return children;
}

function element(
  type: CatalogComponentName,
  props: Record<string, unknown>,
  children: string[],
): JsonRenderElement {
  return { type, props, children };
}

function overviewProps(
  unit: ChangeUnit,
  confidence: number | undefined,
  overview: OverviewData | undefined,
): Record<string, unknown> {
  const props: Record<string, unknown> = {
    title: overview?.title ?? unit.title,
    category: unit.category,
    status: unit.status,
  };
  if (confidence !== undefined) {
    props.confidence = confidence;
  }
  if (unit.blastRadius?.scope !== undefined) {
    props.scope = unit.blastRadius.scope;
  }
  if (overview?.evidenceLinks !== undefined) {
    props.evidenceLinks = overview.evidenceLinks;
  }
  if (overview?.diffs !== undefined) {
    props.diffs = overview.diffs;
  }
  return props;
}

function behaviorProps(
  p: ChangeUnitPayload,
  actions: ActionRef[] | undefined,
): Record<string, unknown> {
  const behavior = p.behavior;
  if (behavior === undefined) {
    throw new Error("compileUI: BehaviorDelta requires behavior data");
  }
  const props: Record<string, unknown> = {
    title: p.unit.title,
    subject: behavior.subject,
    before: behavior.before,
    after: behavior.after,
    symbols: p.unit.symbols.map((s) => s.name),
    files: p.unit.files,
  };
  if (actions !== undefined) {
    props.actions = cloneActions(actions);
  }
  return props;
}

function architectureProps(
  unit: ChangeUnit,
  confidence: number | undefined,
  architecture: ArchitectureData,
  actions: ActionRef[] | undefined,
): Record<string, unknown> {
  const props: Record<string, unknown> = {
    title: unit.title,
    category: unit.category,
    status: unit.status,
  };
  if (confidence !== undefined) {
    props.confidence = confidence;
  }
  if (architecture.scope !== undefined) {
    props.scope = architecture.scope;
  }
  if (architecture.evidenceCount !== undefined) {
    props.evidenceCount = architecture.evidenceCount;
  }
  props.nodes = architecture.nodes.slice(0, MAX_GRAPH_ITEMS);
  props.edges = architecture.edges.slice(0, MAX_GRAPH_ITEMS);
  if (actions !== undefined) {
    props.actions = cloneActions(actions);
  }
  return props;
}

function schemaDeltaProps(
  schema: SchemaDeltaData,
  actions: ActionRef[] | undefined,
): Record<string, unknown> {
  const props: Record<string, unknown> = {
    title: schema.title,
    migration: schema.migration,
    changes: schema.changes,
  };
  if (schema.compatibilityNote !== undefined) {
    props.compatibilityNote = schema.compatibilityNote;
  }
  if (actions !== undefined) {
    props.actions = cloneActions(actions);
  }
  return props;
}

function dependencyDeltaProps(
  dependencies: DependencyDeltaData,
  actions: ActionRef[] | undefined,
): Record<string, unknown> {
  const props: Record<string, unknown> = {
    title: dependencies.title,
    added: dependencies.added,
    removed: dependencies.removed,
  };
  if (actions !== undefined) {
    props.actions = cloneActions(actions);
  }
  return props;
}

function matrixProps(
  matrix: MatrixData,
  actions: ActionRef[] | undefined,
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (matrix.title !== undefined) {
    props.title = matrix.title;
  }
  if (matrix.summary !== undefined) {
    props.summary = matrix.summary;
  }
  props.rows = matrix.rows;
  if (actions !== undefined) {
    props.actions = cloneActions(actions);
  }
  return props;
}

function failureProps(
  failure: FailureData,
  actions: ActionRef[] | undefined,
): Record<string, unknown> {
  const props: Record<string, unknown> = {
    title: failure.title,
    command: failure.command,
    runner: failure.runner,
    exitCode: failure.exitCode,
    failures: failure.failures,
    linkedChangeUnits: failure.linkedChangeUnits,
  };
  if (failure.note !== undefined) {
    props.note = failure.note;
  }
  if (actions !== undefined) {
    props.actions = cloneActions(actions);
  }
  return props;
}

function timelineProps(timeline: TimelineData): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (timeline.title !== undefined) {
    props.title = timeline.title;
  }
  props.events = timeline.events;
  return props;
}

function decisionProps(p: DecisionPayload): Record<string, unknown> {
  const decision = p.decision;
  // answer_decision params must always validate against
  // AnswerDecisionParamsSchema, which requires `decision`; when the payload
  // carries no suggested answer we still emit an empty record so the
  // compiled ActionRef stays schema-valid.
  const answerParams: Record<string, unknown> = {
    decisionId: decision.id,
    decision: p.suggestedAnswer?.decision ?? {},
  };
  if (p.suggestedAnswer !== undefined) {
    answerParams.evidence = p.suggestedAnswer.evidence ?? decision.evidence;
  }
  const actions: ActionRef[] = [
    {
      action: "answer_decision",
      params: answerParams,
    } as unknown as ActionRef,
    {
      action: "delegate_decision",
      params: { decisionId: decision.id },
    } as ActionRef,
  ];
  return {
    decisionId: decision.id,
    title: decision.title,
    severity: decision.severity,
    context: decision.context,
    options: decision.options.map(boundOption),
    actions,
  };
}

function boundOption(option: DecisionOption): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: option.id,
    label: option.label,
    description: option.description,
  };
  if (option.tradeoffs !== undefined && option.tradeoffs.length > 0) {
    out.tradeoffs = option.tradeoffs.slice(0, MAX_OPTION_TRADEOFFS);
  }
  return out;
}

function validationOverviewProps(overview: {
  title: string;
  category: ChangeUnit["category"];
  status: ChangeUnit["status"];
  confidence?: number;
  evidenceLinks?: string[];
}): Record<string, unknown> {
  const props: Record<string, unknown> = {
    title: overview.title,
    category: overview.category,
    status: overview.status,
  };
  if (overview.confidence !== undefined) {
    props.confidence = overview.confidence;
  }
  if (overview.evidenceLinks !== undefined) {
    props.evidenceLinks = overview.evidenceLinks;
  }
  return props;
}

function timelineFromPayload(payload: CompilePayload): TimelineData {
  if (payload.kind === "timeline") {
    return { title: payload.title, events: payload.events };
  }
  if (payload.kind === "changeUnit") {
    assertData(payload.timeline, "timeline", "timeline");
    return payload.timeline;
  }
  throw new Error(
    `compileUI: representation "timeline" requires a timeline payload, got kind "${payload.kind}"`,
  );
}

function cloneActions(actions: ActionRef[]): ActionRef[] {
  return actions.map((a) => ({
    action: a.action,
    params: { ...a.params },
  })) as ActionRef[];
}

function requireChangeUnit(payload: CompilePayload): ChangeUnitPayload {
  if (payload.kind !== "changeUnit") {
    throw new Error(
      `compileUI: expected a changeUnit payload, got kind "${payload.kind}"`,
    );
  }
  assertKnownActions(payload.actions);
  return payload;
}

function requireDecision(payload: CompilePayload): DecisionPayload {
  if (payload.kind !== "decision") {
    throw new Error(
      `compileUI: expected a decision payload, got kind "${payload.kind}"`,
    );
  }
  return payload;
}

function requireFailure(payload: CompilePayload): FailurePayload {
  if (payload.kind !== "failure") {
    throw new Error(
      `compileUI: expected a failure payload, got kind "${payload.kind}"`,
    );
  }
  assertKnownActions(payload.actions);
  return payload;
}

function assertData<T>(
  value: T | undefined,
  name: string,
  representation: string,
): asserts value is T {
  if (value === undefined) {
    throw new Error(
      `compileUI: representation "${representation}" requires ${name} data`,
    );
  }
}

function assertKnownActions(actions: ActionRef[] | undefined): void {
  if (actions === undefined) {
    return;
  }
  for (const ref of actions) {
    if (!CATALOG_ACTION_NAME_SET.has(ref.action)) {
      throw new Error(
        `compileUI: unknown action "${ref.action}" is not in the catalog allowlist`,
      );
    }
  }
}

function assertKnownSecondaryViews(secondaryViews: string[]): void {
  for (const view of secondaryViews) {
    if (!CATALOG_COMPONENT_NAME_SET.has(view)) {
      throw new Error(
        `compileUI: unknown secondary view component "${view}" is not in the catalog`,
      );
    }
  }
}
