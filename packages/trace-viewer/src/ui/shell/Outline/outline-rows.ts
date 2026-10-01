import type { SelectionId } from "../../../layout/trace-index.js";
import {
  describeGraphic,
  displayUntrusted,
  exitLabel,
  formatOffset,
  normalizeCommand,
  pickGraphic,
  searchSteps,
  sessionStep,
  shortenTitle,
  truncateMiddle,
  type Chapter,
  type Entity,
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

/** Graphemes of a Files row basename before it is cut in the middle, until the Outline has measured its column. */
export const FILE_TITLE_MAX = 13;
/** A Files row's fixed parts: 12 px padding each side, icon 14 + gap, shield 12 + gap, the 44 px DiffBar slot + gap. */
const FILES_ROW_CHROME_PX = 24 + 22 + 20 + 52;
/** Advance of one 12 px monospace glyph (SF Mono, Menlo). */
const MONO_GLYPH_PX = 7.3;
/** Glyphs a row without the shield gains (12 px icon + 8 px gap). */
const NO_SHIELD_GLYPHS = 2;

/** How many basename graphemes fit a Files row in a column `widthPx` wide (§7.1 "middle-truncated"). */
export function fileTitleBudget(widthPx: number): number {
  if (!(widthPx > 0)) return FILE_TITLE_MAX;
  return Math.max(6, Math.floor((widthPx - FILES_ROW_CHROME_PX) / MONO_GLYPH_PX));
}

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
  /** Tooltip, when the title shortens what it names (a Files row's full path). */
  hint?: string;
  /** A folded row also counts as selected when this id is (a decision row that absorbed its chapter). */
  alsoSelects?: SelectionId;
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
  /** Basename budget of Files rows (fileTitleBudget of the measured column); FILE_TITLE_MAX when absent. */
  fileTitleMax?: number;
}

function isPresent<T>(value: T | undefined | null): value is T {
  return value !== undefined && value !== null;
}

// Row caches keyed by the session object a row reads. finalize never mutates a session it returned
// and keeps an unchanged step or entity the same object across commits (model/fold-finalize.ts), so
// a Live tick builds rows only for what changed. A hand-built session gets fresh objects, so it only
// misses.
const fileRowCache = new WeakMap<Entity, { titleMax: number; shield: boolean; tMs: number; row: OutlineItemRow }>();
const commandRowCache = new WeakMap<Step, OutlineItemRow>();
const testRowCache = new WeakMap<Step, OutlineItemRow>();

/** The step with this id: steps are in firstSeq order and a step id is step:<firstSeq>. */
function stepWithId(steps: readonly Step[], id: StepId): Step | undefined {
  const seq = Number(id.slice("step:".length));
  let lo = 0;
  let hi = steps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((steps[mid]?.firstSeq ?? 0) < seq) lo = mid + 1;
    else hi = mid;
  }
  const step = steps[lo];
  return step?.id === id ? step : steps.find((candidate) => candidate.id === id);
}

function joinLabel(parts: ReadonlyArray<string | null | undefined | false>): string {
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(", ");
}

/** ≠ only on a chapter that carries the claim finding (the data decides which: branch M scopes it), else ✕ or shield. */
function chapterFlag(chapter: Chapter, findingById: ReadonlyMap<FindingId, Finding>): OutlineFlag {
  const findings = chapter.findingIds.map((id) => findingById.get(id)).filter(isPresent);
  if (findings.some((finding) => finding.ruleId === "claim_contradicted")) return "neq";
  if (chapter.status === "failed") return "x";
  return chapter.clampIds.length > 0 ? "shield" : null;
}

