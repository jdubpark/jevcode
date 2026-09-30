import { z } from "zod";

import type {
  AgentInterruptReason,
  ChangeCategory,
  ChangeUnitStatus,
  Decision,
  DependencyChange,
  EventStoreType,
  JevClientKind,
  JevPass,
  SchemaChange,
  TraceSessionSummary,
} from "@jevcode/contracts";

/** Version of the TraceSession shape. Bump on any breaking change. */
export const TRACE_SCHEMA_VERSION = 1 as const;

// ------------------------------------------------------------ stable ids (R9)

export type StepId = `step:${number}`;
export type UnitStableId = `unit:${string}`;
export type DecisionStableId = `decision:${string}`;
export type FileStableId = `file:${string}`;
export type FindingId = `finding:${string}`;
export type StableId = StepId | UnitStableId | DecisionStableId | FileStableId | FindingId;

export const STABLE_ID_KINDS = ["step", "unit", "decision", "file", "finding"] as const;

export type StableIdKind = (typeof STABLE_ID_KINDS)[number];

// The s flag lets the opaque key hold line terminators (POSIX paths may contain "\n").
export const StableIdSchema = z
  .string()
  .regex(/^(?:step:[1-9]\d*|(?:unit|decision|file|finding):.+)$/s, "not a trace stable id");

export interface ParsedStableId {
  kind: StableIdKind;
  /** Everything after the first colon. Opaque; may itself contain colons. */
  key: string;
}

