import type { Citation } from "@jevcode/contracts";

import { displayUntrusted, overviewStatusOf, type OverviewModel } from "../../../model/index.js";

/** Ruling R3 narrator states in quiet words (spec §6.6: never an error banner); "ready" says nothing. */
const NARRATOR_WORD = { off: "Descriptions off", unavailable: "Descriptions unavailable", pending: "Descriptions pending" } as const;

/** The rule-based header (spec §3.4): "12 components" with up to three languages by file count beside it in muted ink. */
export function overviewHeadline(overview: OverviewModel): { count: string; languages: string | null } {
  const snapshot = overview.snapshot;
  const n = snapshot.components.length;
  const languages = snapshot.counts.languages.slice(0, 3).map((language) => displayUntrusted(language));
  return {
    count: `${n.toLocaleString("en-US")} ${n === 1 ? "component" : "components"}`,
    languages: languages.length === 0 ? null : languages.join(" · "),
  };
}

/**
 * `marker: true` is a citation the sentence does not spell out: the Map header draws it as a quiet footnote-style marker
 * after the sentence's closing punctuation, never as sentence text.
 */
export type SentencePart = { text: string } | { text: string; componentId: string; marker?: true };

const isWordChar = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}_]/u.test(char);

/** First whole-word, case-insensitive occurrence of `needle` in `haystack` (both lower-cased) that overlaps no taken span; -1 when none. */
function findWord(haystack: string, needle: string, taken: readonly { start: number; end: number }[]): number {
  if (needle === "") return -1;
  for (let from = 0; ; ) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return -1;
    const end = at + needle.length;
    const clear = !isWordChar(haystack[at - 1]) && !isWordChar(haystack[end]) && !taken.some((span) => at < span.end && end > span.start);
    if (clear) return at;
    from = at + 1;
  }
}

/**
 * A narrator sentence as plain text with its cited components as links (the approved Map header: "component names are
 * quiet links"). A cited name is linked where it first appears as a whole word, ignoring case; a name the sentence
 * does not spell out is appended after it as a marker part (a footnote-style citation, not sentence text). File citations and components missing from the map are skipped
 * (the Map header no longer uses citation chips). The sentence and every name pass through displayUntrusted first.
 */
export function linkSentence(sentence: { text: string; citations: readonly Citation[] }, overview: OverviewModel): SentencePart[] {
  const text = displayUntrusted(sentence.text);
  const lower = text.toLowerCase();
  const aligned = lower.length === text.length; // a few characters change length when lower-cased; then nothing links inline
  const found: { start: number; end: number; id: string }[] = [];
  const trailing: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const citation of sentence.citations) {
    if (citation.kind !== "component" || seen.has(citation.id)) continue;
    seen.add(citation.id);
    const component = overview.componentById.get(citation.id);
    if (component === undefined) continue;
    const name = displayUntrusted(component.name);
    const at = aligned ? findWord(lower, name.toLowerCase(), found) : -1;
    if (at < 0) trailing.push({ id: component.id, name });
    else found.push({ start: at, end: at + name.length, id: component.id });
  }
  found.sort((a, b) => a.start - b.start);
  const parts: SentencePart[] = [];
  let cursor = 0;
  for (const hit of found) {
    if (hit.start > cursor) parts.push({ text: text.slice(cursor, hit.start) });
    parts.push({ text: text.slice(hit.start, hit.end), componentId: hit.id });
    cursor = hit.end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  for (const link of trailing) parts.push({ text: link.name, componentId: link.id, marker: true });
  return parts;
}

/** Spec §3.4 and E14: "Imports not analyzed for Python" when some components have no supported grammar. */
export function notAnalyzedNote(overview: OverviewModel): string | null {
  const languages = new Set<string>();
  let unnamed = false;
  for (const component of overview.snapshot.components) {
    if (component.importsAnalyzed) continue;
    if (component.language === null) unnamed = true;
    else languages.add(displayUntrusted(component.language));
  }
  const list = [...languages].sort();
  if (list.length === 0 && unnamed) list.push("some files");
  return list.length === 0 ? null : `Imports not analyzed for ${list.join(", ")}`;
}

/** Spec §5.1: past the 20,000-file cap the map is partial, with the counts (counts.totalFiles, ruling R3, when known). */
export function partialNote(overview: OverviewModel): string | null {
  const { partial, counts } = overview.snapshot;
  if (!partial) return null;
  const files = counts.files.toLocaleString("en-US");
  return counts.totalFiles === undefined
    ? `Partial map · ${files} files mapped`
    : `Partial map · ${files} of ${counts.totalFiles.toLocaleString("en-US")} files`;
}

/** Ruling R3 narrator state as a quiet note; null when the narrator is ready. */
export function narratorNote(overview: OverviewModel): string | null {
  const narrator = overviewStatusOf(overview.snapshot).narrator;
  return narrator === "ready" ? null : NARRATOR_WORD[narrator];
}

export interface ScanNote {
  state: "running" | "failed";
  text: string;
  /** A running scan's files read and files to read, for its progress bar; null when failed. */
  progress: { scanned: number; total: number } | null;
  /** The failure message, untrusted, for the tooltip only. */
  detail: string | null;
}

/** Ruling R3 scan state (spec §6.1 progress, §6.6 failure); null when the scan is done. */
export function scanNote(overview: OverviewModel): ScanNote | null {
  const scan = overviewStatusOf(overview.snapshot).scan;
  if (scan.state === "running") {
    return {
      state: "running",
      text: `Mapping codebase · ${scan.scanned.toLocaleString("en-US")} / ${scan.total.toLocaleString("en-US")} files`,
      progress: { scanned: scan.scanned, total: scan.total },
      detail: null,
    };
  }
  if (scan.state === "failed") {
    return { state: "failed", text: "Codebase map unavailable", progress: null, detail: scan.error === undefined ? null : displayUntrusted(scan.error) };
  }
  return null;
}