function chapterItem(
  chapter: Chapter,
  session: TraceSession,
  depth: 0 | 1,
  findingById: ReadonlyMap<FindingId, Finding>,
): OutlineItemRow {
  const flag = chapterFlag(chapter, findingById);
  const graphic = pickGraphic(chapter, session);
  // The row reads the short title (M2); the tooltip and the accessible name carry the full one.
  const full = displayUntrusted(chapter.title);
  const title = displayUntrusted(chapter.shortTitle ?? chapter.title);
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
    label: joinLabel([full, graphic === null ? null : describeGraphic(graphic), formatOffset(chapter.tMs)]),
    ...(title === full ? {} : { hint: full }),
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
): OutlineItemRow {
  return {
    t: "item",
    key: `story:${step.id}`,
    section: "story",
    depth,
    selId: step.id,
    icon,
    title,
    mono: false,
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

/** The chapter a decision gave birth to: the first one at or after the decision that links it (§7.1 one row). */
function decisionBornChapter(step: Step, chapters: readonly Chapter[], taken: ReadonlySet<UnitStableId>): Chapter | undefined {
  const id = `decision:${step.decision?.decisionId ?? ""}`;
  let born: Chapter | undefined;
  for (const chapter of chapters) {
    if (taken.has(chapter.id) || chapter.tMs < step.tMs || !chapter.decisionIds.some((linked) => linked === id)) continue;
    if (born === undefined || chapter.tMs < born.tMs) born = chapter;
  }
  return born;
}

/** One row for a decision and its decision-born chapter: the decision's title and ForkGlyph, the chapter's flag. */
function decisionRow(
  step: Step,
  chapter: Chapter,
  session: TraceSession,
  depth: 0 | 1,
  title: DecisionTitle,
  flag: OutlineFlag,
): OutlineItemRow {
  const graphic = pickGraphic(step, session);
  return {
    ...decisionItem(step, depth, title, flag),
    failed: flag === "x",
    graphic,
    chapterId: chapter.id,
    alsoSelects: chapter.id,
    label: joinLabel([title.full, graphic === null ? null : describeGraphic(graphic), formatOffset(step.tMs)]),
  };
}

interface DecisionTitle { short: string; full: string }

/** Decision titles are agent prose: neutralised, in the sans face (§7.12 keeps mono for paths and commands), and
 *  shortened like a chapter title for the 216 px column; the full title is the tooltip and the accessible name. */
function decisionTitle(step: Step): DecisionTitle {
  const raw = step.decision?.title ?? step.headline;
  return { short: displayUntrusted(shortenTitle(raw)), full: displayUntrusted(raw) };
}

function decisionItem(step: Step, depth: 0 | 1, title: DecisionTitle, flag: OutlineFlag): OutlineItemRow {
  const item = stepItem(step, depth, title.short, "fork", flag);
  return {
    ...item,
    label: joinLabel([title.full, formatOffset(step.tMs)]),
    ...(title.short === title.full ? {} : { hint: title.full }),
  };
}

/** Chapters by the turn whose time span [turn.tMs, next turn's tMs) holds chapter.tMs, in session order. */
function chaptersByTurn(session: TraceSession): Map<number, Chapter[]> {
  const turns = session.turns;
  const byTurn = new Map<number, Chapter[]>();
  const add = (index: number, chapter: Chapter): void => {
    const list = byTurn.get(index);
    if (list === undefined) byTurn.set(index, [chapter]);
    else list.push(chapter);
  };
  const sorted = turns.every((turn, position) => position === 0 || (turns[position - 1]?.tMs ?? 0) <= turn.tMs);
  for (const chapter of session.chapters) {
    if (!sorted) {
      // Hand-built turns out of time order: test each span.
      for (const turn of turns) {
        const nextT = turns[turn.index + 1]?.tMs ?? Number.POSITIVE_INFINITY;
        if (chapter.tMs >= turn.tMs && chapter.tMs < nextT) add(turn.index, chapter);
      }
      continue;
    }
    // The last turn starting at or before the chapter: its span holds the chapter.
    let lo = 0;
    let hi = turns.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((turns[mid]?.tMs ?? 0) <= chapter.tMs) lo = mid + 1;
      else hi = mid;
    }
    const turn = turns[lo - 1];
    if (turn !== undefined) add(turn.index, chapter);
  }
  return byTurn;
}

function storyRows(session: TraceSession): OutlineRow[] {
  const out: OutlineRow[] = [];
  const multi = session.turns.length > 1;
  const depth: 0 | 1 = multi ? 1 : 0;
  const findingById = new Map<FindingId, Finding>(session.findings.map((finding) => [finding.id, finding]));
  const byTurn = chaptersByTurn(session);
  for (const turn of session.turns) {
    const turnChapters = byTurn.get(turn.index) ?? [];
    if (multi) {
      out.push({ t: "turn", key: `turn:${turn.index}`, turn: turn.index, label: `Turn ${turn.index + 1} · ${turn.trigger}`, tMs: turn.tMs });
    }
    const items: OutlineItemRow[] = [];
    const steps = turn.stepIds.map((id) => sessionStep(session, id)).filter(isPresent);
    const intent = steps.find((step) => step.kind === "instruction");
    if (intent !== undefined) items.push(stepItem(intent, depth, "Intent", "person", null));
    const chapters = turnChapters.filter((chapter) => chapter.current && !chapter.noise);
    const folded = new Set<UnitStableId>();
    for (const step of steps) {
      if (step.kind !== "decision") continue;
      const title = decisionTitle(step);
      const born = step.decision === undefined ? undefined : decisionBornChapter(step, chapters, folded);
      if (born === undefined) {
        items.push(decisionItem(step, depth, title, null));
        continue;
      }
      folded.add(born.id);
      items.push(decisionRow(step, born, session, depth, title, chapterFlag(born, findingById)));
    }
    for (const chapter of chapters) {
      if (!folded.has(chapter.id)) items.push(chapterItem(chapter, session, depth, findingById));
    }
    items.sort((a, b) => a.tMs - b.tMs || a.key.localeCompare(b.key));
    const noise = turnChapters.filter((chapter) => chapter.current && chapter.noise);
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
    const claim = turn.claimStepId === undefined ? undefined : sessionStep(session, turn.claimStepId);
    if (claim !== undefined) {
      const contradicted = claim.findingIds.some((id) => findingById.get(id)?.ruleId === "claim_contradicted");
      items.push(stepItem(claim, depth, "Final claim", "quote", contradicted ? "neq" : null, contradicted ? "contradicts tests" : undefined));
    }
    out.push(...items);
  }
  return out;
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  const slash = trimmed.lastIndexOf("/");
  return slash < 0 ? trimmed : trimmed.slice(slash + 1);
}

/** The first `limit` Files rows, and how many there are in all (one per entity with a step). */
function fileRows(session: TraceSession, titleMax: number, limit: number): { rows: OutlineItemRow[]; count: number } {
  let count = 0;
  for (const entity of session.entities) if (entity.stepIds.length > 0) count += 1;
  if (limit <= 0) return { rows: [], count };
  const clamped = new Set(session.chapters.filter((chapter) => chapter.clampIds.length > 0).map((chapter) => chapter.id));
  const out: OutlineItemRow[] = [];
  for (const entity of session.entities) {
    if (out.length >= limit) break;
    const latest = entity.stepIds.at(-1);
    if (latest === undefined) continue;
    const shield = entity.chapterIds.some((id) => clamped.has(id));
    // The row reads its latest step's tMs, which the entity does not hold: part of the key (a binary search).
    const tMs = stepWithId(session.steps, latest)?.tMs ?? 0;
    const cached = fileRowCache.get(entity);
    if (cached !== undefined && cached.titleMax === titleMax && cached.shield === shield && cached.tMs === tMs) {
      out.push(cached.row);
      continue;
    }
    const row = fileRow(entity, latest, tMs, titleMax, shield);
    fileRowCache.set(entity, { titleMax, shield, tMs, row });
    out.push(row);
  }
  return { rows: out, count };
}

function fileRow(entity: Entity, latest: StepId, tMs: number, titleMax: number, shield: boolean): OutlineItemRow {
  const graphic: GraphicSpec = { kind: "diff", added: entity.added, removed: entity.removed };
  const path = displayUntrusted(entity.path);
  return {
    t: "item",
    key: entity.id,
    section: "files",
    depth: 0,
    selId: latest,
    icon: "file",
    title: truncateMiddle(basename(entity.label), titleMax + (shield ? 0 : NO_SHIELD_GLYPHS)),
    mono: true,
    tMs,
    flag: shield ? "shield" : null,
    failed: false,
    muted: false,
    graphic,
    chapterId: null,
    label: joinLabel([path, describeGraphic(graphic)]),
    hint: path,
    openEvidence: true,
  };
}

/** The cached row of a step, else build(step) cached. */
function cachedRow(cache: WeakMap<Step, OutlineItemRow>, step: Step, build: (step: Step) => OutlineItemRow): OutlineItemRow {
  let row = cache.get(step);
  if (row === undefined) {
    row = build(step);
    cache.set(step, row);
  }
  return row;
}

function commandTitle(step: Step): string {
  return displayUntrusted(normalizeCommand(step.command?.command ?? step.target ?? ""));
}

function commandRows(session: TraceSession): OutlineItemRow[] {
  return session.steps
    .filter((step) => step.command !== undefined && (step.kind === "command" || step.kind === "test" || step.kind === "check"))
    .map((step) => cachedRow(commandRowCache, step, commandRow));
}

function commandRow(step: Step): OutlineItemRow {
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
  };
}

