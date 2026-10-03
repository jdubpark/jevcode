import type { NarrativeSentence } from "@jevcode/contracts";

import type { Chapter, Entity, Finding, Step, StepId, TraceSession } from "../model/index.js";
import type { TraceIndex } from "./trace-index.js";
import { briefArchitecture } from "./brief-architecture.js";
import { buildBriefDecisions, decisionSteps, type BriefDecisionCard } from "./brief-decisions.js";
import { enterSession, sessionSlot } from "./session-slots.js";
import { changedStepIds, stepDigest } from "./step-digest.js";

export type { BriefDecisionCard } from "./brief-decisions.js";

/**
 * The Brief's three parts (spec §3.3, §8.4; interfaces §6.4). Lane 06 fills `architecture`; lane 07 adds the story
 * `now` and the decision cards (spec §3.5; lane 07 deviation 4).
 */
export interface BriefModel {
  now:
    | { kind: "rule"; runningStepId: string | null; latestUnitId: string | null; pendingDecisionId: string | null }
    | { kind: "story"; sentences: NarrativeSentence[]; basisSeq: number; provenance?: "rule" | "model" };
  changes: { unitId: string; title: string; added: number; removed: number; tests: { passed: number; failed: number } | null; attention: boolean }[];
  architecture: { overviewSentences: NarrativeSentence[] | null; componentCount: number; touched: string[]; scanning: { done: number; total: number } | null } | null;
  decisions: readonly BriefDecisionCard[];
}

export type BriefChange = BriefModel["changes"][number];
export type BriefArchitecture = NonNullable<BriefModel["architecture"]>;

function compareNewest(a: Chapter, b: Chapter): number {
  return b.lastSeq - a.lastSeq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const shownByChapters = new WeakMap<readonly Chapter[], readonly Chapter[]>();

/** Current, non-noise chapters, newest first by lastSeq (ties by id); per chapter list, which finalize keeps until a unit changes. */
function shownChapters(chapters: readonly Chapter[]): readonly Chapter[] {
  let shown = shownByChapters.get(chapters);
  if (shown === undefined) {
    shown = chapters.filter((chapter) => chapter.current && !chapter.noise).sort(compareNewest);
    shownByChapters.set(chapters, shown);
  }
  return shown;
}

/** The running step with the highest first seq on a live session; a pending decision is reported on its own. */
function runningStepOf(session: TraceSession): string | null {
  if (!session.live) return null;
  const at = stepDigest(session.steps).running.at(-1);
  return at === undefined ? null : (session.steps[at]?.id ?? null);
}

/** The decision id of the latest decision step whose decision is still open. */
function pendingDecisionOf(session: TraceSession): string | null {
  const steps = decisionSteps(session.steps);
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const decision = steps[i]?.decision;
    if (decision !== undefined && decision.status === "open") return decision.decisionId;
  }
  return null;
}

/** A chapter's change and what it read: the steps by id and the findings it names. */
interface ChangeEntry {
  change: BriefChange;
  /** The step ids the change read (stepIds and validationStepIds). */
  ids: ReadonlySet<string>;
  /** index.findingsById at chapter.findingIds when it was built. */
  findings: readonly (Finding | undefined)[];
}

