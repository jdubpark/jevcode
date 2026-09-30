import type { CanvasFrame } from "../../../layout/canvas-layout.js";
import { GRAPHIC_MIN_K, ICON_ONLY_K, STEP_LIST_ROWS } from "../../../layout/canvas-levels.js";
import { stepTone } from "../../../layout/tone.js";
import {
  describeGraphic,
  displayUntrusted,
  formatOffset,
  pickGraphic,
  shortenTitle,
  type Chapter,
  type Finding,
  type FindingId,
  type GraphicSpec,
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

export function frameStart(frame: CanvasFrame, ctx: FrameContext): number {
  let start = Infinity;
  for (const selId of frame.memberSelIds) {
    const t = ctx.chapterById.get(selId)?.tMs ?? ctx.stepById.get(selId)?.tMs;
    if (t !== undefined) start = Math.min(start, t);
  }
  return Number.isFinite(start) ? start : 0;
}

export function frameEnd(frame: CanvasFrame, ctx: FrameContext): number {
  let end = frameStart(frame, ctx);
  for (const selId of frame.memberSelIds) {
    const chapter = ctx.chapterById.get(selId);
    if (chapter !== undefined) end = Math.max(end, chapter.endTMs);
  }
  for (const step of frameSteps(frame, ctx)) end = Math.max(end, step.endTMs ?? step.tMs);
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
 * Anchor rule (layout/tone.ts): a frame is bad only through a step of its own whose stepTone is bad, which reads
 * anchored findings only. A finding that merely cites a step or names a chapter does not redden the frame, and neither
 * does a test run the chapter reaches only through a shared validation (Chapter.validationOnlyStepIds).
 */
export function frameTone(frame: CanvasFrame, ctx: FrameContext): "bad" | "neutral" {
  const validationOnly = new Set<string>();
  for (const selId of frame.memberSelIds) {
    for (const id of ctx.chapterById.get(selId)?.validationOnlyStepIds ?? []) validationOnly.add(id);
  }
  for (const step of frameSteps(frame, ctx)) {
    if (!validationOnly.has(step.id) && stepTone(step, ctx.findingsById) === "bad") return "bad";
  }
  return "neutral";
}

export type FrameFlag = "neq" | "failed" | "shield" | null;

export function frameFlag(frame: CanvasFrame, ctx: FrameContext): FrameFlag {
  if (frame.item === "claim") {
    const step = ctx.stepById.get(frame.selId);
    const anchored = step?.findingIds.some((id) => {
      const finding = ctx.findingsById.get(id);
      return finding?.ruleId === "claim_contradicted" && finding.anchorStepId === step.id;
    });
    if (anchored === true) return "neq";
  }
  if (frameTone(frame, ctx) === "bad") return "failed";
  const guarded = frame.memberSelIds.some((selId) => (ctx.chapterById.get(selId)?.clampIds.length ?? 0) > 0);
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
  const parts = [frameFullTitle(frame, ctx)];
  if (frameApprox(frame, ctx)) parts.push("approximate join");
  if (frameFlag(frame, ctx) === "neq") parts.push(FINDING_TITLE.claim_contradicted);
  const graphic = frameGraphic(frame, ctx);
  if (graphic !== null) parts.push(displayUntrusted(graphicPhrase(graphic)));
  parts.push(formatOffset(frameStart(frame, ctx)));
  return parts.join(", ");
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

export function timeChip(start: number, end: number): string {
  return `${formatOffset(start)} – ${formatOffset(Math.max(start, end)).replace(/^\+/, "")}`;
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
