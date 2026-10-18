import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { RepoContext } from "./collect.js";
import { clean, readSource } from "./io.js";
import { SECTIONS, type Section } from "./prompt.js";
import { REMOVAL_NOTE, type Brief, type Citation } from "./report.js";

/** TypeSafe System One primitives. Jev answers small judgments; it never writes the brief. */
export interface JevQuestion { type: "noul" | "choice" | "score"; instructions?: unknown; criteria?: unknown }
export interface JevUsage { input: number; output: number }
export interface JevTransport {
  systemOne(request: { state: unknown; questions: Record<string, JevQuestion> }): Promise<{ answers: Record<string, unknown>; usage?: { input_tokens?: number; output_tokens?: number } }>;
}

/** Null without a key: callers use the disclosed heuristic path instead of failing. */
export function jevFromEnv(env: NodeJS.ProcessEnv = process.env): JevTransport | null {
  const apiKey = env.JEV_API_KEY ?? env.TYPESAFE_API_KEY;
  if (!apiKey?.trim()) return null;
  const client = new TypeSafeClient({ apiKey, baseURL: env.TYPESAFE_BASE_URL, defaultModel: env.TYPESAFE_DEFAULT_MODEL, logLevel: "off", timeout: 30_000 });
  return { systemOne: async (request) => await client.systemOne(request as Parameters<TypeSafeClient["systemOne"]>[0]) as Awaited<ReturnType<JevTransport["systemOne"]>> };
}

const usageOf = (usage: { input_tokens?: number; output_tokens?: number } | undefined): JevUsage => ({ input: usage?.input_tokens ?? 0, output: usage?.output_tokens ?? 0 });
const clip = (text: string, size: number): string => { const value = clean(text).replace(/\s+/g, " ").trim(); return value.length > size ? value.slice(0, size - 1) + "…" : value; };
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

function noul(answers: Record<string, unknown>, key: string): number {
  const answer = answers[key] as { noul?: unknown } | undefined;
  if (typeof answer?.noul !== "number" || !Number.isFinite(answer.noul)) throw new Error(`Jev returned no probability for ${key}.`);
  return clamp(answer.noul, 0, 1);
}

export interface GateSignals {
  hasCheckpoint: boolean;
  changedSinceBrief: string[];
  removedSinceBrief: string[];
  touchedComponents: { path: string; changed: number; incoming: number }[];
  componentCount: number;
  newActivityBytes: number;
  recentActivity: string[];
  minutesSinceBrief: number | null;
  previous: Brief | null;
  /** What changed in each file since the brief: line counts and a few added/removed lines. */
  changes: { path: string; added: number; removed: number; lines: string[] }[];
}
export type Scope = "skip" | "update" | "full";
export interface GateJudgment { worthwhile: number; scope: Scope; stale: Section[]; judge: "jev" | "heuristic"; usage: JevUsage | null; error?: string }

/** Interpretable fallback when Jev is unavailable. minFiles is tuned from outcomes. */
export function heuristicGate(signals: GateSignals, minFiles: number): GateJudgment {
  if (!signals.hasCheckpoint || signals.previous === null) return { worthwhile: 1, scope: "full", stale: [...SECTIONS], judge: "heuristic", usage: null };
  const files = signals.changedSinceBrief.length + signals.removedSinceBrief.length;
  const hub = signals.touchedComponents.some((component) => component.incoming >= 3);
  const spread = signals.componentCount ? signals.touchedComponents.length / signals.componentCount : 0;
  const worthwhile = clamp(0.1 + 0.5 * Math.min(1, files / (2 * minFiles)) + (hub ? 0.2 : 0) + 0.2 * Math.min(1, signals.newActivityBytes / 100_000), 0, 1);
  const shape = signals.removedSinceBrief.length > 0 || spread >= 0.15 || hub;
  const stale = SECTIONS.filter((section) => {
    if (section === "architecture" || section === "diagrams") return shape;
    if (section === "guidance") return hub;
    if (section === "checks") return signals.newActivityBytes > 0;
    return true;
  });
  return { worthwhile, scope: spread >= 0.3 ? "full" : "update", stale, judge: "heuristic", usage: null };
}

const SECTION_MEANING: Record<Section, string> = {
  architecture: "major responsibilities, dependencies and the key end-to-end flow",
  review: "the ranked code areas a human should inspect first",
  changes: "the meaningful changes and the agent work behind them",
  checks: "reported test or check evidence",
  guidance: "constraints and directions for later coding agents",
  unknowns: "open questions and missing context",
  diagrams: "the system and change diagrams",
};

