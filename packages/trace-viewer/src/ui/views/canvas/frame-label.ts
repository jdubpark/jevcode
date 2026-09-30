import type { CanvasFrame } from "../../../layout/canvas-layout.js";
import { frameSize, GRAPHIC_MIN_K, ICON_ONLY_K, LEVEL_SPECS, STEP_LIST_ROWS } from "../../../layout/canvas-levels.js";
import { anchoredFindings, stepTone } from "../../../layout/tone.js";
import {
  clampMeta,
  describeGraphic,
  displayUntrusted,
  formatOffset,
  formatOffsetRange,
  pickGraphic,
  shortenTitle,
  type Chapter,
  type Finding,
  type FindingId,
  type GraphicSpec,
  type Level,
  type Step,
  type TraceSession,
} from "../../../model/index.js";
import type { IconName } from "../../icons/icon-names.js";
import { CATEGORY_ICON, KIND_ICON } from "../../icons/kind-icons.js";
import { FINDING_TITLE } from "../../inspector/finding-copy.js";

export interface FrameContext {
  session: TraceSession;
  stepById: ReadonlyMap<string, Step>;
  chapterById: ReadonlyMap<string, Chapter>;
  findingsById: ReadonlyMap<FindingId, Finding>;
}

export function buildFrameContext(session: TraceSession): FrameContext {
  return {
    session,
    stepById: new Map(session.steps.map((step) => [step.id, step])),
    chapterById: new Map(session.chapters.map((chapter) => [chapter.id, chapter])),
    findingsById: new Map(session.findings.map((finding) => [finding.id, finding])),
  };
}

/** Every step of the frame's members (a chapter's steps, or the story or loose step itself), in seq order. */
export function frameSteps(frame: CanvasFrame, ctx: FrameContext): Step[] {
  const out: Step[] = [];
  const seen = new Set<string>();
  for (const selId of frame.memberSelIds) {
    const chapter = ctx.chapterById.get(selId);
    for (const id of chapter === undefined ? [selId] : chapter.stepIds) {
      const step = ctx.stepById.get(id);
      if (step === undefined || seen.has(step.id)) continue;
      seen.add(step.id);
      out.push(step);
    }
  }
  return out.sort((a, b) => a.firstSeq - b.firstSeq);
}

/** The members' validation-only steps: shared test or check runs a chapter joins without owning (spec §6.6). */
function validationOnlyOf(frame: CanvasFrame, ctx: FrameContext): ReadonlySet<string> {
  const out = new Set<string>();
  for (const selId of frame.memberSelIds) {
    for (const id of ctx.chapterById.get(selId)?.validationOnlyStepIds ?? []) out.add(id);
  }
  return out;
}

/**
 * The frame's own steps: frameSteps less the members' validation-only steps, in seq order (lane review I-2). A shared
 * test run that every unit cites belongs to the chapter that owns its outcome; the others neither list, count, fill,
 * time nor tone it, as the Hybrid band footprint skips it (spec §6.6, §7.6.1). Every per-frame surface reads this.
 */
export function ownSteps(frame: CanvasFrame, ctx: FrameContext): Step[] {
  // frameSteps less validationOnly, without first collecting the shared runs: a soak noise stack's ~120 members link
  // ~4,000 steps, 31 of each member's 33 validation-only.
  const validationOnly = validationOnlyOf(frame, ctx);
  const out: Step[] = [];
  const seen = new Set<string>();
  for (const selId of frame.memberSelIds) {
    const chapter = ctx.chapterById.get(selId);
    for (const id of chapter === undefined ? [selId] : chapter.stepIds) {
      if (validationOnly.has(id) || seen.has(id)) continue;
      const step = ctx.stepById.get(id);
      if (step === undefined) continue;
      seen.add(id);
      out.push(step);
    }
  }
  return out.sort((a, b) => a.firstSeq - b.firstSeq);
}

/** Per-context step sets for the whole-layout passes (criticalFrameKeys, the running check): one pass over the steps. */
interface StepSets {
  bad: ReadonlySet<string>;
  running: ReadonlySet<string>;
}

