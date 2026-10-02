import type { Citation, JevResult, NarrativeSentence, Role } from "@jevcode/contracts";

/**
 * Repo metadata for one component (spec §6.2). Never file contents. `blurb` is the
 * package.json description or the first README paragraph, already redacted and at
 * most 600 characters; the client clips it again.
 */
export interface ComponentBrief {
  id: string;
  name: string;
  rootPath: string;
  roleGuess: Role;
  files: string[];
  exports: string[];
  externalDeps: string[];
  edgesIn: { name: string; count: number }[];
  edgesOut: { name: string; count: number }[];
  blurb: string | null;
}

export interface DescribedComponent {
  id: string;
  purpose: string;
  role: Role;
  citations: Citation[];
}

export interface OverviewNarrativeInput {
  components: { id: string; name: string; role: Role; purpose: string | null }[];
  edges: { from: string; to: string; count: number }[];
}

export interface SessionStoryInput {
  prompt: string;
  recentSteps: { id: string; headline: string }[];
  decisions: { id: string; title: string; status: string }[];
  tests: { passed: number; failed: number } | null;
  touchedComponents: { id: string; name: string }[];
}

export interface DecisionWhyInput {
  decisionId: string;
  title: string;
  options: { id: string; label: string }[];
  answer: string;
  nearby: { id: string; kind: "message" | "step"; text: string }[];
}

export interface NarratorUsage {
  inputTokens: number;
  outputTokens: number;
}

/** JevResult plus what spec §6.3 logs: model, latency, token usage. `schemaValid: false` means the answer was dropped. */
export interface NarratorResult<T> extends JevResult<T> {
  model: string;
  ms: number;
  usage: NarratorUsage | null;
  schemaValid: boolean;
}

export interface NarratorCallOptions {
  signal?: AbortSignal;
}

/**
 * Values are schema-checked but NOT guarded: callers run guardComponents /
 * guardSentences against a CitationUniverse before using any text.
 */
export interface NarratorClient {
  describeComponents(batch: ComponentBrief[], options?: NarratorCallOptions): Promise<NarratorResult<DescribedComponent[]>>;
  overviewNarrative(input: OverviewNarrativeInput, options?: NarratorCallOptions): Promise<NarratorResult<NarrativeSentence[]>>;
  sessionStory(input: SessionStoryInput, options?: NarratorCallOptions): Promise<NarratorResult<NarrativeSentence[]>>;
  decisionWhy(input: DecisionWhyInput, options?: NarratorCallOptions): Promise<NarratorResult<NarrativeSentence | null>>;
}

export const NARRATOR_MODEL = "claude-haiku-4-5-20251001";
export const NARRATOR_TIMEOUT_MS = 10_000;
export const NARRATOR_MAX_BATCH = 20;
/** Claude Haiku 4.5 list price, USD per million tokens. */
export const NARRATOR_PRICE_USD_PER_MTOK = { input: 1, output: 5 } as const;

export function narratorCostUsd(usage: NarratorUsage): number {
  return (
    (usage.inputTokens * NARRATOR_PRICE_USD_PER_MTOK.input +
      usage.outputTokens * NARRATOR_PRICE_USD_PER_MTOK.output) /
    1_000_000
  );
}

export interface CitationUniverse {
  components: ReadonlySet<string>;
  files: ReadonlySet<string>;
  decisions: ReadonlySet<string>;
  facts: ReadonlySet<string>;
  steps: ReadonlySet<string>;
  componentNames: ReadonlySet<string>;
  /** Lets guardComponents allow a purpose to name its own component (deviation 4). */
  componentNameById?: ReadonlyMap<string, string>;
}

export interface GuardResult<T> {
  accepted: T;
  dropped: number;
  total: number;
  discarded: boolean;
  reasons: string[];
}
