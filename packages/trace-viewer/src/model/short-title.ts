import type { ChangeCategory } from "@jevcode/contracts";

import { isLockfilePath } from "./registry.js";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
}

/** Longest Chapter.shortTitle, in graphemes. */
export const SHORT_TITLE_MAX = 24;

/** semantic-core's buildPlaceholderTitle: "Changed N file(s): a, b, c" or "Changed 0 files". Replay
 *  runs no LLM titler, so these reach the bundle as unit titles. */
const PLACEHOLDER_TITLE = /^Changed \d+ files?(?::|$)/;

export function isPlaceholderTitle(title: string): boolean {
  return PLACEHOLDER_TITLE.test(title.trim());
}

const CATEGORY_NOUN: { readonly [C in ChangeCategory]: string } = {
  behavior: "Behavior",
  architecture: "Architecture",
  api: "API",
  schema: "Migration",
  dependency: "Package",
  security: "Security",
  configuration: "Config",
  performance: "Performance",
  implementation: "Code",
  tests: "Tests",
  documentation: "Docs",
};

/** Whitespace that is not a C0 control: \n, \v, \f and \r are shown as ⟨U+XXXX⟩ tokens at render
 *  (displayUntrusted), so folding or trimming them here would hide them (lane review I-1). */
const SPACES = /[^\S\n\v\f\r]+/gu;
const EDGE_SPACES = /^[^\S\n\v\f\r]+|[^\S\n\v\f\r]+$/gu;
const TRAILING_PUNCT = /(?:[,;:.·–—-]|[^\S\n\v\f\r])+$/u;

/** Cuts to max graphemes with a trailing "…", at the last space when that keeps at least half. */
function clipTitle(text: string, max: number): string {
  // A grapheme holds at least one UTF-16 code unit, so a text this short has at most max graphemes.
  if (text.length <= max) return text;
  const parts = graphemes(text);
  if (parts.length <= max) return text;
  let head = parts.slice(0, max - 1).join("");
  const space = head.lastIndexOf(" ");
  if (space >= max / 2) head = head.slice(0, space);
  return `${head.replace(TRAILING_PUNCT, "")}…`;
}

/** Basename up to its first dot, without a leading sequence number or a migration verb:
 *  "migrations/001_create_identities.sql" → "identities", "tests/auth/oauth.test.ts" → "oauth". */
function focusStem(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.indexOf(".", 1);
  const bare = dot > 0 ? base.slice(0, dot) : base;
  const stem = bare.replace(/^\d+[_-]*/, "").replace(/^(?:create|add|alter|drop|update|remove|rename)[_-]+/i, "");
  return stem !== "" ? stem : bare;
}

/**
 * A short label for agent prose (a real chapter title, a decision title): its first clause, cut at a word to at most
 * SHORT_TITLE_MAX graphemes. Control characters are kept for displayUntrusted to show; they never end a clause.
 */
export function shortenTitle(text: string): string {
  const title = text.replace(EDGE_SPACES, "").replace(SPACES, " ");
  const clause = /^(.{8,}?)(?:[:;.] | [—–-] |, | \(|\.$)/u.exec(title)?.[1] ?? title;
  return clipTitle(clause, SHORT_TITLE_MAX);
}

/**
 * Chapter.shortTitle (spec §6.6 "Short titles"), at most SHORT_TITLE_MAX graphemes. A placeholder
 * title becomes the category noun and the focus file's stem ("Tests · oauth", "Migration ·
 * identities"): the focus file is the first file that is not a lockfile; a chapter of lockfiles
 * only is "Lockfile"; a dependency chapter or one without files is the noun alone ("Package").
 * Any other title is trimmed to its first clause and cut at a word.
 */
export function chapterShortTitle(input: { title: string; category: ChangeCategory; files: readonly string[] }): string {
  // Graphemes are cut whole and control characters are kept, so a later displayUntrusted token is never split.
  const title = input.title.replace(EDGE_SPACES, "").replace(SPACES, " ");
  if (!isPlaceholderTitle(title)) return shortenTitle(title);
  const focus = input.files.find((file) => !isLockfilePath(file));
  if (focus === undefined && input.files.length > 0) return "Lockfile";
  const noun = CATEGORY_NOUN[input.category];
  if (focus === undefined || input.category === "dependency") return noun;
  return clipTitle(`${noun} · ${focusStem(focus)}`, SHORT_TITLE_MAX);
}
