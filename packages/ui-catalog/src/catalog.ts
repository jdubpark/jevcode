import { defineCatalog, defineSchema } from "@json-render/core";
import { z as z4 } from "zod";

import {
  ArchitectureDeltaPropsSchema,
  BehaviorDeltaPropsSchema,
  ChangeOverviewPropsSchema,
  CodeDiffPropsSchema,
  DecisionPropsSchema,
  DependencyDeltaPropsSchema,
  ExecutionTimelinePropsSchema,
  FailureAnalysisPropsSchema,
  SchemaDeltaPropsSchema,
  TerminalPropsSchema,
  TestMatrixPropsSchema,
  actionParamSchemas,
} from "@jevcode/contracts";

const schema = defineSchema((s) => ({
  spec: s.object({
    root: s.string(),
    elements: s.map({
      type: s.ref("catalog.components"),
      props: s.propsOf("catalog.components"),
      children: s.array(s.string()),
    }),
  }),
  catalog: s.object({
    components: s.map({
      props: s.zod(),
      description: s.string(),
    }),
    actions: s.map({
      description: s.string(),
      params: s.zod(),
    }),
  }),
}));

function asParams(schema: unknown): z4.ZodType {
  return schema as z4.ZodType;
}

export const jevcodeCatalog = defineCatalog(schema, {
  components: {
    ChangeOverview: {
      props: asParams(ChangeOverviewPropsSchema),
      description:
        "One semantic change: title, category, status, scope, confidence, drilldown",
    },
    BehaviorDelta: {
      props: asParams(BehaviorDeltaPropsSchema),
      description: "Before/after behavior of a public behavior change",
    },
    ArchitectureDelta: {
      props: asParams(ArchitectureDeltaPropsSchema),
      description: "Node/edge graph of module/service/flow changes",
    },
    SchemaDelta: {
      props: asParams(SchemaDeltaPropsSchema),
      description: "Table/type/model additions, removals, column/field changes",
    },
    CodeDiff: {
      props: asParams(CodeDiffPropsSchema),
      description: "Raw unified diff for one or more files",
    },
    Decision: {
      props: asParams(DecisionPropsSchema),
      description: "Human decision with options and structured answer actions",
    },
    TestMatrix: {
      props: asParams(TestMatrixPropsSchema),
      description: "Validation status rows: tests, typecheck, lint, build",
    },
    FailureAnalysis: {
      props: asParams(FailureAnalysisPropsSchema),
      description: "Failed test/build with linked change units and next actions",
    },
    ExecutionTimeline: {
      props: asParams(ExecutionTimelinePropsSchema),
      description: "Meaningful milestones, not every command",
    },
    Terminal: {
      props: asParams(TerminalPropsSchema),
      description: "PTY output with scrollback",
    },
    DependencyDelta: {
      props: asParams(DependencyDeltaPropsSchema),
      description: "Added/removed packages with reason and usage",
    },
  },
  actions: {
    answer_decision: {
      description: "Submit structured decision answer",
      params: asParams(actionParamSchemas.answer_decision),
    },
    delegate_decision: {
      description: "Let the agent choose and continue",
      params: asParams(actionParamSchemas.delegate_decision),
    },
    restore_previous_api_semantics: {
      description: "Instruct agent to restore previous API behavior",
      params: asParams(actionParamSchemas.restore_previous_api_semantics),
    },
    inspect_call_sites: {
      description: "Show call sites of a symbol",
      params: asParams(actionParamSchemas.inspect_call_sites),
    },
    show_exact_diff: {
      description: "Open raw diff for the change",
      params: asParams(actionParamSchemas.show_exact_diff),
    },
    accept_changes: {
      description: "Mark semantic review as accepted",
      params: asParams(actionParamSchemas.accept_changes),
    },
    request_changes: {
      description: "Send structured review feedback to the agent",
      params: asParams(actionParamSchemas.request_changes),
    },
    continue_task: {
      description: "Resume the agent",
      params: asParams(actionParamSchemas.continue_task),
    },
    open_terminal: {
      description: "Open terminal panel",
      params: asParams(actionParamSchemas.open_terminal),
    },
    interrupt_agent: {
      description: "Pause the agent",
      params: asParams(actionParamSchemas.interrupt_agent),
    },
    pin_surface: {
      description: "Pin surface against auto-replacement",
      params: asParams(actionParamSchemas.pin_surface),
    },
    dismiss_surface: {
      description: "Dismiss surface and log telemetry",
      params: asParams(actionParamSchemas.dismiss_surface),
    },
  },
});

export type JevcodeCatalog = typeof jevcodeCatalog;
