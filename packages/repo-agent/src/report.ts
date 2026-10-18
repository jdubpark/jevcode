import path from "node:path";
import { z } from "zod";
import { assertContextUnchanged, type RepoContext } from "./collect.js";
import { clean, cleanData } from "./io.js";

const citation = z.object({ source: z.string().min(1).max(1024), line: z.number().int().positive() }).strict();
const citations = z.array(citation).min(1).max(6);
const sentence = z.string().min(1).max(900);
const statement = z.object({ text: sentence, citations }).strict();
export const BriefSchema = z.object({
  summary: z.string().min(1).max(600),
  architecture: z.array(statement).max(6),
  review: z.array(z.object({ priority: z.enum(["high", "medium"]), area: z.string().min(1).max(150), why: sentence, question: sentence, citations }).strict()).max(5),
  changes: z.array(statement).max(6),
  checks: z.array(statement).max(4),
  guidance: z.array(z.object({ text: sentence, basis: z.enum(["documented", "proposed"]), citations }).strict()).max(4),
  unknowns: z.array(sentence).max(8),
}).strict();
export type Brief = z.infer<typeof BriefSchema>;

const string = { type: "string" };
const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const array = (items: unknown) => ({ type: "array", items });
const references = array(object({ source: string, line: { type: "integer" } }));
const claim = object({ text: string, citations: references });
/** Codex's structured final answer contract; the stricter runtime schema also enforces bounds. */
export const BRIEF_JSON_SCHEMA = object({
  summary: string,
  architecture: array(claim),
  review: array(object({ priority: { enum: ["high", "medium"], type: "string" }, area: string, why: string, question: string, citations: references })),
  changes: array(claim), checks: array(claim),
  guidance: array(object({ text: string, basis: { enum: ["documented", "proposed"], type: "string" }, citations: references })),
  unknowns: array(string),
});

/** Source existence and freshness checks are not semantic proof that a claim follows from its citation. */
export async function validateBrief(value: unknown, context: RepoContext): Promise<Brief> {
  const report = BriefSchema.parse(value);
  for (const item of [...report.architecture, ...report.review, ...report.changes, ...report.checks, ...report.guidance]) {
    for (const ref of item.citations) {
      if (ref.source.startsWith("activity:")) {
        if (!context.activity.some((log) => log.source === ref.source && log.records.some((entry) => entry.line === ref.line))) {
          throw new Error(`Brief cites unavailable activity: ${ref.source}:${ref.line}`);
        }
      } else if (ref.source.startsWith("patch:")) {
        const patch = context.patches.find((entry) => entry.source === ref.source);
        if (!patch || ref.line > patch.text.split("\n").length) throw new Error("Brief cites an unavailable change excerpt.");
        if (!/[\p{L}\p{N}]{3}/u.test(patch.text.split("\n")[ref.line - 1] ?? "")) throw new Error("Brief cites a blank or structural patch line. Cite the relevant code or document line instead.");
      } else {
        const file = context.files[ref.source];
        if (!file || ref.line > file.lines) throw new Error(`Brief cites unavailable source: ${ref.source}:${ref.line}`);
      }
    }
  }
  // Do not let model text reintroduce recognizable credentials into output or persisted summaries.
  await assertContextUnchanged(context);
  return BriefSchema.parse(cleanData(report));
}

const prose = (text: string): string => clean(text).replace(/[\r\n]+/g, " ").replace(/[<>[\]*_`]/g, "\\$&");

/** Keep non-file citations inspectable after the original log or working diff changes. */
interface EvidenceExcerpt { source: string; line: number; path: string | null; text: string }

export function referencedEvidence(report: Brief, context: RepoContext): EvidenceExcerpt[] {
  const references = [...report.architecture, ...report.review, ...report.changes, ...report.checks, ...report.guidance].flatMap((item) => item.citations);
  const unique = new Map(references.map((ref) => [`${ref.source}:${ref.line}`, ref]));
  return [...unique.values()].flatMap<EvidenceExcerpt>((ref) => {
    const patch = context.patches.find((entry) => entry.source === ref.source);
    if (patch) return [{ ...ref, path: patch.path, text: patch.text.split("\n")[ref.line - 1] ?? "" }];
    const record = context.activity.find((log) => log.source === ref.source)?.records.find((entry) => entry.line === ref.line);
    return record ? [{ ...ref, path: null, text: record.text }] : [];
  });
}

export function renderBrief(report: Brief, context: RepoContext): string {
  const refs = (items: z.infer<typeof citation>[]): string => items.map((ref) => {
    if (ref.source.startsWith("activity:") || ref.source.startsWith("patch:")) return `[^${ref.source.replace(":", "-")}-${ref.line}]`;
    const target = path.join(context.repo, ref.source).split(path.sep).map(encodeURIComponent).join("/");
    return `[${prose(ref.source)}:${ref.line}](${target}:${ref.line})`;
  }).join(" ");
  const lines = [prose(report.summary), "", `Repository: ${prose(context.repo)} · Base: ${context.base?.slice(0, 12) ?? "initial working tree"} · Head: ${context.head?.slice(0, 12) ?? "unborn"}`, ""];
  const section = (title: string, entries: string[]) => { if (entries.length) lines.push(`## ${title}`, "", ...entries.map((entry) => `- ${entry}`), ""); };
  section("System shape", report.architecture.map((entry) => `${prose(entry.text)} ${refs(entry.citations)}`));
  section("Review first", report.review.map((entry) => `**${prose(entry.area)} (${entry.priority}).** ${prose(entry.why)} **Review:** ${prose(entry.question)} ${refs(entry.citations)}`));
  section("What changed", report.changes.map((entry) => `${prose(entry.text)} ${refs(entry.citations)}`));
  section("Available check evidence", report.checks.map((entry) => `${prose(entry.text)} ${refs(entry.citations)}`));
  section("Guide the agents", report.guidance.map((entry) => `**${entry.basis}.** ${prose(entry.text)} ${refs(entry.citations)}`));
  section("Open questions", report.unknowns.map(prose));
  section("Coverage", context.limitations.map(prose));
  for (const evidence of referencedEvidence(report, context)) {
    lines.push(`[^${evidence.source.replace(":", "-")}-${evidence.line}]: ${evidence.path ? prose(evidence.path) + ", " : "Supplied activity, "}line ${evidence.line}: ${prose(evidence.text)}`, "");
  }
  return lines.join("\n").trimEnd() + "\n";
}
