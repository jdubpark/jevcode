import type { NarrativeSentence } from "@jevcode/contracts";

import type { Chapter, Step, TraceSession } from "../model/index.js";
import type { TraceIndex } from "./trace-index.js";
import { briefArchitecture } from "./brief-architecture.js";

/** The Brief's three parts (spec §3.3, §8.4; interfaces §6.4). Lane 06 fills `architecture`, lane 07 adds the story `now`. */
export interface BriefModel {
  now:
    | { kind: "rule"; runningStepId: string | null; latestUnitId: string | null; pendingDecisionId: string | null }
    | { kind: "story"; sentences: NarrativeSentence[]; basisSeq: number; provenance?: "rule" | "model" };
  changes: { unitId: string; title: string; added: number; removed: number; tests: { passed: number; failed: number } | null; attention: boolean }[];
  architecture: { overviewSentences: NarrativeSentence[] | null; componentCount: number; touched: string[]; scanning: { done: number; total: number } | null } | null;
}

export type BriefChange = BriefModel["changes"][number];
export type BriefArchitecture = NonNullable<BriefModel["architecture"]>;

function compareNewest(a: Chapter, b: Chapter): number {
  return b.lastSeq - a.lastSeq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Current, non-noise chapters, newest first by lastSeq (ties by id). */
function shownChapters(session: TraceSession): Chapter[] {
  return session.chapters.filter((chapter) => chapter.current && !chapter.noise).sort(compareNewest);
}

/** The running step with the highest first seq on a live session; a pending decision is reported on its own. */
function runningStepOf(session: TraceSession): string | null {
  if (!session.live) return null;
  for (let i = session.steps.length - 1; i >= 0; i -= 1) {
    const step = session.steps[i];
    if (step !== undefined && step.status === "running" && step.kind !== "decision") return step.id;
  }
  return null;
}

/** The decision id of the latest decision step whose decision is still open. */
function pendingDecisionOf(session: TraceSession): string | null {
  for (let i = session.steps.length - 1; i >= 0; i -= 1) {
    const decision = session.steps[i]?.decision;
    if (decision !== undefined && decision.status === "open") return decision.decisionId;
  }
  return null;
}

function changeOf(chapter: Chapter, session: TraceSession, index: TraceIndex): BriefChange {
  // The viewer's anchor rulings (canvas-layout, overview-index, frame-label; ownsRunOutcome): a shared test run the unit
  // reaches only as a validation (validationOnlyStepIds) is not its own, so it gives neither test counts nor attention.
  const validationOnly = new Set<string>(chapter.validationOnlyStepIds ?? []);
  const own = new Set<string>(chapter.stepIds.filter((id) => !validationOnly.has(id)));
  const stepOf = (id: string): Step | undefined => {
    const entry = index.entry(id);
    return entry?.kind === "step" ? session.steps[entry.position] : undefined;
  };
  let added = 0;
  let removed = 0;
  let tests: BriefChange["tests"] = null;
  let testsSeq = -1;
  for (const id of new Set<string>([...chapter.stepIds, ...chapter.validationStepIds])) {
    if (validationOnly.has(id)) continue;
    const step = stepOf(id);
    if (step === undefined) continue;
    if (step.edit !== undefined && own.has(id)) {
      added += step.edit.added;
      removed += step.edit.removed;
    }
    if (step.tests !== undefined && step.firstSeq > testsSeq) {
      testsSeq = step.firstSeq;
      tests = { passed: step.tests.passed, failed: step.tests.failed };
    }
  }
  // The anchor rule: a warning or critical finding the chapter lists, pinned to one of the chapter's own steps.
  const attention = chapter.findingIds.some((id) => {
    const finding = index.findingsById.get(id);
    return finding !== undefined && finding.severity !== "info" && own.has(finding.anchorStepId);
  });
  return { unitId: chapter.id, title: chapter.shortTitle ?? chapter.title, added, removed, tests, attention };
}

/** Pure (spec §8.4): the rule-based Brief of phases A and B. `architecture` comes from the session's overview (null until a snapshot row arrives). */
export function buildBrief(session: TraceSession, index: TraceIndex): BriefModel {
  const chapters = shownChapters(session);
  return {
    now: {
      kind: "rule",
      runningStepId: runningStepOf(session),
      latestUnitId: chapters[0]?.id ?? null,
      pendingDecisionId: pendingDecisionOf(session),
    },
    changes: chapters.map((chapter) => changeOf(chapter, session, index)),
    architecture: briefArchitecture(session),
  };
}
