import { CitationSchema, ROLES } from "@jevcode/contracts";
import type { Citation, NarrativeSentence, Role } from "@jevcode/contracts";

import type { CitationUniverse, DescribedComponent, GuardResult } from "./types.js";

export const PURPOSE_MAX_CHARS = 140;
export const SENTENCE_MAX_CHARS = 220;
export const MAX_CITATIONS = 6;

/** Interfaces §4: URLs, code fences, HTML tags, bold or underscore emphasis, headings. */
export const PLAIN_TEXT_REJECT = /https?:\/\/|```|<\/?[a-z][^>]*>|\*\*|__|^#{1,6}\s/im;

/**
 * Markdown and link forms PLAIN_TEXT_REJECT misses: inline code, [text](target),
 * any scheme://, www., javascript:/data:/vbscript:, list items and block quotes.
 */
export const MARKUP_EXTRA_REJECT =
  /`|\[[^\]]*\]\([^)]*\)|\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b(?:javascript|data|vbscript|mailto|file|tel|blob):|(?:^|\s)\/\/\S|<[!?]|^\s*(?:[-*+]|\d+[.)])\s|^\s*>/im;

export type GuardReason =
  | "shape"
  | "empty"
  | "too_long"
  | "markup"
  | "control_char"
  | "uncited"
  | "too_many_citations"
  | "unresolved_citation"
  | "unknown_id"
  | "duplicate_id"
  | "bad_role"
  | "names_other_component";

type Check<T> = { ok: true; value: T } | { ok: false; reason: GuardReason };

const fail = (reason: GuardReason): { ok: false; reason: GuardReason } => ({ ok: false, reason });

const ROLE_SET: ReadonlySet<string> = new Set<string>(ROLES);

const GENERIC_NAMES: ReadonlySet<string> = new Set<string>([
  ...ROLES,
  "src",
  "lib",
  "app",
  "apps",
  "packages",
  "root",
  "other",
  "test",
  "scripts",
  "docs",
  "core",
  "common",
  "shared",
  "utils",
]);

const NAME_CHAR = /[a-z0-9_@/-]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const INVISIBLE =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

/** Controls, format characters (bidi, zero-width, tags), surrogates, private use, separators, default-ignorables. */
export function hasControlOrInvisible(text: string): boolean {
  return INVISIBLE.test(text);
}

export function plainTextViolation(text: string): "control_char" | "markup" | null {
  if (hasControlOrInvisible(text)) return "control_char";
  const folded = text.normalize("NFKC");
  if (hasControlOrInvisible(folded)) return "control_char";
  if (PLAIN_TEXT_REJECT.test(folded) || MARKUP_EXTRA_REJECT.test(folded)) return "markup";
  return null;
}

export function citationResolves(citation: Citation, universe: CitationUniverse): boolean {
  switch (citation.kind) {
    case "component":
      return universe.components.has(citation.id);
    case "file":
      return universe.files.has(citation.id);
    case "decision":
      return universe.decisions.has(citation.id);
    case "fact":
      return universe.facts.has(citation.id);
    case "step":
      return universe.steps.has(citation.id);
  }
}

/** Whole-token, case-insensitive; skips the own name, names under 3 characters and generic names. */
export function mentionsOtherComponent(
  text: string,
  ownName: string | undefined,
  names: ReadonlySet<string>,
): boolean {
  const lower = text.toLowerCase();
  const own = ownName?.toLowerCase();
  for (const name of names) {
    const needle = name.toLowerCase();
    if (needle.length < 3 || needle === own || GENERIC_NAMES.has(needle)) continue;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at === -1) break;
      const before = at === 0 ? "" : lower.charAt(at - 1);
      const after = lower.charAt(at + needle.length);
      if (!NAME_CHAR.test(before) && !NAME_CHAR.test(after)) return true;
      from = at + 1;
    }
  }
  return false;
}

function checkText(raw: unknown, max: number): Check<string> {
  if (typeof raw !== "string") return fail("shape");
  const text = raw.trim();
  if (text.length === 0) return fail("empty");
  if (text.length > max) return fail("too_long");
  const violation = plainTextViolation(text);
  if (violation !== null) return fail(violation);
  return { ok: true, value: text };
}