function positiveInt(label: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

function nonEmpty(label: string, value: string): string {
  if (value.length === 0) throw new RangeError(`${label} must be non-empty`);
  return value;
}

export function stepStableId(firstSeq: number): StepId {
  return `step:${positiveInt("step seq", firstSeq)}`;
}

export function unitStableId(changeUnitId: string): UnitStableId {
  return `unit:${nonEmpty("change unit id", changeUnitId)}`;
}

export function decisionStableId(decisionId: string): DecisionStableId {
  return `decision:${nonEmpty("decision id", decisionId)}`;
}

export function fileStableId(path: string): FileStableId {
  return `file:${nonEmpty("file path", path)}`;
}

export function findingStableId(
  ruleId: SignalId,
  ruleVersion: number,
  anchorSeq: number,
): FindingId {
  return `finding:${ruleId}@${positiveInt("rule version", ruleVersion)}:${positiveInt("anchor seq", anchorSeq)}`;
}

export function parseStableId(value: string): ParsedStableId | null {
  if (!StableIdSchema.safeParse(value).success) return null;
  const colon = value.indexOf(":");
  return { kind: value.slice(0, colon) as StableIdKind, key: value.slice(colon + 1) };
}

// ------------------------------------------------------------ vocabulary

/** Hybrid lanes, top to bottom (R14). */
export const LANES = ["supervisor", "agent", "commands", "edits", "tests", "jev"] as const;
export type Lane = (typeof LANES)[number];

/** Semantic zoom levels shared by both views (R20). */
export const LEVELS = ["session", "chapter", "step"] as const;
export type Level = (typeof LEVELS)[number];

export type Actor = "supervisor" | "agent" | "repo" | "jevcode";

/** observed = joined by an id; inferred = joined by a heuristic (FIFO, time window). */
export type Provenance = "observed" | "inferred";

export const STEP_KINDS = [
  "instruction",
  "message",
  "reasoning",
  "command",
  "test",
  "check",
  "edit",
  "read",
  "tool",
  "approval",
  "decision",
  "dependency",
  "revert",
  "lifecycle",
  "guardrail",
  "attention",
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** "unknown" covers exit code -1, unpaired starts and interrupted runs. Never rendered as failed. */
export type StepStatus = "ok" | "failed" | "running" | "unknown" | "info";

export const PROBLEM_KINDS = [
  "exit_nonzero",
  "tests_failed",
  "agent_failed",
  "destructive",
  "guardrail",
  "claim_contradicted",
] as const;
export type ProblemKind = (typeof PROBLEM_KINDS)[number];

export const NOISE_REASONS = [
  "read",
  "lockfile",
  "formatting",
  "duplicate_poll",
  "lifecycle",
  "pipeline",
  "superseded",
  "passing_test",
] as const;
export type NoiseReason = (typeof NOISE_REASONS)[number];

export type TurnTrigger = "initial" | "steer" | "resume";

export type TurnOutcome = "completed" | "failed" | "interrupted" | "waiting" | "running" | "unknown";

export type Severity = "info" | "warning" | "critical";

export const SIGNAL_IDS = [
  "claim_contradicted",
  "failing_tests",
  "destructive_command",
  "guardrail_clamp",
  "recovery_arc",
] as const;
export type SignalId = (typeof SIGNAL_IDS)[number];

/** Data a session may or may not contain; signals list what they require. */
export const CAPABILITIES = [
  "agent_messages",
  "agent_commands",
  "test_results",
  "jev_decisions",
  "call_ids",
  "fact_links",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const GAP_KINDS = [
  "invalid_row",
  "unknown_row_type",
  "out_of_order",
  "unpaired",
  "missing_evidence",
] as const;
export type GapKind = (typeof GAP_KINDS)[number];

// ------------------------------------------------------------ step details

export interface TestCounts {
  passed: number;
  failed: number;
  skipped: number;
}

export interface TestFailureSummary {
  file: string;
  testName: string;
  message: string;
}

export interface CommandDetail {
  /** The command as the agent ran it. */
  command: string;
  /** null = not completed yet; -1 = unknown (Codex gave no exit code). */
  exitCode: number | null;
  /** DestructivePattern.name from matchDestructive, when it matched. */
  destructivePattern?: string;
  /** Last 20 lines of stdout then stderr, at most 2,048 UTF-16 code units; command, test and check steps (spec §6.2). */
  outputTail?: string;
}

export interface TestDetail extends TestCounts {
  runner?: string;
  /** At most the first 20 failures. */
  failures: TestFailureSummary[];
  /** seq of the test_result row these counts come from; fetch it with TraceSource.payloads. */
  resultSeq?: number;
}

export type DiffState = "text" | "truncated" | "withheld_secret" | "not_captured" | "none";

export interface EditDetail {
  path: string;
  change?: "added" | "modified" | "deleted";
  added: number;
  removed: number;
  /** An agent file_changed event names this path. */
  claimed: boolean;
  /** A repo fact (file_changed, git_hunk, symbol_delta) confirms it. */
  observed: boolean;
  /** seq of the latest git_hunk row for this path in this step; fetch it with TraceSource.payloads. */
  diffSeq?: number;
  diff: DiffState;
  lockfile: boolean;
  formattingOnly: boolean;
}

export interface DecisionDetail {
  decisionId: string;
  title: string;
  severity: Decision["severity"];
  status: Decision["status"];
  options: { id: string; label: string; chosen: boolean }[];
  decidedBy?: "supervisor" | "delegated";
  /** seq of the supervisor's answer message, absorbed into this step (R25). */
  answerSeq?: number;
}

export interface GuardrailDetail {
  clampIds: string[];
  changeUnitId?: string;
  pass?: JevPass;
  clientKind: JevClientKind;
  confidence: number;
}

// ------------------------------------------------------------ fold output

export interface Step {
  id: StepId;
  kind: StepKind;
  lane: Lane;
  actor: Actor;
  provenance: Provenance;
  status: StepStatus;
  /** Short title from stepHeadline (format.ts). */
  headline: string;
  /** Command text, path or tool name. */
  target?: string;
  /** instruction, message and reasoning steps. */
  text?: string;
  callId?: string;
  turnIndex: number;
  /** Every row folded into this step, ascending. */
  seqs: number[];
  firstSeq: number;
  lastSeq: number;
  /** Payload source ts of the first row when present, else the row ts. */
  startTs: string;
  endTs: string | null;
  /** Display clock: ms since TraceSession.originMs, never decreasing with seq (spec §6.5). */
  tMs: number;
  /** Epoch ms of the first row's source time, unclamped; for decision, validation, change_unit
   *  and jev_decision rows originMs plus the inherited clock (R25, spec §6.5). */
  startMs: number;
  /** null while running. */
  endTMs: number | null;
  durationMs: number | null;
  /** Codex times are PTY arrival times. */
  approxTime: boolean;
  command?: CommandDetail;
  tests?: TestDetail;
  edit?: EditDetail;
  decision?: DecisionDetail;
  guardrail?: GuardrailDetail;
  /** Repo facts and validations attached to this step. */
  evidenceSeqs: number[];
  chapterIds: UnitStableId[];
  entityIds: FileStableId[];
  findingIds: FindingId[];
  problems: ProblemKind[];
  /** Never set when problems or findingIds are non-empty (R10, R11). */
  noise: NoiseReason | null;
}

export interface Turn {
  index: number;
  trigger: TurnTrigger;
  prompt: string;
  outcome: TurnOutcome;
  interruptReason?: AgentInterruptReason;
  turnId?: string;
  startSeq: number;
  endSeq: number;
  startTs: string;
  endTs: string;
  tMs: number;
  endTMs: number;
  stepIds: StepId[];
  /** The first assistant message before the turn's first edit that starts with "Plan" or lists
   *  at least two items (R25). */
  planStepId?: StepId;
  /** The turn's last success-claim message: the one claim_contradicted checks (R25). */
  claimStepId?: StepId;
}

export interface EvidenceLinks {
  /** fact_ ids cited by the latest unit version. */
  cited: number;
  /** cited ids that match a row factId. */
  resolved: number;
  /** steps attached by the time-window fallback (D11). */
  approx: number;
}

export interface Chapter {
  id: UnitStableId;
  changeUnitId: string;
  title: string;
  intent?: string;
  category: ChangeCategory;
  status: ChangeUnitStatus;
  /** False when the latest version is superseded (R25). */
  current: boolean;
  /** Every joined edit is a lockfile or formatting-only change, or the latest Pass A jev_decision
   *  row for the unit has shouldSurface: false; a finding that names the chapter clears it (R25).
   *  The views collapse it by default. */
  noise: boolean;
  files: string[];
  /** inferred = approximate join (D11). */
  link: Provenance;
  evidenceLinks: EvidenceLinks;
  /** seq of the first change_unit row for this id. */
  firstSeq: number;
  /** seq of the latest version. */
  lastSeq: number;
  versions: number;
  /** unit createdAt / updatedAt. */
  startTs: string;
  endTs: string;
  tMs: number;
  endTMs: number;
  stepIds: StepId[];
  factSeqs: number[];
  decisionIds: DecisionStableId[];
  validationIds: string[];
  /** Steps that the unit's validation results attached to, in seq order (R25). */
  validationStepIds: StepId[];
  clampIds: string[];
  triad: { importance?: number; relevance?: number; interruption?: number; clientKind?: JevClientKind };
  schemaChanges: SchemaChange[];
  dependencyChanges: DependencyChange[];
  findingIds: FindingId[];
}

export interface Entity {
  id: FileStableId;
  kind: "file";
  path: string;
  /** truncateMiddle(path, 48). */
  label: string;
  added: number;
  removed: number;
  claimed: boolean;
  observed: boolean;
  stepIds: StepId[];
  chapterIds: UnitStableId[];
}

export interface ClaimObservation {
  claim: { text: string; seq: number; tMs: number; stepId: StepId };
  observed: {
    command: string;
    passed: number;
    failed: number;
    skipped: number;
    seq: number;
    tMs: number;
    stepId: StepId;
  };
}

export interface Finding {
  id: FindingId;
  ruleId: SignalId;
  ruleVersion: number;
  severity: Severity;
  anchorSeq: number;
  /** The step the finding pins to; always one of stepIds (R25). */
  anchorStepId: StepId;
  headline: string;
  reason: string;
  stepIds: StepId[];
  chapterIds: UnitStableId[];
  evidenceSeqs: number[];
  /** claim_contradicted only. */
  claim?: ClaimObservation;
  /** claim_contradicted only: the claim message step (R25). */
  claimStepId?: StepId;
  /** claim_contradicted only: the failed test or check steps behind the contradiction (R25). */
  evidenceStepIds?: StepId[];
  /** claim_contradicted only: [start, end) in UTF-16 code units of the claim step's text (R25). */
  claimSpan?: [number, number];
  /** destructive_command only. */
  matchedPattern?: string;
  /** guardrail_clamp only. */
  clampId?: string;
}

export interface Gap {
  kind: GapKind;
  atSeq: number;
  message: string;
}

export interface SignalMeta {
  id: SignalId;
  version: number;
  severity: Severity;
  title: string;
  rationale: string;
  knownFalsePositives: string[];
  requires: Capability[];
}

export interface SignalCoverage {
  id: SignalId;
  active: boolean;
  missing: Capability[];
}

export interface Coverage {
  /** Present in the folded rows, in CAPABILITIES order. */
  capabilities: Capability[];
  /** One entry per SIGNAL_IDS entry, in that order. */
  signals: SignalCoverage[];
  /** Any chapter joined by time window (D11 header notice). */
  approximateJoins: boolean;
  inferredSteps: number;
}

export interface Hidden {
  /**
   * Delivered rows that make no step. Empty in v1: trace:rows and bundles deliver only
   * TRACE_ROW_TYPES, so graph_*, telemetry and ui_* rows are never delivered at all — they
   * are filtered out before the model ever sees them, and count in `unreceived` below, not here.
   */
  byType: Partial<Record<EventStoreType, number>>;
  /** loadedThroughSeq minus rows received: rows the source filtered out (gapless seq). */
  unreceived: number;
}

export interface TraceSession {
  schemaVersion: typeof TRACE_SCHEMA_VERSION;
  meta: TraceSessionSummary;
  live: boolean;
  loadedThroughSeq: number;
  /** Epoch ms of display-clock zero: the first clock row's source time, else Date.parse(meta.startedAt) (spec §6.5). */
  originMs: number;
  span: { startTs: string; endTs: string; durationMs: number };
  /** Every list below is sorted by (seq, id), never by Map iteration order. */
  turns: Turn[];
  steps: Step[];
  chapters: Chapter[];
  entities: Entity[];
  findings: Finding[];
  gaps: Gap[];
  coverage: Coverage;
  hidden: Hidden;
}

// ------------------------------------------------------------ mini graphics (D8)

export type GraphicSpec =
  | {
      kind: "diff";
      added: number;
      removed: number;
      /** Chapters: per file, ordered by lines changed, at most 4 (spec §7.5 "DiffBar shows the top 4 files and +k"). */
      files?: { path: string; added: number; removed: number }[];
      moreFiles?: number;
    }
  | { kind: "tests"; passed: number; failed: number; skipped: number }
  | {
      kind: "duration";
      /** null while running. */
      durationMs: number | null;
      running: boolean;
      status: StepStatus;
      /** bad_dot: a failed test or check; exit_x: a command with exit > 0 (spec §7.12 DurationBar). */
      end: "none" | "bad_dot" | "exit_x";
    }
  | {
      kind: "fork";
      options: { label: string; chosen: boolean }[];
      decidedBy: "supervisor" | "delegated" | "open";
    }
  | { kind: "flow"; nodes: string[]; focus: number }
  /** Schema chapters, from schemaChanges (spec §6.2, §6.6); v1 has no foreign keys. */
  | { kind: "table"; tables: { name: string; role: "new" | "altered"; columns: number }[] }
  | {
      kind: "claim";
      claim: { text: string; span?: [number, number]; tMs: number };
      observed: { passed: number; failed: number; command: string; tMs: number };
    };