const stepSetsCache = new WeakMap<FrameContext, StepSets>();

function stepSets(ctx: FrameContext): StepSets {
  const cached = stepSetsCache.get(ctx);
  if (cached !== undefined) return cached;
  const bad = new Set<string>();
  const running = new Set<string>();
  for (const step of ctx.stepById.values()) {
    if (stepTone(step, ctx.findingsById) === "bad") bad.add(step.id);
    if (step.endTMs === null) running.add(step.id);
  }
  const sets = { bad, running };
  stepSetsCache.set(ctx, sets);
  return sets;
}

/** True when one of the frame's own steps (ownSteps) is in `ids`, without listing them. */
function hasOwnStepIn(frame: CanvasFrame, ctx: FrameContext, ids: ReadonlySet<string>): boolean {
  if (ids.size === 0) return false;
  let validationOnly: ReadonlySet<string> | undefined;
  for (const selId of frame.memberSelIds) {
    const chapter = ctx.chapterById.get(selId);
    for (const id of chapter === undefined ? [selId] : chapter.stepIds) {
      if (!ids.has(id) || ctx.stepById.get(id) === undefined) continue;
      validationOnly ??= validationOnlyOf(frame, ctx);
      if (!validationOnly.has(id)) return true;
    }
  }
  return false;
}

export function frameStart(frame: CanvasFrame, ctx: FrameContext): number {
  let start = Infinity;
  for (const selId of frame.memberSelIds) {
    const t = ctx.chapterById.get(selId)?.tMs ?? ctx.stepById.get(selId)?.tMs;
    if (t !== undefined) start = Math.min(start, t);
  }
  return Number.isFinite(start) ? start : 0;
}

/** The later of the members' end and their own steps' ends (the selection chip and the ruler band). */
export function frameEnd(frame: CanvasFrame, ctx: FrameContext): number {
  return endOf(frame, ctx, frameStart(frame, ctx), ownSteps(frame, ctx));
}

function endOf(frame: CanvasFrame, ctx: FrameContext, start: number, steps: readonly Step[]): number {
  let end = start;
  for (const selId of frame.memberSelIds) {
    const chapter = ctx.chapterById.get(selId);
    if (chapter !== undefined) end = Math.max(end, chapter.endTMs);
  }
  for (const step of steps) end = Math.max(end, step.endTMs ?? step.tMs);
  return end;
}

/** The trigger of the story step's own turn (never the column's turn: a queued instruction sits in the previous one). */
function triggerOf(step: Step | undefined, ctx: FrameContext): string | undefined {
  return step === undefined ? undefined : ctx.session.turns.find((turn) => turn.index === step.turnIndex)?.trigger;
}

function titles(frame: CanvasFrame, ctx: FrameContext): { short: string; full: string } {
  const step = ctx.stepById.get(frame.selId);
  const fixed = (text: string): { short: string; full: string } => ({ short: text, full: text });
  switch (frame.item) {
    case "intent":
      return fixed("Intent");
    case "instruction": {
      const trigger = triggerOf(step, ctx);
      return fixed(trigger === "steer" ? "Steer" : trigger === "resume" ? "Resume" : "Instruction");
    }
    case "plan":
      return fixed("Plan");
    case "decision": {
      // Decision titles are agent or supervisor prose: neutralised and shortened like a chapter title.
      const raw = step?.decision?.title ?? "Decision";
      return { short: displayUntrusted(shortenTitle(raw)), full: displayUntrusted(raw) };
    }
    case "claim":
      return fixed("Final claim");
    case "noise":
      return fixed(`Noise ×${frame.memberSelIds.length}`);
    case "chapter": {
      if (frame.kind === "noise") return fixed("Noise ×1");
      const chapter = ctx.chapterById.get(frame.selId);
      if (chapter === undefined) return fixed("Chapter");
      return { short: displayUntrusted(chapter.shortTitle ?? chapter.title), full: displayUntrusted(chapter.title) };
    }
    case "loose": {
      const headline = displayUntrusted(step?.headline ?? "Step");
      return { short: headline, full: headline };
    }
  }
}

