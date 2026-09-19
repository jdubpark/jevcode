import type {
  AttentionDecision,
  ChangeCategory,
  ChangeUnitStatus,
  EvidenceFact,
  JevResult,
  UIIntent,
} from "@jevcode/contracts";

export type JevHealth = "ok" | "degraded";

export interface JevClient {
  attention(batch: AttentionInput[]): Promise<JevResult<AttentionDecision>[]>;
  project(input: ProjectionInput): Promise<JevResult<UIIntent>>;
  health(): Promise<JevHealth>;
}

export interface DependencyHint {
  name: string;
  change: "added" | "removed";
}

export interface TestResultHint {
  runner: string;
  passed: number;
  failed: number;
  skipped: number;
  failureFiles: string[];
}

export interface EvidenceHints {
  diffStats: { added: number; removed: number };
  formattingOnly: boolean;
  lockfileOnly: boolean;
  configOnly: boolean;
  destructiveCommands: string[];
  securityPaths: string[];
  schemaPaths: string[];
  publicExports: string[];
  behaviorChange: boolean;
  interfacesChanged: number;
  dependencyChanges: DependencyHint[];
  testResults: TestResultHint[];
  decisionIds: string[];
  autoCollapsePassingTests: boolean;
}

export interface AttentionInput {
  changeUnitId: string;
  decisionVersion: number;
  sessionId: string;
  title: string;
  intent?: string;
  categoryHint?: ChangeCategory;
  status: ChangeUnitStatus;
  files: string[];
  symbols: string[];
  taskPrompt: string;
  hints: EvidenceHints;
  createdAt: string;
}

export interface ProjectionInput extends AttentionInput {
  attention: AttentionDecision;
}

export interface SessionContext {
  sessionId: string;
  taskPrompt: string;
  facts: EvidenceFact[];
  decisionsForUnit?: Record<string, string[]>;
  autoCollapsePassingTests?: boolean;
}

export interface NoulAnswer {
  readonly type: "noul";
  readonly noul: number;
}

export interface ChoiceAnswer {
  readonly type: "choice";
  readonly choice: string;
  readonly confidence: number;
  readonly probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  readonly type: "score";
  readonly score: number;
  readonly confidence: number;
  readonly probabilities: Record<string, number>;
}

export type TypeSafeAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface SystemOneResultLike {
  model?: string;
  answers: Record<string, unknown>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface TypeSafeQuestion {
  type: "noul" | "choice" | "score";
  instructions?: unknown;
  criteria?: unknown;
}

export interface SystemOneRequestLike {
  state: unknown;
  questions: Record<string, TypeSafeQuestion>;
  model?: string;
}

export interface TypeSafeTransport {
  systemOne(request: SystemOneRequestLike): Promise<SystemOneResultLike>;
}

export type EnvReader = () => Record<string, string | undefined>;

export const TYPESAFE_CLIENT_KIND = "typesafe" as const;
