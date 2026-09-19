import type {
  ActionRef,
  ArchitectureEdge,
  ArchitectureNode,
  ChangeCategory,
  ChangeUnit,
  ChangeUnitStatus,
  DependencyDeltaItem,
  FileDiff,
  MatrixRow,
  Scope,
  TestFailure,
  TimelineEvent,
} from "@jevcode/contracts";
import type { Decision, SchemaChange } from "@jevcode/contracts";

export interface OverviewData {
  title?: string;
  evidenceLinks?: string[];
  diffs?: FileDiff[];
}

export interface BehaviorData {
  subject: string;
  before: string;
  after: string;
}

export interface ArchitectureData {
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  scope?: Scope;
  evidenceCount?: number;
}

export interface SchemaDeltaData {
  title: string;
  migration: string;
  changes: SchemaChange[];
  compatibilityNote?: string;
}

export interface DependencyDeltaData {
  title: string;
  added: DependencyDeltaItem[];
  removed: DependencyDeltaItem[];
}

export interface MatrixData {
  title?: string;
  summary?: string;
  rows: MatrixRow[];
}

export interface FailureData {
  title: string;
  command: string;
  runner: string;
  exitCode: number;
  failures: TestFailure[];
  linkedChangeUnits: string[];
  note?: string;
}

export interface TimelineData {
  title?: string;
  events: TimelineEvent[];
}

export interface ChangeUnitPayload {
  kind: "changeUnit";
  unit: ChangeUnit;
  confidence?: number;
  overview?: OverviewData;
  behavior?: BehaviorData;
  architecture?: ArchitectureData;
  schema?: SchemaDeltaData;
  dependencies?: DependencyDeltaData;
  diff?: FileDiff;
  matrix?: MatrixData;
  failure?: FailureData;
  timeline?: TimelineData;
  actions?: ActionRef[];
}

export interface DecisionPayload {
  kind: "decision";
  decision: Decision;
  suggestedAnswer?: {
    decision: Record<string, string>;
    evidence?: string[];
  };
  relatedUnit?: {
    unit: ChangeUnit;
    confidence?: number;
    overview?: OverviewData;
  };
}

export interface ValidationPayload {
  kind: "validation";
  matrix: MatrixData;
  overview?: {
    title: string;
    category: ChangeCategory;
    status: ChangeUnitStatus;
    confidence?: number;
    evidenceLinks?: string[];
  };
  timeline?: TimelineData;
  actions?: ActionRef[];
}

export interface FailurePayload {
  kind: "failure";
  failure: FailureData;
  matrix?: MatrixData;
  diff?: FileDiff;
  actions?: ActionRef[];
}

export interface TimelinePayload {
  kind: "timeline";
  title?: string;
  events: TimelineEvent[];
}

export type CompilePayload =
  | ChangeUnitPayload
  | DecisionPayload
  | ValidationPayload
  | FailurePayload
  | TimelinePayload;
