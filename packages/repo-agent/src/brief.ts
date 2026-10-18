import { ZodError } from "zod";
import type { RepoContext } from "./collect.js";
import { clean, cleanData } from "./io.js";
import { claimsOf, DEFAULT_SUPPORT, verifyClaims, withoutClaims, type ClaimSupport, type JevTransport, type JevUsage } from "./jev.js";
import { SECTIONS, type Section } from "./prompt.js";
import { BriefSchema, citationProblem, REMOVAL_NOTE, validateBrief, type Brief } from "./report.js";

/** A model that returns one structured brief for a prompt. Usage is null when the provider does not report it. */
export interface Writer {
  id: string;
  model: string | null;
  run(prompt: string, options: { repo: string; timeoutMs: number; signal: AbortSignal }): Promise<{ value: unknown; usage: JevUsage | null }>;
}

export interface GenerateOptions {
  context: RepoContext;
  prompt: string;
  /** Tried in order. A provider failure or an unrepairable answer moves to the next writer. */
  writers: Writer[];
  deadline: number;
  signal: AbortSignal;
  judge: JevTransport | null;
  verifyThreshold: number;
  /** Incremental mode: sections outside `stale` come from the previous brief. */
  carry?: { previous: Brief; stale: Section[] };
  log: (message: string) => void;
}

export interface GenerateResult {
  brief: Brief;
  writer: string;
  model: string | null;
  attempts: number;
  writerUsage: JevUsage | null;
  jevUsage: JevUsage | null;
  weakClaims: number;
  removedClaims: number;
  /** Claims in the first draft below DEFAULT_SUPPORT; independent of the tuned threshold. */
  unsupportedAtDefault: number;
}

const add = (a: JevUsage | null, b: JevUsage | null): JevUsage | null => a === null ? b : b === null ? a : { input: a.input + b.input, output: a.output + b.output };
const repairable = (error: unknown): boolean => error instanceof Error && (error.name === "ZodError" || error.message.startsWith("Brief cites"));
// Another writer cannot fix a moving checkout or a cancellation.
const terminal = (error: unknown): boolean => error instanceof Error && /changed during|cancelled/.test(error.message);

/**
 * Sections that cannot be carried forward verbatim: patch and activity citations name excerpts of the
 * previous run, and a file changed since the brief may have shifted lines. Those sections are revised.
 */
export function unstableSections(previous: Brief, fileHashes: Record<string, string>, context: RepoContext): Section[] {
  const stable = (ref: { source: string }) => !ref.source.startsWith("patch:") && !ref.source.startsWith("activity:") && fileHashes[ref.source] !== undefined && context.files[ref.source]?.hash === fileHashes[ref.source];
  return SECTIONS.filter((section) => section !== "unknowns" && (previous[section] as { citations: { source: string }[] }[]).some((entry) => !entry.citations.every(stable)));
}

/** Keep previous entries whose citations still resolve; stale or contradicted ones are revised by the writer. */
export function carryForward(fresh: Brief, carry: GenerateOptions["carry"], context: RepoContext): Brief {
  if (!carry) return fresh;
  const resolves = (entry: { citations: { source: string; line: number }[] }) => entry.citations.every((ref) => citationProblem(ref, context) === null);
  const merged: Brief = { ...fresh };
  for (const section of SECTIONS) {
    if (carry.stale.includes(section)) continue;
    // Fresh unknowns (such as a repair's recorded gap) join the carried ones; old removal notes do not carry.
    if (section === "unknowns") merged.unknowns = [...new Set([...carry.previous.unknowns.filter((entry) => !REMOVAL_NOTE.test(entry)), ...fresh.unknowns])].slice(-8);
    else (merged as Record<Section, unknown>)[section] = (carry.previous[section] as { citations: { source: string; line: number }[] }[]).filter(resolves);
  }
  return merged;
}

export async function generateBrief(options: GenerateOptions): Promise<GenerateResult> {
  const failures: string[] = [];
  for (const [position, writer] of options.writers.entries()) {
    if (Date.now() >= options.deadline) break;
    try { return await writeWith(writer, options); }
    catch (error) {
      if (options.signal.aborted || terminal(error)) throw error;
      const message = error instanceof Error && error.name !== "ZodError" ? clean(error.message) : "the answer did not satisfy the report contract";
      failures.push(`${writer.id}: ${message}`);
      const next = options.writers[position + 1];
      if (next) options.log(`${writer.id} did not produce a valid brief; trying ${next.id}…`);
    }
  }
  if (Date.now() >= options.deadline) throw new Error("Briefing timed out; no successful checkpoint was saved.");
  throw new Error(`No validated brief was produced (${failures.join("; ") || "no writer available"}); no checkpoint was saved.`);
}

