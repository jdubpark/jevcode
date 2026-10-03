import type { SelectionId, TraceIndex } from "../../layout/trace-index.js";
import { displayUntrusted, formatOffset, type Step, type StepId, type TraceSession } from "../../model/index.js";
import { selectionTitle, topFindingOf } from "./finding-copy.js";

export interface ReviewNote {
  markdown: string;
  firstLine: string;
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return longest;
}

/** Backticks one longer than the longest run in text, minimum 3. */
export function fenceFor(text: string): string {
  return "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
}

function oneLine(text: string): string {
  return text.replace(/\r\n|[\r\n\u2028\u2029]/g, "⏎");
}

/** Inline code delimited by a run longer than any inside; \r and \n show as ⏎. */
export function inlineCode(text: string): string {
  const flat = oneLine(text);
  const delimiter = "`".repeat(longestBacktickRun(flat) + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return `${delimiter}${pad}${flat}${pad}${delimiter}`;
}

function firstLineOf(text: string): string {
  const end = text.search(/[\r\n\u2028\u2029]/);
  return end < 0 ? text : text.slice(0, end);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Spec §7.1 "Review note". */
export function buildReviewNote(session: TraceSession, index: TraceIndex, selection: SelectionId): ReviewNote {
  const entry = index.entry(selection);
  const chapter = entry?.kind === "chapter" ? session.chapters[entry.position] : undefined;
  const step = entry?.kind === "step" ? session.steps[entry.position] : undefined;
  const stepById = new Map<StepId, Step>(session.steps.map((item) => [item.id, item]));
  const title = oneLine(selectionTitle(session, index, selection)).replace(/"/g, "'");
  const tMs = step?.tMs ?? chapter?.tMs ?? 0;
  const firstSeq = step?.firstSeq ?? chapter?.firstSeq ?? entry?.firstSeq ?? 0;
  const finding = step === undefined ? null : topFindingOf(session, step);
  const own = new Set(step?.seqs ?? []);
  const sourceSeqs = finding !== null ? finding.evidenceSeqs : step !== undefined ? step.evidenceSeqs : (chapter?.factSeqs ?? []);
  const evidenceSeqs = unique(sourceSeqs.filter((seq) => !own.has(seq))).sort((a, b) => a - b);

  const firstLine = `Re: trace ${session.meta.sessionId} ${formatOffset(tMs)} "${title}" (seq ${firstSeq}${
    evidenceSeqs.length > 0 ? `; evidence seq ${evidenceSeqs.join(", ")}` : ""
  })`;
  const lines = [firstLine, `Session: ${displayUntrusted(oneLine(session.meta.repoName))} / ${displayUntrusted(firstLineOf(session.meta.prompt))}`];

  const isClaimStep = step !== undefined && session.turns.some((turn) => turn.claimStepId === step.id);
  const claimText = finding?.claim?.claim.text ?? (isClaimStep ? step?.text : undefined);
  if (claimText !== undefined && claimText.length > 0) {
    const fence = fenceFor(claimText);
    lines.push("Claim:", fence, displayUntrusted(claimText, { multiline: true }), fence);
  }

  const evidenceSteps = (finding?.evidenceStepIds ?? [])
    .map((id) => stepById.get(id))
    .filter((item): item is Step => item !== undefined);
  if (evidenceSteps.length > 0) {
    lines.push(`Observed: ${evidenceSteps.map((item) => inlineCode(displayUntrusted(item.headline))).join("; ")}`);
  }

  const paths = unique([
    ...(step?.edit === undefined ? [] : [step.edit.path]),
    ...(chapter?.files ?? []),
    ...[step, ...evidenceSteps].flatMap((item) => item?.tests?.failures.map((failure) => failure.file) ?? []),
  ]);
  if (paths.length > 0) lines.push(`Paths: ${paths.map((path) => inlineCode(displayUntrusted(path))).join(", ")}`);

  return { markdown: lines.join("\n"), firstLine };
}
