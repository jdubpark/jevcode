import { Children, isValidElement } from "react";
import type { ReactNode } from "react";

import { defineRegistry } from "@json-render/react";
import type { Actions, ComponentContext } from "@json-render/react";

import {
  CATALOG_ACTION_NAMES,
  type ArchitectureDeltaProps,
  type BehaviorDeltaProps,
  type ChangeOverviewProps,
  type CodeDiffProps,
  type DecisionProps,
  type DependencyDeltaProps,
  type ExecutionTimelineProps,
  type FailureAnalysisProps,
  type SchemaDeltaProps,
  type TerminalProps,
  type TestMatrixProps,
} from "@jevcode/contracts";

import { dispatchCatalogAction } from "./actions.js";
import { jevcodeCatalog } from "./catalog.js";
import { ArchitectureDelta } from "./components/ArchitectureDelta.js";
import { BehaviorDelta } from "./components/BehaviorDelta.js";
import { ChangeOverview } from "./components/ChangeOverview.js";
import { CodeDiff } from "./components/CodeDiff.js";
import { Decision } from "./components/Decision.js";
import {
  DEPENDENCY_CHILDREN_CONTAINER_ID,
  DependencyDelta,
} from "./components/DependencyDelta.js";
import { ExecutionTimeline } from "./components/ExecutionTimeline.js";
import { FailureAnalysis } from "./components/FailureAnalysis.js";
import { SchemaDelta } from "./components/SchemaDelta.js";
import { Terminal } from "./components/Terminal.js";
import { TestMatrix } from "./components/TestMatrix.js";

type Ctx<K extends keyof typeof jevcodeCatalog.data.components> = ComponentContext<
  typeof jevcodeCatalog,
  K
>;

function childElementTypes(children: ReactNode): string[] {
  const types: string[] = [];
  Children.forEach(children, (child) => {
    if (isValidElement(child)) {
      const element = (child.props as { element?: { type?: string } })
        ?.element;
      if (element?.type !== undefined) {
        types.push(element.type);
      }
    }
  });
  return types;
}

const catalogActions = Object.fromEntries(
  CATALOG_ACTION_NAMES.map((name) => [
    name,
    (params: unknown) =>
      dispatchCatalogAction(name, (params ?? {}) as Record<string, unknown>),
  ]),
) as unknown as Actions<typeof jevcodeCatalog>;

export const {
  registry,
  handlers,
  executeAction,
} = defineRegistry(jevcodeCatalog, {
  components: {
    ChangeOverview: ({ props, children }: Ctx<"ChangeOverview">) => (
      <>
        <ChangeOverview props={props as ChangeOverviewProps} />
        {children}
      </>
    ),
    BehaviorDelta: ({ props, children }: Ctx<"BehaviorDelta">) => (
      <>
        <BehaviorDelta props={props as BehaviorDeltaProps} />
        {children}
      </>
    ),
    ArchitectureDelta: ({ props, children }: Ctx<"ArchitectureDelta">) => (
      <>
        <ArchitectureDelta props={props as ArchitectureDeltaProps} />
        {children}
      </>
    ),
    SchemaDelta: ({ props, children }: Ctx<"SchemaDelta">) => (
      <>
        <SchemaDelta props={props as SchemaDeltaProps} />
        {children}
      </>
    ),
    CodeDiff: ({ props, children }: Ctx<"CodeDiff">) => (
      <>
        <CodeDiff props={props as CodeDiffProps} />
        {children}
      </>
    ),
    Decision: ({ props, children }: Ctx<"Decision">) => (
      <>
        <Decision props={props as DecisionProps} />
        {children}
      </>
    ),
    TestMatrix: ({ props, children }: Ctx<"TestMatrix">) => (
      <>
        <TestMatrix props={props as TestMatrixProps} />
        {children}
      </>
    ),
    FailureAnalysis: ({ props, children }: Ctx<"FailureAnalysis">) => (
      <>
        <FailureAnalysis props={props as FailureAnalysisProps} />
        {children}
      </>
    ),
    ExecutionTimeline: ({ props, children }: Ctx<"ExecutionTimeline">) => (
      <>
        <ExecutionTimeline props={props as ExecutionTimelineProps} />
        {children}
      </>
    ),
    Terminal: ({ props, children }: Ctx<"Terminal">) => (
      <>
        <Terminal props={props as TerminalProps} />
        {children}
      </>
    ),
    DependencyDelta: ({ props, children }: Ctx<"DependencyDelta">) => {
      const diffChildPresent = childElementTypes(children).includes("CodeDiff");
      return (
        <>
          <DependencyDelta
            props={props as DependencyDeltaProps}
            diffChildPresent={diffChildPresent}
          />
          {children !== undefined && children !== null ? (
            <div id={DEPENDENCY_CHILDREN_CONTAINER_ID}>{children}</div>
          ) : null}
        </>
      );
    },
  },
  actions: catalogActions,
});