/** The visible title: a chapter's `shortTitle ?? title`, a shortened decision title, through displayUntrusted. */
export function frameTitle(frame: CanvasFrame, ctx: FrameContext): string {
  return titles(frame, ctx).short;
}

/** The full title, through displayUntrusted: the tooltip and the start of the accessible name. */
export function frameFullTitle(frame: CanvasFrame, ctx: FrameContext): string {
  return titles(frame, ctx).full;
}

export function frameIcon(frame: CanvasFrame, ctx: FrameContext): IconName {
  switch (frame.item) {
    case "intent":
    case "instruction":
      return "person";
    case "plan":
      return "list";
    case "decision":
      return "fork";
    case "claim":
      return "quote";
    case "noise":
      return "stack";
    case "chapter": {
      if (frame.kind === "noise") return "stack";
      const chapter = ctx.chapterById.get(frame.selId);
      return chapter === undefined ? "list" : CATEGORY_ICON[chapter.category];
    }
    case "loose": {
      const step = ctx.stepById.get(frame.selId);
      return step === undefined ? "flag" : KIND_ICON[step.kind];
    }
  }
}

/**
 * Anchor rule (layout/tone.ts): a frame is bad only through one of its own steps (ownSteps) whose stepTone is bad,
 * which reads anchored findings only. A finding that merely cites a step or names a chapter does not redden the frame,
 * and neither does a test run the chapter reaches only through a shared validation (Chapter.validationOnlyStepIds).
 */
export function frameTone(frame: CanvasFrame, ctx: FrameContext): "bad" | "neutral" {
  return hasOwnStepIn(frame, ctx, stepSets(ctx).bad) ? "bad" : "neutral";
}

function toneOf(ctx: FrameContext, own: readonly Step[]): "bad" | "neutral" {
  return own.some((step) => stepTone(step, ctx.findingsById) === "bad") ? "bad" : "neutral";
}

/**
 * The minimap's critical outlines and strip ticks (lane review I-1): exactly the frames the main view paints red, so
 * a shared failed run marks only the chapter that owns it. One pass per (layout, ctx); the caller memoizes it.
 */
export function criticalFrameKeys(layout: { readonly frames: readonly CanvasFrame[] }, ctx: FrameContext): Set<string> {
  const keys = new Set<string>();
  for (const frame of layout.frames) if (frameTone(frame, ctx) === "bad") keys.add(frame.key);
  return keys;
}

/**
 * "shield" (a warning or critical clamp) is always neutral: a bad clamp (a guardrail problem, layout/tone.ts) makes a
 * member step bad, and a bad frame reads "failed" first. Warning clamps stay neutral, as in the Outline.
 */
export type FrameFlag = "neq" | "failed" | "shield" | null;

export function frameFlag(frame: CanvasFrame, ctx: FrameContext): FrameFlag {
  return flagOf(frame, ctx, frameTone(frame, ctx));
}

function flagOf(frame: CanvasFrame, ctx: FrameContext, tone: "bad" | "neutral"): FrameFlag {
  if (frame.item === "claim") {
    const step = ctx.stepById.get(frame.selId);
    const anchored = step?.findingIds.some((id) => {
      const finding = ctx.findingsById.get(id);
      return finding?.ruleId === "claim_contradicted" && finding.anchorStepId === step.id;
    });
    if (anchored === true) return "neq";
  }
  if (tone === "bad") return "failed";
  // Warning-or-worse clamps only: an info suppression (Lockfile change hidden) is how a chapter becomes noise, not a
  // guard to flag (lane review minor 3; the Outline's noise row shows none either).
  const guarded = frame.memberSelIds.some((selId) =>
    (ctx.chapterById.get(selId)?.clampIds ?? []).some((id) => clampMeta(id).severity !== "info"),
  );
  return guarded ? "shield" : null;
}

