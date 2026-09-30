import type { SelectionId } from "../../../layout/trace-index.js";
import {
  describeGraphic,
  displayUntrusted,
  exitLabel,
  formatOffset,
  normalizeCommand,
  pickGraphic,
  searchSteps,
  type Chapter,
  type Finding,
  type FindingId,
  type GraphicSpec,
  type SearchIndex,
  type Step,
  type StepId,
  type TraceSession,
  type UnitStableId,
} from "../../../model/index.js";
import type { IconName } from "../../icons/icon-names.js";
import { CATEGORY_ICON, KIND_ICON } from "../../icons/kind-icons.js";

export type OutlineSection = "story" | "files" | "commands" | "tests";

export const SECTION_LABEL: Record<OutlineSection, string> = {
  story: "Story",
  files: "Files",
  commands: "Commands",
  tests: "Tests",
};

export const FILES_COLLAPSE_ABOVE = 12;

export const DEFAULT_OPEN_SECTIONS: ReadonlySet<OutlineSection> = new Set<OutlineSection>(["story", "files", "commands"]);

export type OutlineFlag = "shield" | "neq" | "x" | null;

export interface OutlineItemRow {
  t: "item";
  key: string;
  section: OutlineSection;
  depth: 0 | 1;
  selId: SelectionId;
  icon: IconName;
  title: string;
  mono: boolean;
  tMs: number;
  flag: OutlineFlag;
  failed: boolean;
  muted: boolean;
  graphic: GraphicSpec | null;
  chapterId: UnitStableId | null;
  /** Accessible name. */
  label: string;
  /** Files rows open the Inspector's Evidence tab at the diff. */
  openEvidence: boolean;
}

export type OutlineRow =
  | { t: "section"; key: `section:${OutlineSection}`; section: OutlineSection; label: string; count: number; open: boolean }
  | { t: "turn"; key: `turn:${number}`; turn: number; label: string; tMs: number }
  | OutlineItemRow
  | { t: "more"; key: `more:${OutlineSection}`; section: OutlineSection; hidden: number };

export interface OutlineInput {
  open: ReadonlySet<OutlineSection>;
  showAll: ReadonlySet<OutlineSection>;
}

function isPresent<T>(value: T | undefined | null): value is T {
  return value !== undefined && value !== null;
}

function joinLabel(parts: ReadonlyArray<string | null | undefined | false>): string {
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(", ");
}

function chapterItem(
  chapter: Chapter,
  session: TraceSession,
  depth: 0 | 1,
  findingById: ReadonlyMap<FindingId, Finding>,
): OutlineItemRow {
  const findings = chapter.findingIds.map((id) => findingById.get(id)).filter(isPresent);
  const flag: OutlineFlag = findings.some((finding) => finding.ruleId === "claim_contradicted")
    ? "neq"
    : chapter.status === "failed"
      ? "x"
      : chapter.clampIds.length > 0
        ? "shield"
        : null;
  const graphic = pickGraphic(chapter, session);
  const title = displayUntrusted(chapter.title);
  return {
    t: "item",
    key: chapter.id,
    section: "story",
    depth,
    selId: chapter.id,
    icon: CATEGORY_ICON[chapter.category],
    title,
    mono: false,
    tMs: chapter.tMs,
    flag,
    failed: flag === "x",
    muted: false,
    graphic: null,
    chapterId: chapter.id,
    label: joinLabel([title, graphic === null ? null : describeGraphic(graphic), formatOffset(chapter.tMs)]),
    openEvidence: false,
  };
}

function stepItem(
  step: Step,
  depth: 0 | 1,
  title: string,
  icon: IconName,
  flag: OutlineFlag,
  extra?: string,
  mono = false,
): OutlineItemRow {
  return {
    t: "item",
    key: `story:${step.id}`,
    section: "story",
    depth,
    selId: step.id,
    icon,
    title,
    mono,
    tMs: step.tMs,
    flag,
    failed: false,
    muted: false,
    graphic: null,
    chapterId: null,
    label: joinLabel([title, extra, formatOffset(step.tMs)]),
    openEvidence: false,
  };
}

function storyRows(session: TraceSession): OutlineRow[] {
  const out: OutlineRow[] = [];
  const multi = session.turns.length > 1;
  const depth: 0 | 1 = multi ? 1 : 0;
  const stepById = new Map<StepId, Step>(session.steps.map((step) => [step.id, step]));
  const findingById = new Map<FindingId, Finding>(session.findings.map((finding) => [finding.id, finding]));
  for (const turn of session.turns) {
    const nextT = session.turns[turn.index + 1]?.tMs ?? Number.POSITIVE_INFINITY;
    const inTurn = (tMs: number): boolean => tMs >= turn.tMs && tMs < nextT;
    if (multi) {
      out.push({ t: "turn", key: `turn:${turn.index}`, turn: turn.index, label: `Turn ${turn.index + 1} · ${turn.trigger}`, tMs: turn.tMs });
    }
    const items: OutlineItemRow[] = [];
    const steps = turn.stepIds.map((id) => stepById.get(id)).filter(isPresent);
    const intent = steps.find((step) => step.kind === "instruction");
    if (intent !== undefined) items.push(stepItem(intent, depth, "Intent", "person", null));
    for (const chapter of session.chapters) {
      if (chapter.current && !chapter.noise && inTurn(chapter.tMs)) items.push(chapterItem(chapter, session, depth, findingById));
    }
    for (const step of steps) {
      // Decision titles are agent text: sanitized and kept in a mono slot.
      if (step.kind === "decision") {
        items.push(stepItem(step, depth, displayUntrusted(step.decision?.title ?? step.headline), "fork", null, undefined, true));
      }
    }
    items.sort((a, b) => a.tMs - b.tMs || a.key.localeCompare(b.key));
    const noise = session.chapters.filter((chapter) => chapter.current && chapter.noise && inTurn(chapter.tMs));
    const firstNoise = noise[0];
    if (firstNoise !== undefined) {
      items.push({
        t: "item",
        key: `noise:${turn.index}`,
        section: "story",
        depth,
        selId: firstNoise.id,
        icon: "eyeoff",
        title: `Noise ${noise.length}`,
        mono: false,
        tMs: firstNoise.tMs,
        flag: null,
        failed: false,
        muted: true,
        graphic: null,
        chapterId: firstNoise.id,
        label: `Noise, ${noise.length} ${noise.length === 1 ? "chapter" : "chapters"}`,
        openEvidence: false,
      });
    }
    const claim = turn.claimStepId === undefined ? undefined : stepById.get(turn.claimStepId);
    if (claim !== undefined) {
      const contradicted = claim.findingIds.some((id) => findingById.get(id)?.ruleId === "claim_contradicted");
      items.push(stepItem(claim, depth, "Final claim", "quote", contradicted ? "neq" : null, contradicted ? "contradicts tests" : undefined));
    }
    out.push(...items);
  }
  return out;
}

