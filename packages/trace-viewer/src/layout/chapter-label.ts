import { chapterShortTitle, type Chapter, type TraceSession, type UnitStableId } from "../model/index.js";

/** A title chapterShortTitle reads as semantic-core's placeholder, so it returns the files label (spec §6.6). */
const FILES_ONLY_TITLE = "Changed 0 files";

const bornCache = new WeakMap<TraceSession, ReadonlySet<UnitStableId>>();

/**
 * Chapters born from a decision (spec §7.1 one-row rule, the rule `bornChapters` in model/format.ts applies): for each
 * decision step in order, the earliest current, non-noise chapter of the same turn that lists the decision and starts
 * at or after it, unless an earlier decision already took it. One pass per finalized session.
 */
export function decisionBornChapters(session: TraceSession): ReadonlySet<UnitStableId> {
  const cached = bornCache.get(session);
  if (cached !== undefined) return cached;
  const born = new Set<UnitStableId>();
  for (const step of session.steps) {
    const decisionId = step.decision?.decisionId;
    if (step.kind !== "decision" || decisionId === undefined) continue;
    const stableId = `decision:${decisionId}`;
    const nextTurnT = session.turns[step.turnIndex + 1]?.tMs ?? Number.POSITIVE_INFINITY;
    let first: Chapter | undefined;
    for (const chapter of session.chapters) {
      if (!chapter.current || chapter.noise || born.has(chapter.id)) continue;
      if (chapter.tMs < step.tMs || chapter.tMs >= nextTurnT || !chapter.decisionIds.some((id) => id === stableId)) continue;
      if (first === undefined || chapter.tMs < first.tMs) first = chapter;
    }
    if (first !== undefined) born.add(first.id);
  }
  bornCache.set(session, born);
  return born;
}

/**
 * The short label a chapter row or frame shows beside its decision (raw; render through displayUntrusted). A chapter
 * born from a decision tends to restate the decision's title ("Account-linking policy…" twice on oauth), so where its
 * decision is shown at the same level (every Canvas level, the Session-level spine) it reads its category and focus
 * file instead ("Security · service", spec §6.6), and the decision alone carries the title. Otherwise
 * `shortTitle ?? title`. The full title stays the tooltip and the accessible name.
 */
export function chapterLabel(chapter: Chapter, session: TraceSession): string {
  if (decisionBornChapters(session).has(chapter.id)) {
    return chapterShortTitle({ title: FILES_ONLY_TITLE, category: chapter.category, files: chapter.files });
  }
  return chapter.shortTitle ?? chapter.title;
}
