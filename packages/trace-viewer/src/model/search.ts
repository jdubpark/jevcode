import type { StepId, TraceSession } from "./types.js";

export interface SearchIndex {
  readonly entries: ReadonlyArray<{ id: StepId; haystack: string }>;
}

const TEXT_LIMIT = 8 * 1024;

/** One lower-cased haystack per step: headline, target, text (first 8 KiB), command, edit path,
 *  test failure names. No stdout (the model never holds it). */
export function buildSearchIndex(session: TraceSession): SearchIndex {
  return {
    entries: session.steps.map((step) => {
      const parts = [
        step.headline,
        step.target ?? "",
        (step.text ?? "").slice(0, TEXT_LIMIT),
        step.command?.command ?? "",
        step.edit?.path ?? "",
        ...(step.tests?.failures.map((failure) => failure.testName) ?? []),
      ];
      return { id: step.id, haystack: parts.join("\n").toLowerCase() };
    }),
  };
}

/** Lower-cased whitespace-split terms; every term must match; ids in step order. */
export function searchSteps(index: SearchIndex, query: string): StepId[] {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term !== "");
  if (terms.length === 0) return [];
  return index.entries.filter((entry) => terms.every((term) => entry.haystack.includes(term))).map((entry) => entry.id);
}
