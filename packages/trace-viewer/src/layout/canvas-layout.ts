import type { Finding, FindingId, Step, TraceSession, Turn } from "../model/index.js";
import { stepFinder, type CanvasItemKind } from "./canvas-levels.js";
import { worstSeverity } from "./tone.js";
import type { SelectionId, TraceIndex } from "./trace-index.js";

/** codex-adapter.ts:289 resumes a turn with this prompt; such a turn adds no story frame. */
export const RESUME_DEFAULT_PROMPT = "Continue the task.";

export interface CanvasItem {
  key: string;
  selId: SelectionId;
  kind: CanvasItemKind;
  band: "story" | "work";
  /** Display clock (Step.tMs or Chapter.tMs). */
  start: number;
  end: number;
  anchorSeq: number;
  turn: number;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Index of the last turn whose tMs ≤ t (turns are in seq order, so tMs is non-decreasing). */
function turnLocator(turns: readonly Turn[]): (t: number) => number {
  return (t) => {
    let lo = 0;
    let hi = turns.length - 1;
    let found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const turn = turns[mid];
      if (turn !== undefined && turn.tMs <= t) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return turns[found]?.index ?? 0;
  };
}

/** Equal keys keep the first (by selection id) and suffix the rest with .1, .2, … */
function disambiguate(items: CanvasItem[]): CanvasItem[] {
  const groups = new Map<string, CanvasItem[]>();
  for (const item of items) {
    const group = groups.get(item.key);
    if (group === undefined) groups.set(item.key, [item]);
    else group.push(item);
  }
  const out: CanvasItem[] = [];
  for (const [key, group] of groups) {
    group.sort((a, b) => compareText(a.selId, b.selId) || compareText(a.kind, b.kind));
    group.forEach((item, index) => out.push(index === 0 ? item : { ...item, key: `${key}.${index}` }));
  }
  return out;
}

function compareItems(a: CanvasItem, b: CanvasItem): number {
  return a.start - b.start || a.anchorSeq - b.anchorSeq || compareText(a.key, b.key);
}

/** Spec §7.5 "Items": story items per turn, decisions, current chapters and loose finding steps. */
export function collectItems(session: TraceSession, index: TraceIndex): CanvasItem[] {
  const stepOf = stepFinder(session.steps);
  const findingsById = new Map<FindingId, Finding>(session.findings.map((finding) => [finding.id, finding]));
  const currentChapters = new Set<string>(
    session.chapters.filter((chapter) => chapter.current).map((chapter) => chapter.id),
  );
  const turnAt = turnLocator(session.turns);
  const stepContaining = (seq: number): Step | undefined => {
    const at = index.stepIndexAtOrBefore(seq);
    const step = session.steps[at];
    if (step !== undefined && step.seqs.includes(seq)) return step;
    return session.steps.find((candidate) => candidate.seqs.includes(seq));
  };
  const firstStepOf = (turn: Turn): Step | undefined => {
    for (const id of turn.stepIds) {
      const step = stepOf(id);
      if (step !== undefined) return step;
    }
    return undefined;
  };
  const items: CanvasItem[] = [];
  const storySteps = new Set<string>();

  const story = (kind: CanvasItemKind, key: string, step: Step, start: number, anchorSeq: number): void => {
    storySteps.add(step.id);
    items.push({
      key,
      selId: step.id,
      kind,
      band: "story",
      start,
      end: Math.max(start, step.endTMs ?? step.tMs),
      anchorSeq,
      turn: turnAt(start),
    });
  };

  for (const turn of session.turns) {
    const resumeDefault = turn.trigger === "resume" && turn.prompt.trim() === RESUME_DEFAULT_PROMPT;
    // Spec §7.5: the opener is the step whose seqs include turn.startSeq. A queued instruction or a
    // decision relaunch opens a turn without being in turn.stepIds. A decision opener adds no instruction
    // item (the decision item covers it). Fallback when no step holds startSeq: the turn's first step.
    const opener = stepContaining(turn.startSeq) ?? firstStepOf(turn);
    if (!resumeDefault && opener !== undefined && opener.kind !== "decision") {
      story(turn.index === 0 ? "intent" : "instruction", `turn:${turn.startSeq}`, opener, opener.tMs, turn.startSeq);
    }
    const plan = turn.planStepId === undefined ? undefined : stepOf(turn.planStepId);
    if (plan !== undefined) story("plan", `plan:${plan.firstSeq}`, plan, plan.tMs, plan.firstSeq);
    const claim = turn.claimStepId === undefined ? undefined : stepOf(turn.claimStepId);
    if (claim !== undefined) story("claim", `claim:${claim.firstSeq}`, claim, claim.tMs, claim.firstSeq);
  }

  for (const step of session.steps) {
    if (step.kind !== "decision") continue;
    story("decision", `decision:${step.target ?? String(step.firstSeq)}`, step, step.tMs, step.firstSeq);
  }

  for (const chapter of session.chapters) {
    if (!chapter.current) continue;
    const key = index.chapterKey(chapter.id);
    if (key === undefined) continue;
    const own = chapter.stepIds.flatMap((id) => stepOf(id)?.firstSeq ?? []);
    const seqs = [...chapter.factSeqs, ...own];
    // Same rule as trace-index: min over factSeqs and step firstSeqs (spec §7.5).
    const anchorSeq = seqs.length > 0 ? Math.min(...seqs) : chapter.firstSeq;
    const flagged =
      chapter.findingIds.length > 0 ||
      chapter.stepIds.some((id) => (stepOf(id)?.findingIds.length ?? 0) > 0);
    items.push({
      key,
      selId: chapter.id,
      kind: chapter.noise && !flagged ? "noise" : "chapter",
      band: "work",
      start: chapter.tMs,
      end: Math.max(chapter.tMs, chapter.endTMs),
      anchorSeq,
      turn: turnAt(chapter.tMs),
    });
  }

  for (const step of session.steps) {
    if (step.findingIds.length === 0 || storySteps.has(step.id)) continue;
    if (step.chapterIds.some((id) => currentChapters.has(id))) continue;
    const severity = worstSeverity(step, findingsById);
    if (severity !== "warning" && severity !== "critical") continue;
    items.push({
      key: `step:${step.firstSeq}`,
      selId: step.id,
      kind: "loose",
      band: "work",
      start: step.tMs,
      end: Math.max(step.tMs, step.endTMs ?? step.tMs),
      anchorSeq: step.firstSeq,
      turn: turnAt(step.tMs),
    });
  }

  return disambiguate(items).sort(compareItems);
}