export function frameGraphic(frame: CanvasFrame, ctx: FrameContext): GraphicSpec | null {
  if (frame.kind === "noise" || (frame.kind === "story" && frame.item !== "decision")) return null;
  if (frame.kind === "chapter") {
    const chapter = ctx.chapterById.get(frame.selId);
    return chapter === undefined ? null : pickGraphic(chapter, ctx.session);
  }
  const step = ctx.stepById.get(frame.selId);
  return step === undefined ? null : pickGraphic(step, ctx.session);
}

export function graphicPhrase(spec: GraphicSpec): string {
  if (spec.kind !== "tests") return describeGraphic(spec);
  const parts = spec.failed > 0 ? [`${spec.failed} failed`, `${spec.passed} passed`] : [`${spec.passed} passed`];
  if (spec.skipped > 0) parts.push(`${spec.skipped} skipped`);
  return parts.join(", ");
}

/** Spec §7.11 Partial: a chapter joined by time window (D11) carries ≈ on its frame. */
export function frameApprox(frame: CanvasFrame, ctx: FrameContext): boolean {
  return frame.memberSelIds.some((selId) => ctx.chapterById.get(selId)?.link === "inferred");
}

/** Accessible name (spec §7.13): full title, ≈, the contradiction, the graphic's phrase, the start offset. */
export function frameLabel(frame: CanvasFrame, ctx: FrameContext): string {
  return labelOf(frame, ctx, frameFullTitle(frame, ctx), frameFlag(frame, ctx), frameGraphic(frame, ctx), frameStart(frame, ctx));
}

function labelOf(
  frame: CanvasFrame,
  ctx: FrameContext,
  fullTitle: string,
  flag: FrameFlag,
  graphic: GraphicSpec | null,
  start: number,
): string {
  const parts = [fullTitle];
  if (frameApprox(frame, ctx)) parts.push("approximate join");
  if (flag === "neq") parts.push(FINDING_TITLE.claim_contradicted);
  if (graphic !== null) parts.push(displayUntrusted(graphicPhrase(graphic)));
  parts.push(formatOffset(start));
  return parts.join(", ");
}

/** True when an own step is still running: only such a frame needs the 1 Hz `nowMs` tick (C3-7, C3-10). */
export function frameRunning(frame: CanvasFrame, ctx: FrameContext): boolean {
  return hasOwnStepIn(frame, ctx, stepSets(ctx).running);
}

/** A problem by the anchor rule: the step is bad, or anchors a finding. A finding it only cites does not count. */
function isProblem(step: Step, findingsById: FrameContext["findingsById"]): boolean {
  return stepTone(step, findingsById) === "bad" || anchoredFindings(step, findingsById).length > 0;
}

/**
 * Sparse frames (C3-6 ruling): up to n of the given steps for the compact rows that fill an otherwise empty card body,
 * problem steps (anchor rule) first, newest first within each group.
 */
export function fillSteps(steps: readonly Step[], n: number, findingsById: FrameContext["findingsById"]): Step[] {
  if (n <= 0) return [];
  const newest = [...steps].sort((a, b) => b.firstSeq - a.firstSeq);
  const problem = new Set(newest.filter((step) => isProblem(step, findingsById)));
  return [...problem, ...newest.filter((step) => !problem.has(step))].slice(0, n);
}

/**
 * Frame.module.css: 12 px card padding, 8 px gaps, a 16 px footer and edit summary, 20 px fill rows, and 16 px file
 * rows 4 px apart (a 20 px pitch, measured in Chrome: rows at 12, 32, 52 and 72 px).
 */
const PAD_PX = 12;
const GAP_PX = 8;
const FOOT_PX = 16;
const EDIT_SUMMARY_PX = 16;
const FILL_ROW_PX = 20;
const FILL_MAX = 3;
const FILE_ROW_PX = 16;
const FILE_GAP_PX = 4;
/** The Chapter-level chapter card: the 134 px slot (spec §7.5) minus the 22 px label row above the card. */
const CARD_H = frameSize("chapter", "chapter").h - LEVEL_SPECS.chapter.labelH;
/** The 64 px left for the graphic and the fill rows above the footer. */
const BODY_PX = CARD_H - 2 * PAD_PX - FOOT_PX - GAP_PX;