function fileRows(session: TraceSession): OutlineItemRow[] {
  const clamped = new Set(session.chapters.filter((chapter) => chapter.clampIds.length > 0).map((chapter) => chapter.id));
  const stepById = new Map<StepId, Step>(session.steps.map((step) => [step.id, step]));
  const out: OutlineItemRow[] = [];
  for (const entity of session.entities) {
    const latest = entity.stepIds.at(-1);
    if (latest === undefined) continue;
    const graphic: GraphicSpec = { kind: "diff", added: entity.added, removed: entity.removed };
    out.push({
      t: "item",
      key: entity.id,
      section: "files",
      depth: 0,
      selId: latest,
      icon: "file",
      title: entity.label,
      mono: true,
      tMs: stepById.get(latest)?.tMs ?? 0,
      flag: entity.chapterIds.some((id) => clamped.has(id)) ? "shield" : null,
      failed: false,
      muted: false,
      graphic,
      chapterId: null,
      label: joinLabel([displayUntrusted(entity.path), describeGraphic(graphic)]),
      openEvidence: true,
    });
  }
  return out;
}

function commandTitle(step: Step): string {
  return displayUntrusted(normalizeCommand(step.command?.command ?? step.target ?? ""));
}

function commandRows(session: TraceSession): OutlineItemRow[] {
  return session.steps
    .filter((step) => step.command !== undefined && (step.kind === "command" || step.kind === "test" || step.kind === "check"))
    .map((step) => {
      const title = commandTitle(step);
      const failed = step.status === "failed";
      return {
        t: "item",
        key: `cmd:${step.id}`,
        section: "commands",
        depth: 0,
        selId: step.id,
        icon: KIND_ICON[step.kind],
        title,
        mono: true,
        tMs: step.tMs,
        flag: failed ? "x" : null,
        failed,
        muted: false,
        graphic: null,
        chapterId: null,
        label: joinLabel([title, failed ? "failed" : null, exitLabel(step.command?.exitCode ?? null), formatOffset(step.tMs)]),
        openEvidence: false,
      } satisfies OutlineItemRow;
    });
}

function testRows(session: TraceSession): OutlineItemRow[] {
  return session.steps
    .filter((step) => step.tests !== undefined)
    .map((step) => {
      const tests = step.tests ?? { passed: 0, failed: 0, skipped: 0 };
      const graphic: GraphicSpec = { kind: "tests", passed: tests.passed, failed: tests.failed, skipped: tests.skipped };
      const title = commandTitle(step);
      return {
        t: "item",
        key: `test:${step.id}`,
        section: "tests",
        depth: 0,
        selId: step.id,
        icon: KIND_ICON[step.kind],
        title,
        mono: true,
        tMs: step.tMs,
        flag: step.status === "failed" ? "x" : null,
        failed: step.status === "failed",
        muted: false,
        graphic,
        chapterId: null,
        label: joinLabel([title, describeGraphic(graphic), formatOffset(step.tMs)]),
        openEvidence: false,
      } satisfies OutlineItemRow;
    });
}

function pushSection(
  rows: OutlineRow[],
  section: OutlineSection,
  entries: readonly OutlineRow[],
  input: OutlineInput,
  cap?: number,
): void {
  const open = input.open.has(section);
  rows.push({
    t: "section",
    key: `section:${section}`,
    section,
    label: SECTION_LABEL[section],
    count: entries.filter((entry) => entry.t === "item").length,
    open,
  });
  if (!open) return;
  if (cap !== undefined && !input.showAll.has(section) && entries.length > cap) {
    rows.push(...entries.slice(0, cap));
    rows.push({ t: "more", key: `more:${section}`, section, hidden: entries.length - cap });
    return;
  }
  rows.push(...entries);
}

export function buildOutlineRows(session: TraceSession, input: OutlineInput): OutlineRow[] {
  const rows: OutlineRow[] = [];
  pushSection(rows, "story", storyRows(session), input);
  pushSection(rows, "files", fileRows(session), input, FILES_COLLAPSE_ABOVE);
  pushSection(rows, "commands", commandRows(session), input);
  pushSection(rows, "tests", testRows(session), input);
  return rows;
}

/** Chapter titles and searchSteps matches; case-insensitive; every term required; chapters first. */
export function searchMatches(session: TraceSession, index: SearchIndex, query: string): SelectionId[] {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
  if (terms.length === 0) return [];
  const chapters = session.chapters
    .filter((chapter) => terms.every((term) => chapter.title.toLowerCase().includes(term)))
    .map((chapter) => chapter.id);
  return [...chapters, ...searchSteps(index, query)];
}