function gateState(signals: GateSignals): unknown {
  const brief = signals.previous;
  return {
    task: "A generated repository brief helps a human understand a codebase and recent agent work. Decide whether it should be refreshed now.",
    minutesSinceBrief: signals.minutesSinceBrief,
    changedSinceBrief: signals.changedSinceBrief.slice(0, 60), changedCount: signals.changedSinceBrief.length,
    removedSinceBrief: signals.removedSinceBrief.slice(0, 30), componentCount: signals.componentCount,
    touchedComponents: signals.touchedComponents.slice(0, 15),
    changes: signals.changes.slice(0, 8).map((entry) => ({ ...entry, lines: entry.lines.map((line) => clip(line, 160)) })),
    newActivityKilobytes: Math.round(signals.newActivityBytes / 1024),
    recentActivity: signals.recentActivity.slice(-8).map((text) => clip(text, 300)),
    previousBrief: brief && {
      summary: clip(brief.summary, 400),
      architecture: brief.architecture.map((entry) => clip(entry.text, 160)),
      review: brief.review.map((entry) => clip(`${entry.area}: ${entry.question}`, 160)),
      changes: brief.changes.map((entry) => clip(entry.text, 160)),
      checks: brief.checks.map((entry) => clip(entry.text, 120)),
      guidance: brief.guidance.map((entry) => clip(entry.text, 120)),
      unknowns: brief.unknowns.filter((entry) => !REMOVAL_NOTE.test(entry)).map((entry) => clip(entry, 120)),
      diagrams: brief.diagrams.map((entry) => entry.title),
    },
  };
}

/** One batched System One request: worth refreshing, scope, and per-section staleness. */
export async function jevGate(transport: JevTransport, signals: GateSignals): Promise<GateJudgment> {
  if (!signals.hasCheckpoint || signals.previous === null) return { worthwhile: 1, scope: "full", stale: [...SECTIONS], judge: "jev", usage: null };
  const questions: Record<string, JevQuestion> = {
    worthwhile: {
      type: "noul",
      instructions: "Would a human reading `previousBrief` now hold a materially wrong or incomplete picture of the system or of the agent work, given `changedSinceBrief`, `removedSinceBrief` and `recentActivity`? Use `changes` (added and removed lines per file since the brief) to tell behavior, contract or structure changes from formatting, comments, renames or test-only churn.",
      criteria: {
        true: "Refreshing now would correct or add something a reviewer needs to know.",
        false: "The changes are routine, cosmetic, already described, or too small to change what a reviewer should know.",
      },
    },
    scope: {
      type: "choice",
      instructions: "How much of `previousBrief` needs to be regenerated?",
      criteria: {
        skip: "Nothing material changed since the brief.",
        update: "A localized change: some sections need revision while the overall system description still holds.",
        full: "The system's shape changed: new or removed components, moved responsibilities, or most sections are now wrong.",
      },
    },
  };
  for (const section of SECTIONS) {
    questions[`stale_${section}`] = {
      type: "noul",
      instructions: `Is the \`${section}\` section of \`previousBrief\` (${SECTION_MEANING[section]}) now out of date or missing something important, given the changes and activity since it was written?`,
      criteria: { true: "This section should be revised.", false: "This section still holds." },
    };
  }
  const result = await transport.systemOne({ state: gateState(signals), questions });
  const scopeAnswer = (result.answers.scope as { choice?: unknown } | undefined)?.choice;
  if (scopeAnswer !== "skip" && scopeAnswer !== "update" && scopeAnswer !== "full") throw new Error("Jev returned no scope choice.");
  const stale = scopeAnswer === "full" ? [...SECTIONS] : SECTIONS.filter((section) => noul(result.answers, `stale_${section}`) >= 0.5);
  return { worthwhile: noul(result.answers, "worthwhile"), scope: scopeAnswer, stale, judge: "jev", usage: usageOf(result.usage) };
}

export interface ClaimRef { section: Section; index: number; text: string; citations: Citation[] }