/** File rows a Chapter-level chapter card shows; the rest are counted as "+n more" in its footer. */
export const CARD_FILE_ROWS = Math.floor((BODY_PX + FILE_GAP_PX) / (FILE_ROW_PX + FILE_GAP_PX));

function fileRowsPx(rows: number): number {
  return FILE_ROW_PX * rows + FILE_GAP_PX * Math.max(0, rows - 1);
}

/** The px a chapter card's graphic (and the edit summary shown beside a non-diff graphic) takes; null = full. */
function usedPx(graphic: GraphicSpec | null, hasEdits: boolean): number | null {
  const summary = hasEdits ? EDIT_SUMMARY_PX : 0;
  if (graphic === null) return summary;
  const withSummary = (px: number): number => px + (hasEdits ? GAP_PX + EDIT_SUMMARY_PX : 0);
  switch (graphic.kind) {
    case "diff":
      return fileRowsPx(graphic.files === undefined ? 1 : Math.max(1, Math.min(CARD_FILE_ROWS, graphic.files.length)));
    case "fork":
      return withSummary(18 * Math.min(3, Math.max(1, graphic.options.length)));
    case "flow":
      return withSummary(24);
    default:
      // Tests (dots, counts and the run), tables and claims fill the card.
      return null;
  }
}

/** Files a chapter card's diff graphic leaves out of its CARD_FILE_ROWS rows. */
export function hiddenFileCount(graphic: GraphicSpec | null): number {
  if (graphic?.kind !== "diff" || graphic.files === undefined) return 0;
  return Math.max(0, graphic.files.length - CARD_FILE_ROWS) + (graphic.moreFiles ?? 0);
}

/** How many compact step rows fit under a chapter card's graphic at Chapter level (0 to 3). */
export function fillRowCount(graphic: GraphicSpec | null, steps: readonly Step[]): number {
  const used = usedPx(graphic, steps.some((step) => step.edit !== undefined));
  if (used === null) return 0;
  const room = used === 0 ? BODY_PX : BODY_PX - used - GAP_PX;
  return Math.max(0, Math.min(FILL_MAX, steps.length, Math.floor(room / FILL_ROW_PX)));
}

/** Everything a frame renders, derived once per (frame, ctx, level) (Frame memoizes it). */
export interface FrameModel {
  /** ownSteps: the Step list, the footer count, the edit summary and the fill candidates. */
  steps: Step[];
  tone: "bad" | "neutral";
  flag: FrameFlag;
  graphic: GraphicSpec | null;
  icon: IconName;
  title: string;
  fullTitle: string;
  label: string;
  start: number;
  end: number;
  /** Chapter level only: the compact rows under a sparse chapter card's graphic. */
  fill: Step[];
}

export function frameModel(frame: CanvasFrame, ctx: FrameContext, level: Level): FrameModel {
  const steps = ownSteps(frame, ctx);
  const tone = toneOf(ctx, steps);
  const flag = flagOf(frame, ctx, tone);
  const graphic = frameGraphic(frame, ctx);
  const { short, full } = titles(frame, ctx);
  const start = frameStart(frame, ctx);
  const sparse = level === "chapter" && frame.kind === "chapter" && frame.item === "chapter";
  return {
    steps,
    tone,
    flag,
    graphic,
    icon: frameIcon(frame, ctx),
    title: short,
    fullTitle: full,
    label: labelOf(frame, ctx, full, flag, graphic, start),
    start,
    end: endOf(frame, ctx, start, steps),
    fill: sparse ? fillOf(graphic, steps, ctx) : [],
  };
}

/** Fill candidates are the frame's own work: pipeline and other noise steps stay out, as in the Outline. */
function fillOf(graphic: GraphicSpec | null, own: readonly Step[], ctx: FrameContext): Step[] {
  // The room depends on what the card shows (its edit summary reads every own step); the rows come from the work.
  const candidates = own.filter((step) => step.noise === null);
  return fillSteps(candidates, fillRowCount(graphic, own), ctx.findingsById);
}

