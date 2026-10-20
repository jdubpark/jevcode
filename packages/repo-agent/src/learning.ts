import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { hash } from "./io.js";
import { SECTIONS, type Section } from "./prompt.js";
import type { Brief } from "./report.js";

const usage = z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() }).nullable();
export function foldWriterUsage(usage: { input: number; output: number; reasoning?: number; cacheRead?: number; cacheWrite?: number } | null): { input: number; output: number } | null {
  return usage === null ? null : {
    input: usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
    output: usage.output + (usage.reasoning ?? 0),
  };
}
const DecisionSchema = z.object({
  kind: z.literal("decision"), id: z.string(), at: z.string(),
  action: z.enum(["skip", "run", "coalesced"]), reason: z.string(), judge: z.enum(["deterministic", "jev", "heuristic"]),
  worthwhile: z.number().nullable(), scope: z.enum(["skip", "update", "full"]).nullable(), stale: z.array(z.string()),
  signals: z.object({ changedFiles: z.number(), newActivityBytes: z.number(), minutesSinceBrief: z.number().nullable() }),
  jevUsage: usage, quickKey: z.string().nullable(), session: z.string().nullable(),
});
const RunSchema = z.object({
  kind: z.literal("run"), id: z.string(), at: z.string(), trigger: z.enum(["auto", "manual"]), decision: z.string().nullable(),
  ok: z.boolean(), error: z.string().nullable(), writer: z.string().nullable(), model: z.string().nullable(), attempts: z.number(),
  writerUsage: usage, jevUsage: usage, churn: z.number().nullable(), weakClaims: z.number(), removedClaims: z.number(), elapsedMs: z.number(),
  // Claims below the fixed default support in the first draft; absent in early ledgers.
  unsupportedAtDefault: z.number().default(0),
  // What the claim check removed (clipped), so a human can audit Jev and answer with feedback.
  removed: z.array(z.object({ section: z.string(), text: z.string(), support: z.number() })).default([]),
});
const FeedbackSchema = z.object({
  kind: z.literal("feedback"), id: z.string(), at: z.string(),
  // harsh: the claim check removed entries that were correct.
  verdict: z.enum(["useful", "noise", "late", "wrong", "harsh"]), section: z.string().nullable(), note: z.string().nullable(),
});
export const LedgerEntrySchema = z.discriminatedUnion("kind", [DecisionSchema, RunSchema, FeedbackSchema]);
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type Run = z.infer<typeof RunSchema>;
export type Feedback = z.infer<typeof FeedbackSchema>;
export type Verdict = Feedback["verdict"];

export const TuningSchema = z.object({
  version: z.literal(1),
  gateThreshold: z.number(), debounceMinutes: z.number(), minFiles: z.number(), verifyThreshold: z.number(),
  adjustedAt: z.string().nullable(),
  history: z.array(z.object({ at: z.string(), field: z.string(), from: z.number(), to: z.number(), reason: z.string() })),
});
export type Tuning = z.infer<typeof TuningSchema>;
export const DEFAULT_TUNING: Tuning = { version: 1, gateThreshold: 0.5, debounceMinutes: 10, minFiles: 2, verifyThreshold: 0.35, adjustedAt: null, history: [] };
const BOUNDS = { gateThreshold: [0.25, 0.85], debounceMinutes: [2, 120], minFiles: [1, 10], verifyThreshold: [0.2, 0.6] } as const;

const base = (directory: string, repo: string): string => path.join(directory, hash(repo));
export const ledgerPath = (directory: string, repo: string): string => `${base(directory, repo)}.ledger.jsonl`;
const tuningPath = (directory: string, repo: string): string => `${base(directory, repo)}.tuning.json`;
export const newId = (): string => randomUUID();

/** Small single-line appends; concurrent writers cannot interleave within one record. */
export async function appendLedger(directory: string, repo: string, entry: LedgerEntry): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await appendFile(ledgerPath(directory, repo), JSON.stringify(LedgerEntrySchema.parse(entry)) + "\n", { mode: 0o600 });
}