export function claimsOf(brief: Brief): ClaimRef[] {
  return [
    ...brief.architecture.map((entry, index) => ({ section: "architecture" as const, index, text: entry.text, citations: entry.citations })),
    ...brief.review.map((entry, index) => ({ section: "review" as const, index, text: `${entry.area}: ${entry.why} Review question: ${entry.question}`, citations: entry.citations })),
    ...brief.changes.map((entry, index) => ({ section: "changes" as const, index, text: entry.text, citations: entry.citations })),
    ...brief.checks.map((entry, index) => ({ section: "checks" as const, index, text: entry.text, citations: entry.citations })),
    ...brief.guidance.map((entry, index) => ({ section: "guidance" as const, index, text: entry.text, citations: entry.citations })),
    ...brief.diagrams.map((entry, index) => ({ section: "diagrams" as const, index, text: `${entry.title}: ${entry.mermaid}`, citations: entry.citations })),
  ];
}

/** Small windows around each citation; the same redaction as the prompt packet. */
async function excerpt(ref: Citation, context: RepoContext, sources: Map<string, string[] | null>): Promise<string> {
  if (ref.source.startsWith("activity:")) {
    return clip(context.activity.find((log) => log.source === ref.source)?.records.find((entry) => entry.line === ref.line)?.text ?? "", 400);
  }
  const lines = ref.source.startsWith("patch:")
    ? context.patches.find((entry) => entry.source === ref.source)?.text.split("\n") ?? []
    : await (async () => {
      if (!sources.has(ref.source)) sources.set(ref.source, (await readSource(context.repo, ref.source))?.split("\n") ?? null);
      return sources.get(ref.source) ?? [];
    })();
  return clip(lines.slice(Math.max(0, ref.line - 3), ref.line + 2).join("\n"), 500);
}

export interface ClaimSupport { section: Section; index: number; support: number }

/** Asks Jev whether each claim's cited excerpts support it. Low support marks a claim for repair. */
export async function verifyClaims(transport: JevTransport, brief: Brief, context: RepoContext): Promise<{ support: ClaimSupport[]; usage: JevUsage }> {
  const claims = claimsOf(brief).slice(0, 30);
  if (claims.length === 0) return { support: [], usage: { input: 0, output: 0 } };
  const sources = new Map<string, string[] | null>();
  const state: Record<string, unknown> = {};
  const questions: Record<string, JevQuestion> = {};
  for (const [position, claim] of claims.entries()) {
    const key = `c${position}`;
    state[key] = { section: claim.section, text: clip(claim.text, 700), evidence: await Promise.all(claim.citations.map(async (ref) => ({ source: ref.source, line: ref.line, excerpt: await excerpt(ref, context, sources) }))) };
    questions[key] = {
      type: "noul",
      instructions: `Judging \`claims.${key}\`: do its evidence excerpts directly support what it states? For a review entry, the cited code must be relevant to the stated consequence and question. For a diagram, the excerpts must support its edges.`,
      criteria: {
        true: "The excerpts establish the statement, or make it a direct, reasonable reading of the code.",
        false: "The excerpts are unrelated, contradict it, or the statement goes well beyond them.",
      },
    };
  }
  const result = await transport.systemOne({ state: { task: "Check generated repository-brief claims against their cited evidence.", claims: state }, questions });
  return { support: claims.map((claim, position) => ({ section: claim.section, index: claim.index, support: noul(result.answers, `c${position}`) })), usage: usageOf(result.usage) };
}

/** Below this support a claim counts as unsupported for tuning, whatever the active threshold is. */
export const DEFAULT_SUPPORT = 0.35;

/** Drops entries that stayed unsupported after repair and discloses the removal. */
export function withoutClaims(brief: Brief, weak: ClaimSupport[]): Brief {
  if (weak.length === 0) return brief;
  const drop = (section: Section) => new Set(weak.filter((entry) => entry.section === section).map((entry) => entry.index));
  const keep = <T>(section: Section, items: T[]): T[] => { const removed = drop(section); return items.filter((_, index) => !removed.has(index)); };
  const sections = [...new Set(weak.map((entry) => entry.section))].join(", ");
  return {
    ...brief,
    architecture: keep("architecture", brief.architecture), review: keep("review", brief.review), changes: keep("changes", brief.changes),
    checks: keep("checks", brief.checks), guidance: keep("guidance", brief.guidance), diagrams: keep("diagrams", brief.diagrams),
    unknowns: [...brief.unknowns, `${weak.length} generated ${weak.length === 1 ? "entry was" : "entries were"} removed from ${sections} because the cited evidence did not support ${weak.length === 1 ? "it" : "them"}.`].slice(-8),
  };
}