export function claimSpanFor(step: Step, ctx: FrameContext): readonly [number, number] | undefined {
  for (const id of step.findingIds) {
    const finding = ctx.findingsById.get(id);
    if (finding?.ruleId === "claim_contradicted" && finding.anchorStepId === step.id && finding.claimSpan !== undefined) {
      return finding.claimSpan;
    }
  }
  return undefined;
}

const PLAN_LABEL = /^\s*plan\s*[:—–-]\s*/iu;
const LIST_LINE = /^\s*(?:\d{1,2}[.)]|[-*•])\s+(.+?)\s*$/u;
const LIST_JOINER = /^(?:and|then|and then)\s+/iu;

/**
 * The plan's items for the Plan frame's checklist: marked lines ("1. …", "- …"), or the comma and semicolon
 * clauses of a one-line plan that starts with "Plan:". Prose that lists nothing gives [] and renders as text.
 * Returns raw agent text; the frame renders each item through displayUntrusted.
 */
export function planItems(text: string): string[] {
  const lines = text.split("\n");
  const marked = lines.map((line) => LIST_LINE.exec(line)?.[1]).filter((item): item is string => item !== undefined);
  if (marked.length >= 2) return marked;
  if (!PLAN_LABEL.test(text) || lines.filter((line) => line.trim() !== "").length > 1) return [];
  const clauses = text
    .replace(PLAN_LABEL, "")
    .replace(/[.\s]+$/u, "")
    .split(/[,;]\s+/u)
    .map((clause) => clause.replace(LIST_JOINER, "").trim())
    .filter((clause) => clause.length > 0);
  return clauses.length >= 2 ? clauses : [];
}

export type ZoomBand = "full" | "nographic" | "icon";

export function zoomBand(k: number): ZoomBand {
  return k < ICON_ONLY_K ? "icon" : k < GRAPHIC_MIN_K ? "nographic" : "full";
}

/** The selection's time chip: the shared range format (Hybrid's spine chip uses it too). */
export function timeChip(start: number, end: number): string {
  return formatOffsetRange(start, end);
}

export type StepListRow = { t: "step"; step: Step } | { t: "band"; key: string; count: number };

/** Rendered-row bound for one Step-level list (spike risk 2, CULL_FRAMES): head, tail and the first problems fit. */
export const STEP_LIST_CAP = 3 * STEP_LIST_ROWS;

const HEAD = 3;
const TAIL = 5;

/**
 * Spec §7.5 Step level: every step when at most maxRows; else head 3, tail 5 and the problem steps, with every other
 * run collapsed into a band. At most `cap` rows: problem steps past the cap join the bands, head and tail always stay.
 */
export function frameStepRows(steps: readonly Step[], maxRows = STEP_LIST_ROWS, cap = Infinity): StepListRow[] {
  if (steps.length <= maxRows) return steps.map((step) => ({ t: "step", step }));
  const keep = new Set<number>();
  for (let i = 0; i < HEAD; i += 1) keep.add(i);
  for (let i = steps.length - TAIL; i < steps.length; i += 1) keep.add(i);
  // Each kept problem step can open one band, so it costs up to two rows; the edges (head, tail, one band) cost 9.
  let budget = cap - (HEAD + TAIL + 1);
  steps.forEach((step, i) => {
    if (keep.has(i) || (step.problems.length === 0 && step.findingIds.length === 0)) return;
    const cost = keep.has(i - 1) ? 1 : 2;
    if (budget < cost) return;
    keep.add(i);
    budget -= cost;
  });
  const rows: StepListRow[] = [];
  let run: Step[] = [];
  const flush = (): void => {
    const first = run[0];
    if (first !== undefined) rows.push({ t: "band", key: `band:${first.firstSeq}`, count: run.length });
    run = [];
  };
  steps.forEach((step, i) => {
    if (keep.has(i)) {
      flush();
      rows.push({ t: "step", step });
    } else {
      run.push(step);
    }
  });
  flush();
  return rows;
}