/** Unreadable lines are skipped: the ledger informs tuning but never blocks a brief. */
export async function readLedger(directory: string, repo: string, limit = 400): Promise<LedgerEntry[]> {
  const raw = await readFile(ledgerPath(directory, repo), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
  return raw.split("\n").filter(Boolean).slice(-limit).flatMap((line) => {
    try { const parsed = LedgerEntrySchema.safeParse(JSON.parse(line)); return parsed.success ? [parsed.data] : []; }
    catch { return []; }
  });
}

export async function readTuning(directory: string, repo: string): Promise<Tuning> {
  try {
    const parsed = TuningSchema.safeParse(JSON.parse(await readFile(tuningPath(directory, repo), "utf8")));
    return parsed.success ? parsed.data : { ...DEFAULT_TUNING };
  } catch { return { ...DEFAULT_TUNING }; }
}

export async function saveTuning(directory: string, repo: string, tuning: Tuning): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = tuningPath(directory, repo);
  const temporary = `${target}.${process.pid}.tmp`;
  const file = await open(temporary, "w", 0o600);
  try { await file.writeFile(JSON.stringify(TuningSchema.parse(tuning))); } finally { await file.close(); }
  await rename(temporary, target).finally(() => rm(temporary, { force: true }));
}

const words = (text: string): Set<string> => new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
function similarity(a: string, b: string): number {
  const left = words(a), right = words(b);
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * Share of the revised sections whose wording materially changed. An incremental run is measured
 * only over the sections it was asked to revise. Low churn means the run added little.
 */
export function churn(previous: Brief | null, next: Brief, sections: readonly Section[] = SECTIONS): number {
  if (previous === null || sections.length === 0) return 1;
  const text = (brief: Brief, section: Section): string => JSON.stringify(brief[section]);
  return sections.filter((section) => similarity(text(previous, section), text(next, section)) < 0.8).length / sections.length;
}

export interface Rates { samples: number; noise: number; late: number; wrongSamples: number; wrong: number; explicitWrong: number; harsh: number }

/**
 * Outcome evidence since the last adjustment. Explicit feedback counts twice as much as inferred outcomes.
 * - noise: an automatic run that changed little, or "noise" feedback.
 * - late: a judged skip that already held most of the change a later run (within an hour) described, or
 *   one followed by a manual request; at most one skip per run, so skips that rightly let small changes
 *   accumulate are not blamed. Also "late" feedback.
 * - harsh: explicit feedback that removed entries were correct; it lowers the claim threshold directly.
 * - wrong: a run whose first draft had claims below the fixed default support, or "wrong" feedback. The
 *   tuned threshold does not feed this signal, so it cannot ratchet itself; inferred evidence alone moves
 *   the threshold at most one step above its default.
 */
export function outcomeRates(entries: LedgerEntry[], since: string | null): Rates {
  const recent = entries.filter((entry) => since === null || entry.at > since);
  const decisions = new Map(entries.filter((entry): entry is Decision => entry.kind === "decision").map((entry) => [entry.id, entry]));
  const runs = recent.filter((entry): entry is Run => entry.kind === "run" && entry.ok).sort((a, b) => a.at.localeCompare(b.at));
  const skips = recent.filter((entry): entry is Decision => entry.kind === "decision" && entry.action === "skip" && entry.judge !== "deterministic");
  let samples = skips.length, noise = 0, late = 0, wrongSamples = runs.length, wrong = 0, explicitWrong = 0, harsh = 0;
  const blamed = new Set<string>();
  for (const run of runs) {
    if (run.trigger === "auto") { samples += 1; if ((run.churn ?? 1) < 0.15) noise += 1; }
    if (run.unsupportedAtDefault > 0) wrong += 1;
    if (run.trigger !== "manual" && (run.churn ?? 0) < 0.5) continue;
    const earliest = new Date(Date.parse(run.at) - 60 * 60_000).toISOString();
    const skip = skips.filter((entry) => entry.at < run.at && entry.at >= earliest && !blamed.has(entry.id)).at(-1);
    if (!skip) continue;
    const runFiles = run.decision ? decisions.get(run.decision)?.signals.changedFiles ?? 0 : 0;
    if (run.trigger === "manual" || (skip.signals.changedFiles > 0 && skip.signals.changedFiles >= 0.7 * runFiles)) { late += 1; blamed.add(skip.id); }
  }
  for (const feedback of recent.filter((entry): entry is Feedback => entry.kind === "feedback")) {
    if (feedback.verdict === "wrong" || feedback.verdict === "useful") wrongSamples += 2;
    if (feedback.verdict === "wrong") { wrong += 2; explicitWrong += 1; continue; }
    if (feedback.verdict === "harsh") { harsh += 1; continue; }
    samples += 2;
    if (feedback.verdict === "noise") noise += 2;
    if (feedback.verdict === "late") late += 2;
  }
  return { samples, noise: samples ? noise / samples : 0, late: samples ? late / samples : 0, wrongSamples, wrong: wrongSamples ? wrong / wrongSamples : 0, explicitWrong, harsh };
}

/**
 * Bounded, evidence-gated tuning. Each signal needs at least five weighted samples since the last
 * adjustment, and each adjustment moves one step, so a burst of outcomes cannot swing it far. The
 * evidence window restarts only when a value actually changes.
 */
export function calibrate(tuning: Tuning, entries: LedgerEntry[], now: Date): Tuning {
  const rates = outcomeRates(entries, tuning.adjustedAt);
  const next: Tuning = { ...tuning, history: [...tuning.history] };
  const set = (field: keyof typeof BOUNDS, value: number, reason: string) => {
    const [low, high] = BOUNDS[field];
    const bounded = Math.round(Math.min(high, Math.max(low, value)) * 100) / 100;
    if (bounded === next[field]) return;
    next.history.push({ at: now.toISOString(), field, from: next[field], to: bounded, reason });
    next[field] = bounded;
  };
  if (rates.samples >= 5 && rates.noise >= 0.4 && rates.noise > rates.late) {
    const reason = `noise ${Math.round(rates.noise * 100)}% of ${rates.samples} samples`;
    set("gateThreshold", next.gateThreshold + 0.05, reason);
    set("debounceMinutes", next.debounceMinutes * 1.5, reason);
    set("minFiles", next.minFiles + 1, reason);
  } else if (rates.samples >= 5 && rates.late >= 0.3 && rates.late > rates.noise) {
    const reason = `late ${Math.round(rates.late * 100)}% of ${rates.samples} samples`;
    set("gateThreshold", next.gateThreshold - 0.05, reason);
    set("debounceMinutes", next.debounceMinutes / 1.5, reason);
    set("minFiles", next.minFiles - 1, reason);
  }
  // Raising the threshold cannot change the inferred signal (it is measured at the default), so inferred
  // evidence moves it at most one step above the default; only explicit "wrong" verdicts go further.
  const cap = rates.explicitWrong > 0 ? BOUNDS.verifyThreshold[1] : DEFAULT_TUNING.verifyThreshold + 0.05;
  // A human saying the check removed correct entries outweighs inferred evidence; it lowers the threshold.
  if (rates.harsh > rates.explicitWrong) set("verifyThreshold", next.verifyThreshold - 0.05, `${rates.harsh} "harsh" verdict${rates.harsh === 1 ? "" : "s"}: removed entries were correct`);
  else if (rates.wrongSamples >= 5 && rates.wrong >= 0.3 && next.verifyThreshold < cap) set("verifyThreshold", Math.min(cap, next.verifyThreshold + 0.05), `unsupported drafts ${Math.round(rates.wrong * 100)}% of ${rates.wrongSamples} samples`);
  else if (rates.wrongSamples >= 10 && rates.wrong < 0.1 && next.verifyThreshold > DEFAULT_TUNING.verifyThreshold) set("verifyThreshold", next.verifyThreshold - 0.05, `unsupported drafts ${Math.round(rates.wrong * 100)}% of ${rates.wrongSamples} samples`);
  if (next.history.length === tuning.history.length) return tuning;
  next.adjustedAt = now.toISOString();
  next.history = next.history.slice(-20);
  return next;
}
