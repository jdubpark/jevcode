import { bornChapters, chapterFilesLabel, type Chapter, type TraceSession } from "../model/index.js";

/**
 * The short label a chapter row or frame shows beside its decision (raw; render through displayUntrusted). A chapter
 * born from a decision (`bornChapters`, spec §7.1 one-row rule) tends to restate the decision's title ("Account-linking
 * policy…" twice on oauth), so where its decision is shown at the same level (every Canvas level, the Session-level
 * spine) it reads its category and focus file instead ("Security · service", spec §6.6), and the decision alone carries
 * the title. Otherwise `shortTitle ?? title`. The full title stays the tooltip and the accessible name.
 */
export function chapterLabel(chapter: Chapter, session: TraceSession): string {
  if (bornChapters(session).has(chapter.id)) return chapterFilesLabel(chapter);
  return chapter.shortTitle ?? chapter.title;
}