function checkCitations(raw: unknown, universe: CitationUniverse): Check<Citation[]> {
  if (!Array.isArray(raw) || raw.length === 0) return fail("uncited");
  if (raw.length > MAX_CITATIONS) return fail("too_many_citations");
  const out: Citation[] = [];
  const seen = new Set<string>();
  for (const candidate of raw) {
    const parsed = CitationSchema.safeParse(candidate);
    if (!parsed.success || !citationResolves(parsed.data, universe)) return fail("unresolved_citation");
    const key = `${parsed.data.kind}\u0000${parsed.data.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: parsed.data.kind, id: parsed.data.id });
  }
  return { ok: true, value: out };
}

function checkComponent(
  item: unknown,
  universe: CitationUniverse,
  allowed: ReadonlySet<string>,
  seen: Set<string>,
): Check<DescribedComponent> {
  if (!isRecord(item) || typeof item.id !== "string") return fail("shape");
  const id = item.id;
  if (!allowed.has(id)) return fail("unknown_id");
  if (seen.has(id)) return fail("duplicate_id");
  seen.add(id);
  if (typeof item.role !== "string" || !ROLE_SET.has(item.role)) return fail("bad_role");
  const role = item.role as Role;
  const purpose = checkText(item.purpose, PURPOSE_MAX_CHARS);
  if (!purpose.ok) return purpose;
  const citations = checkCitations(item.citations, universe);
  if (!citations.ok) return citations;
  if (mentionsOtherComponent(purpose.value, universe.componentNameById?.get(id), universe.componentNames)) {
    return fail("names_other_component");
  }
  return { ok: true, value: { id, purpose: purpose.value, role, citations: citations.value } };
}

function checkSentence(item: unknown, universe: CitationUniverse): Check<NarrativeSentence> {
  if (!isRecord(item)) return fail("shape");
  const text = checkText(item.text, SENTENCE_MAX_CHARS);
  if (!text.ok) return text;
  const citations = checkCitations(item.citations, universe);
  if (!citations.ok) return citations;
  return { ok: true, value: { text: text.value, citations: citations.value } };
}

function finish<T>(accepted: T[], total: number, reasons: string[], emptyIsFailure: boolean): GuardResult<T[]> {
  const dropped = total - accepted.length;
  const discarded = total === 0 ? emptyIsFailure : dropped * 2 > total;
  if (total === 0 && emptyIsFailure) reasons.push("empty_output");
  if (discarded && total > 0) reasons.push("batch_discarded");
  return { accepted: discarded ? [] : accepted, dropped, total, discarded, reasons };
}

/** Spec §6.3 for describeComponents: schema, citations, role, names, plain text, caps, batch discard. */
export function guardComponents(
  described: unknown,
  universe: CitationUniverse,
  batchIds: readonly string[],
): GuardResult<DescribedComponent[]> {
  if (!Array.isArray(described)) {
    return { accepted: [], dropped: 0, total: 0, discarded: true, reasons: ["not_array"] };
  }
  const allowed = new Set(batchIds);
  const seen = new Set<string>();
  const accepted: DescribedComponent[] = [];
  const reasons: string[] = [];
  described.forEach((item: unknown, index) => {
    const checked = checkComponent(item, universe, allowed, seen);
    if (checked.ok) accepted.push(checked.value);
    else reasons.push(`${index}:${checked.reason}`);
  });
  return finish(accepted, described.length, reasons, batchIds.length > 0);
}

/** Spec §6.3 for narrative sentences: every sentence cites something that resolves. */
export function guardSentences(
  sentences: unknown,
  universe: CitationUniverse,
  opts: { max: number },
): GuardResult<NarrativeSentence[]> {
  if (!Array.isArray(sentences)) {
    return { accepted: [], dropped: 0, total: 0, discarded: true, reasons: ["not_array"] };
  }
  const considered: unknown[] = sentences.slice(0, Math.max(0, opts.max));
  const reasons: string[] = [];
  if (sentences.length > considered.length) reasons.push(`over_max:${sentences.length - considered.length}`);
  const accepted: NarrativeSentence[] = [];
  considered.forEach((item, index) => {
    const checked = checkSentence(item, universe);
    if (checked.ok) accepted.push(checked.value);
    else reasons.push(`${index}:${checked.reason}`);
  });
  return finish(accepted, considered.length, reasons, true);
}