function testRows(session: TraceSession): OutlineItemRow[] {
  return session.steps.filter((step) => step.tests !== undefined).map((step) => cachedRow(testRowCache, step, testRow));
}

function testRow(step: Step): OutlineItemRow {
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
  };
}

function pushSection(
  rows: OutlineRow[],
  section: OutlineSection,
  entries: readonly OutlineRow[],
  input: OutlineInput,
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
  if (open) rows.push(...entries);
}

/** Files: a closed section or the collapsed first FILES_COLLAPSE_ABOVE rows build only the rows they show. */
function pushFiles(rows: OutlineRow[], session: TraceSession, input: OutlineInput): void {
  const open = input.open.has("files");
  const capped = !input.showAll.has("files");
  const files = fileRows(session, input.fileTitleMax ?? FILE_TITLE_MAX, !open ? 0 : capped ? FILES_COLLAPSE_ABOVE : Number.POSITIVE_INFINITY);
  rows.push({ t: "section", key: "section:files", section: "files", label: SECTION_LABEL.files, count: files.count, open });
  if (!open) return;
  rows.push(...files.rows);
  if (capped && files.count > FILES_COLLAPSE_ABOVE) rows.push({ t: "more", key: "more:files", section: "files", hidden: files.count - FILES_COLLAPSE_ABOVE });
}

export function buildOutlineRows(session: TraceSession, input: OutlineInput): OutlineRow[] {
  const rows: OutlineRow[] = [];
  pushSection(rows, "story", storyRows(session), input);
  pushFiles(rows, session, input);
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