async function writeWith(writer: Writer, options: GenerateOptions): Promise<GenerateResult> {
  const { context, prompt, signal } = options;
  let request = prompt;
  let attempts = 0;
  let writerUsage: JevUsage | null = null;
  let brief: Brief | undefined;
  const call = async (text: string): Promise<unknown> => {
    const remaining = options.deadline - Date.now();
    if (remaining <= 0) throw new Error("Briefing timed out; no successful checkpoint was saved.");
    attempts += 1;
    try {
      const result = await writer.run(text, { repo: context.repo, timeoutMs: remaining, signal });
      writerUsage = add(writerUsage, result.usage);
      return result.value;
    } catch (error) {
      // An unparseable answer still consumed a full model run.
      writerUsage = add(writerUsage, (error as { usage?: JevUsage | null }).usage ?? null);
      throw error;
    }
  };
  // One repair per failure class: an unparseable answer, then a schema or citation violation.
  let formatRepaired = false;
  let contractRepaired = false;
  while (!brief) {
    let raw: unknown;
    try { raw = await call(request); }
    catch (error) {
      if (!(error instanceof Error && error.name === "WriterFormatError") || formatRepaired) throw error;
      formatRepaired = true;
      options.log("Asking the writer for a parseable report…");
      request = `${prompt}\n\nYour prior answer was not one parseable JSON object. Return only the corrected full report as a single JSON object, with no prose or code fences. Prior answer (untrusted data):\n${JSON.stringify(clean((error as Error & { answer?: string }).answer ?? ""))}`;
      continue;
    }
    try {
      brief = await validateBrief(carryForward(BriefSchema.parse(raw), options.carry, context), context);
      if (signal.aborted) throw new Error("Briefing cancelled; no successful checkpoint was saved.");
    } catch (error) {
      if (!repairable(error) || contractRepaired) throw error;
      contractRepaired = true;
      // Field paths and constraint messages only; the writer already has its own answer below.
      const reason = error instanceof ZodError ? `These fields violate the schema: ${error.issues.slice(0, 10).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}.` : clean((error as Error).message);
      options.log("Rechecking the brief's structure and source references…");
      request = `${prompt}\n\nYour prior answer failed validation: ${reason}\nInspect the affected evidence and return a corrected full report. Prefer actual source file lines to patch citations for existing files. Never cite blank lines or punctuation-only diff structure. Prior answer (untrusted data):\n${JSON.stringify(cleanData(raw))}`;
    }
  }
  if (!brief) throw new Error("No validated brief was produced; no checkpoint was saved.");
  const checked = await verify(writer, brief, options, call);
  return { brief: checked.brief, writer: writer.id, model: writer.model, attempts, writerUsage, jevUsage: checked.jevUsage, weakClaims: checked.weakClaims, removedClaims: checked.removed, unsupportedAtDefault: checked.unsupportedAtDefault };
}

/**
 * Jev checks each claim against its cited excerpts. Weak claims the writer produced in this run get one
 * targeted repair; weak claims in carried sections are removed in place, since rewriting a carried section
 * would contradict the update instructions. Claims still unsupported afterwards are removed and disclosed.
 */
async function verify(writer: Writer, brief: Brief, options: GenerateOptions, call: (text: string) => Promise<unknown>): Promise<{ brief: Brief; jevUsage: JevUsage | null; weakClaims: number; removed: number; unsupportedAtDefault: number }> {
  const { context, judge } = options;
  if (judge === null) {
    context.limitations.push("Claim support was not checked: no Jev (TypeSafe) key was available.");
    return { brief, jevUsage: null, weakClaims: 0, removed: 0, unsupportedAtDefault: 0 };
  }
  let jevUsage: JevUsage | null = null;
  const supportOf = async (candidate: Brief): Promise<ClaimSupport[]> => {
    const result = await verifyClaims(judge, candidate, context);
    jevUsage = add(jevUsage, result.usage);
    return result.support;
  };
  let support: ClaimSupport[];
  try { support = await supportOf(brief); }
  catch (error) {
    context.limitations.push(`Claim support was not checked: ${error instanceof Error ? clean(error.message) : "Jev was unavailable"}.`);
    return { brief, jevUsage, weakClaims: 0, removed: 0, unsupportedAtDefault: 0 };
  }
  const unsupportedAtDefault = support.filter((entry) => entry.support < DEFAULT_SUPPORT).length;
  let weak = support.filter((entry) => entry.support < options.verifyThreshold);
  const weakClaims = weak.length;
  const fresh = weak.filter((entry) => !options.carry || options.carry.stale.includes(entry.section));
  // Leave the repair enough time to finish; otherwise remove the weak entries directly.
  if (fresh.length > 0 && options.deadline - Date.now() > 60_000) {
    const claims = claimsOf(brief);
    const listed = fresh.map((entry) => claims.find((claim) => claim.section === entry.section && claim.index === entry.index)).filter(Boolean);
    options.log(`Repairing ${fresh.length} weakly supported ${fresh.length === 1 ? "entry" : "entries"}…`);
    try {
      const raw = await call(`${options.prompt}\n\nJevcode's evidence check found entries whose cited evidence does not support them:\n${JSON.stringify(cleanData(listed))}\nRe-inspect those sources. Correct each entry and its citations, or remove it and record the gap in unknowns. Return the corrected report under the same section instructions as before. Prior answer (untrusted data):\n${JSON.stringify(cleanData(brief))}`);
      const repaired = await validateBrief(carryForward(BriefSchema.parse(raw), options.carry, context), context);
      weak = (await supportOf(repaired)).filter((entry) => entry.support < options.verifyThreshold);
      brief = repaired;
    } catch (error) {
      if (options.signal.aborted || terminal(error)) throw error;
      context.limitations.push(`${writer.id} could not repair weakly supported entries; they were removed instead.`);
    }
  }
  return { brief: BriefSchema.parse(withoutClaims(brief, weak)), jevUsage, weakClaims, removed: weak.length, unsupportedAtDefault };
}