function changeOf(chapter: Chapter, session: TraceSession, index: TraceIndex): ChangeEntry {
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
  const ids = new Set<string>([...chapter.stepIds, ...chapter.validationStepIds]);
  for (const id of ids) {
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
  const findings = chapter.findingIds.map((id) => index.findingsById.get(id));
  const attention = findings.some((finding) => finding !== undefined && finding.severity !== "info" && own.has(finding.anchorStepId));
  return { change: { unitId: chapter.id, title: chapter.shortTitle ?? chapter.title, added, removed, tests, attention }, ids, findings };
}

/** The inputs of the last changes built, and each shown chapter's entry (entries[i] is shown[i]'s). */
let lastChanges: {
  shown: readonly Chapter[];
  steps: readonly Step[];
  findingsById: TraceIndex["findingsById"];
  entries: readonly ChangeEntry[];
  changes: BriefChange[];
} | null = null;

sessionSlot({
  clear: () => {
    lastChanges = null;
  },
  held: () => (lastChanges === null ? [] : [lastChanges.shown, lastChanges.steps, lastChanges.findingsById]),
});

function sameChange(a: BriefChange, b: BriefChange): boolean {
  return (
    a.unitId === b.unitId && a.title === b.title && a.added === b.added && a.removed === b.removed && a.attention === b.attention &&
    (a.tests === null || b.tests === null ? a.tests === b.tests : a.tests.passed === b.tests.passed && a.tests.failed === b.tests.failed)
  );
}

/** Whether an entry built for the previous commit still holds: it read no step whose id changed, and the same findings. */
function stillHolds(entry: ChangeEntry, chapter: Chapter, changedIds: readonly string[], index: TraceIndex, sameFindings: boolean): boolean {
  for (const id of changedIds) if (entry.ids.has(id)) return false;
  return sameFindings || chapter.findingIds.every((id, at) => index.findingsById.get(id) === entry.findings[at]);
}

/**
 * The shown chapters' changes. A change reads its chapter, the steps it lists (by id, through the index) and the findings
 * it names, so a commit rebuilds only the chapters that are new objects or list a step whose id is at a changed position
 * (changedStepIds); a commit that changed none of the three keeps the previous list.
 */
function changesOf(session: TraceSession, index: TraceIndex): BriefChange[] {
  const shown = shownChapters(session.chapters);
  const steps = session.steps;
  const findingsById = index.findingsById;
  const last = lastChanges;
  if (last !== null && last.shown === shown && last.steps === steps && last.findingsById === findingsById) return last.changes;
  const changed = last === null ? null : last.steps === steps ? [] : changedStepIds(last.steps, steps);
  const sameFindings = last?.findingsById === findingsById;
  // The previous entry of a chapter: by position while the shown list is the same object, else by chapter object.
  let previousOf: (chapter: Chapter, at: number) => ChangeEntry | undefined = () => undefined;
  if (last !== null && changed !== null) {
    if (last.shown === shown) previousOf = (_chapter, at) => last.entries[at];
    else {
      const byChapter = new Map<Chapter, ChangeEntry>();
      last.shown.forEach((chapter, at) => {
        const entry = last.entries[at];
        if (entry !== undefined) byChapter.set(chapter, entry);
      });
      previousOf = (chapter) => byChapter.get(chapter);
    }
  }
  // A rebuilt change equal to the unit's previous one keeps that object (an answered decision re-reads its unit).
  let lastByUnit: Map<string, BriefChange> | null = null;
  const reuse = (entry: ChangeEntry): ChangeEntry => {
    if (last === null) return entry;
    lastByUnit ??= new Map(last.changes.map((change) => [change.unitId, change]));
    const was = lastByUnit.get(entry.change.unitId);
    return was !== undefined && sameChange(was, entry.change) ? { ...entry, change: was } : entry;
  };
  const entries: ChangeEntry[] = [];
  const changes: BriefChange[] = [];
  let kept = last !== null && last.changes.length === shown.length;
  shown.forEach((chapter, at) => {
    const previous = previousOf(chapter, at);
    const entry =
      previous !== undefined && changed !== null && stillHolds(previous, chapter, changed, index, sameFindings)
        ? previous
        : reuse(changeOf(chapter, session, index));
    entries.push(entry);
    changes.push(entry.change);
    if (entry.change !== last?.changes[at]) kept = false;
  });
  lastChanges = { shown, steps, findingsById, entries, changes: kept && last !== null ? last.changes : changes };
  return lastChanges.changes;
}

/**
 * Pure (spec §8.4). `now` is the session's latest story once an explainer story row arrived (phase C), else the
 * rule-based Now of phases A and B. `architecture` comes from the session's overview (null until a snapshot row arrives).
 * Each part is cached on what it reads (the steps, chapters, entities, overview, whys and findings, which finalize keeps
 * the same objects while they are unchanged; brief.incremental.property.test.ts). A commit that changes none of a part's
 * inputs reuses it; one that changes a few steps compares the two steps lists by pointer and re-reads only those steps
 * and the chapters that list them.
 */
export function buildBrief(session: TraceSession, index: TraceIndex): BriefModel {
  enterSession(session.meta.sessionId);
  const chapters = shownChapters(session.chapters);
  const story = session.explainer.story;
  return {
    now:
      story !== null
        ? { kind: "story", sentences: story.sentences, basisSeq: story.basisSeq, provenance: story.provenance }
        : {
            kind: "rule",
            runningStepId: runningStepOf(session),
            latestUnitId: chapters[0]?.id ?? null,
            pendingDecisionId: pendingDecisionOf(session),
          },
    changes: changesOf(session, index),
    architecture: briefArchitecture(session),
    decisions: buildBriefDecisions(session),
  };
}

/** A file this session edited, for the Brief's edited-files list. */
export interface EditedFile {
  path: string;
  added: number;
  removed: number;
  /** The file's latest edit step, which a click selects (as a file location does, Shell selectionFromStableId). */
  stepId: StepId;
  /** That step's first seq, which its id encodes (`step:<firstSeq>`, stepStableId). */
  seq: number;
}

const editedByEntities = new WeakMap<readonly Entity[], { all?: readonly EditedFile[]; ungrouped?: readonly EditedFile[] }>();

/**
 * The session's edited files, newest edit first: the D-3 rail's "Files in play" before any change unit exists, and
 * once units exist the files no unit holds yet (`ungroupedOnly`, lane triage t3). Cached per entities list, which
 * finalize keeps the same object until an edit changes it.
 */
export function editedFilesOf(entities: readonly Entity[], ungroupedOnly = false): readonly EditedFile[] {
  let cached = editedByEntities.get(entities);
  if (cached === undefined) editedByEntities.set(entities, (cached = {}));
  const hit = ungroupedOnly ? cached.ungrouped : cached.all;
  if (hit !== undefined) return hit;
  const files: EditedFile[] = [];
  for (const entity of entities) {
    if (ungroupedOnly && entity.chapterIds.length > 0) continue;
    const stepId = entity.stepIds.at(-1);
    if (stepId === undefined) continue;
    const seq = Number(stepId.slice("step:".length));
    files.push({ path: entity.path, added: entity.added, removed: entity.removed, stepId, seq: Number.isFinite(seq) ? seq : 0 });
  }
  files.sort((a, b) => b.seq - a.seq || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (ungroupedOnly) cached.ungrouped = files;
  else cached.all = files;
  return files;
}
