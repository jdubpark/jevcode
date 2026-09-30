import { useEffect, useRef } from "react";
import type React from "react";

import type { CanvasFrame } from "../../../layout/canvas-layout.js";
import {
  displayUntrusted,
  formatDuration,
  formatOffset,
  type GraphicSpec,
  type Level,
  type Step,
  type StepKind,
} from "../../../model/index.js";
import { DiffBar } from "../../graphics/DiffBar.js";
import { DurationBar } from "../../graphics/DurationBar.js";
import { Graphic } from "../../graphics/Graphic.js";
import { TestDots } from "../../graphics/TestDots.js";
import { Icon } from "../../icons/Icon.js";
import { KIND_ICON } from "../../icons/kind-icons.js";
import styles from "./Frame.module.css";
import {
  claimSpanFor,
  frameEnd,
  frameFlag,
  frameFullTitle,
  frameGraphic,
  frameIcon,
  frameStart,
  frameStepRows,
  frameSteps,
  frameTitle,
  graphicPhrase,
  planItems,
  STEP_LIST_CAP,
  type FrameContext,
} from "./frame-label.js";
import { CULL_FRAMES } from "./spike-rulings.js";

interface BodyProps {
  frame: CanvasFrame;
  ctx: FrameContext;
  /** The source's now() on the live tick; running bars grow to it (C1a hand-off M-1). */
  nowMs?: number | null;
}

export interface FrameContentProps extends BodyProps {
  level: Level;
  expanded: boolean;
}

/** Kinds whose headline is a command or a path: mono (spec §7.12 keeps mono for paths, commands and code). */
const MONO_KINDS: ReadonlySet<StepKind> = new Set<StepKind>(["command", "test", "check", "edit", "read", "dependency"]);

function elapsedOf(step: Step, nowMs: number | null | undefined): number | undefined {
  return step.endTMs === null && nowMs !== null && nowMs !== undefined ? Math.max(0, nowMs - step.startMs) : undefined;
}

/** Agent text renders only as React text nodes; the underline covers text.slice(...span) and is dropped when out of range. */
function ClaimText({ text, span }: { text: string; span: readonly [number, number] | undefined }): React.JSX.Element {
  if (span === undefined || span[0] < 0 || span[1] > text.length || span[0] >= span[1]) {
    return <p className={styles.claim}>{displayUntrusted(text)}</p>;
  }
  // displayUntrusted replaces code units one by one, so sanitizing each slice equals slicing the sanitized text.
  return (
    <p className={styles.claim}>
      {displayUntrusted(text.slice(0, span[0]))}
      <mark className={styles.span}>{displayUntrusted(text.slice(span[0], span[1]))}</mark>
      {displayUntrusted(text.slice(span[1]))}
    </p>
  );
}

function PlanBody({ step }: { step: Step | undefined }): React.JSX.Element {
  const text = step?.text ?? "";
  const items = planItems(text);
  if (items.length === 0) return <p className={styles.plan}>{displayUntrusted(text, { multiline: true })}</p>;
  const shown = items.length > 4 ? items.slice(0, 3) : items;
  return (
    <ol className={styles.checklist} aria-label="Plan">
      {shown.map((item, i) => (
        <li key={i} className={styles.checkItem}>
          {displayUntrusted(item)}
        </li>
      ))}
      {items.length > shown.length ? <li className={styles.checkMore}>{`${items.length - shown.length} more`}</li> : null}
    </ol>
  );
}

const FORK_ROW = 18;
const FORK_MAX = 3;

/** ForkGlyph at card scale (canvas mockup): one row per option, the chosen branch solid, the others dashed. */
function OptionFork({ spec }: { spec: Extract<GraphicSpec, { kind: "fork" }> }): React.JSX.Element {
  const shown = spec.options.slice(0, FORK_MAX);
  const chosenAt = spec.options.findIndex((option) => option.chosen);
  if (chosenAt >= FORK_MAX) {
    const chosen = spec.options[chosenAt];
    if (chosen !== undefined) shown[FORK_MAX - 1] = chosen;
  }
  const extra = spec.options.length - shown.length;
  const h = Math.max(1, shown.length) * FORK_ROW;
  const mid = h / 2;
  return (
    <div className={styles.fork}>
      <svg className={styles.forkLines} width={28} height={h} viewBox={`0 0 28 ${h}`} aria-hidden="true" focusable="false">
        <circle className={styles.forkRoot} cx={3} cy={mid} r={2.5} />
        {shown.map((option, i) => {
          const y = FORK_ROW * i + FORK_ROW / 2;
          const solid = spec.decidedBy !== "open" && option.chosen;
          return (
            <g key={i}>
              <path
                className={solid ? styles.forkChosen : styles.forkOther}
                d={`M5.5 ${mid}H8C15 ${mid} 14 ${y} 21 ${y}`}
              />
              <circle className={solid ? styles.forkEndChosen : styles.forkEnd} cx={24} cy={y} r={solid ? 3 : 2.5} />
            </g>
          );
        })}
      </svg>
      <ul className={styles.forkLabels}>
        {shown.map((option, i) => {
          const solid = spec.decidedBy !== "open" && option.chosen;
          return (
            <li key={i} className={solid ? styles.optionChosen : styles.option} data-chosen={solid ? "true" : "false"}>
              {displayUntrusted(option.label)}
            </li>
          );
        })}
      </ul>
      {extra > 0 ? <span className={styles.forkMore}>{`+${extra}`}</span> : null}
    </div>
  );
}

function StepGraphic({ step }: { step: Step }): React.JSX.Element | null {
  let graphic: React.JSX.Element | null = null;
  if (step.tests !== undefined) {
    graphic = <TestDots size="xs" passed={step.tests.passed} failed={step.tests.failed} skipped={step.tests.skipped} />;
  } else if (step.edit !== undefined) {
    graphic = <DiffBar size="xs" added={step.edit.added} removed={step.edit.removed} />;
  }
  return graphic === null ? null : <span className={styles.rowGraphic}>{graphic}</span>;
}

function FailedWord(): React.JSX.Element {
  return <span className={styles.failed}>✕ failed</span>;
}

function StepText({ step }: { step: Step }): React.JSX.Element {
  const mono = MONO_KINDS.has(step.kind) && step.target !== undefined;
  return <span className={mono ? `${styles.stepText} ${styles.mono}` : styles.stepText}>{displayUntrusted(step.headline)}</span>;
}

function StepList({ steps }: { steps: readonly Step[] }): React.JSX.Element {
  const listRef = useRef<HTMLOListElement | null>(null);
  useEffect(() => {
    const list = listRef.current;
    if (list === null) return undefined;
    // A vertical wheel over a list that can scroll scrolls it; Ctrl/Meta+wheel (zoom), a sideways swipe and a list
    // with nothing to scroll still reach the viewport controller.
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || event.metaKey) return;
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      if (list.scrollHeight <= list.clientHeight) return;
      event.stopPropagation();
    };
    list.addEventListener("wheel", onWheel, { passive: true });
    return () => list.removeEventListener("wheel", onWheel);
  }, []);
  const rows = frameStepRows(steps, undefined, CULL_FRAMES ? STEP_LIST_CAP : Infinity);
  return (
    <ol ref={listRef} className={styles.steps} aria-label="Steps">
      {rows.map((row) =>
        row.t === "band" ? (
          <li key={row.key} className={`${styles.stepRow} ${styles.band}`}>
            {`${row.count} more ${row.count === 1 ? "step" : "steps"}`}
          </li>
        ) : (
          <li key={row.step.id} className={styles.stepRow}>
            <Icon name={KIND_ICON[row.step.kind]} size={14} className={styles.icon} />
            <StepText step={row.step} />
            <StepGraphic step={row.step} />
            {row.step.status === "failed" ? <FailedWord /> : null}
            <span className={styles.offset}>{formatOffset(row.step.tMs)}</span>
          </li>
        ),
      )}
    </ol>
  );
}

/** The chapter's last owned test or check run: the one its TestDots summarize. */
function testRunOf(frame: CanvasFrame, ctx: FrameContext): Step | undefined {
  const chapter = ctx.chapterById.get(frame.selId);
  const shared = new Set(chapter?.validationOnlyStepIds ?? []);
  const runs = frameSteps(frame, ctx).filter((step) => step.tests !== undefined);
  return runs.filter((step) => !shared.has(step.id)).at(-1) ?? runs.at(-1);
}

function TestsGraphic({ spec, run, nowMs }: { spec: Extract<GraphicSpec, { kind: "tests" }>; run: Step | undefined; nowMs?: number | null }): React.JSX.Element {
  return (
    <>
      <div className={styles.graphic} data-part="graphic" data-graphic="tests">
        <TestDots size="sm" passed={spec.passed} failed={spec.failed} skipped={spec.skipped} />
      </div>
      <div className={styles.result}>
        {spec.failed > 0 ? (
          <>
            <span className={styles.big}>{spec.failed}</span>{" "}
            <span className={styles.bigWord}>failed</span>
          </>
        ) : (
          <span className={styles.passWord}>All passed</span>
        )}
        <span className={styles.spacer} />
        <Icon name="check" size={12} className={styles.passMark} />
        <span className={styles.passCount}>{spec.passed}</span>
        {spec.skipped > 0 ? <span className={styles.meta}>{`${spec.skipped} skipped`}</span> : null}
      </div>
      {run === undefined ? null : (
        <div className={styles.meta}>
          <Icon name="term" size={14} className={styles.icon} />
          <span className={styles.bar}>
            <DurationBar
              size="sm"
              durationMs={run.durationMs}
              running={run.endTMs === null}
              elapsedMs={elapsedOf(run, nowMs)}
              end="none"
            />
          </span>
          <span className={styles.spacer} />
          <span>{run.endTMs === null ? "running" : formatDuration(run.durationMs)}</span>
        </div>
      )}
    </>
  );
}

/** Files the frame's steps edited: count and one neutral DiffBar (noise stacks, and chapters whose graphic is not a diff). */
function EditSummary({ steps }: { steps: readonly Step[] }): React.JSX.Element | null {
  const edits = steps.filter((step) => step.edit !== undefined);
  if (edits.length === 0) return null;
  const added = edits.reduce((sum, step) => sum + (step.edit?.added ?? 0), 0);
  const removed = edits.reduce((sum, step) => sum + (step.edit?.removed ?? 0), 0);
  const files = new Set(edits.map((step) => step.edit?.path)).size;
  return (
    <div className={styles.meta}>
      <span>{`${files} ${files === 1 ? "file" : "files"}`}</span>
      <DiffBar size="xs" added={added} removed={removed} />
      <span>{`+${added} −${removed}`}</span>
    </div>
  );
}

/** The frame's mini graphic at card scale; hidden below GRAPHIC_MIN_K by the zoom band. */
function GraphicPart({ frame, ctx, nowMs }: BodyProps): React.JSX.Element | null {
  const graphic = frameGraphic(frame, ctx);
  if (graphic === null) return null;
  // Tests keep their counts and duration as text below GRAPHIC_MIN_K; only the dots are the graphic part.
  if (graphic.kind === "tests") return <TestsGraphic spec={graphic} run={testRunOf(frame, ctx)} nowMs={nowMs} />;
  const body = graphic.kind === "fork" ? <OptionFork spec={graphic} /> : <Graphic spec={graphic} size="sm" />;
  return (
    <div className={styles.graphic} data-part="graphic" data-graphic={graphic.kind}>
      {body}
    </div>
  );
}

function SessionChip({ frame, ctx }: BodyProps): React.JSX.Element {
  const flag = frameFlag(frame, ctx);
  return (
    <>
      <Icon name={frameIcon(frame, ctx)} size={14} className={styles.icon} />
      <span className={styles.chipTitle} title={frameFullTitle(frame, ctx)}>
        {frameTitle(frame, ctx)}
      </span>
      {flag === "failed" ? <span className={styles.flagWord}>✕</span> : null}
      {flag === "neq" ? <Icon name="neq" size={12} className={styles.flagBad} /> : null}
      {flag === "shield" ? <Icon name="shield" size={12} className={styles.flagBad} /> : null}
    </>
  );
}

function decidedByWord(decidedBy: "supervisor" | "delegated" | undefined): string {
  return decidedBy === "delegated" ? "Delegated" : decidedBy === "supervisor" ? "Supervisor" : "Open";
}

function DecisionBody({ frame, ctx }: BodyProps): React.JSX.Element {
  const step = ctx.stepById.get(frame.selId);
  const decidedBy = step?.decision?.decidedBy;
  const answered = step !== undefined && decidedBy !== undefined;
  return (
    <>
      <GraphicPart frame={frame} ctx={ctx} />
      <div className={styles.meta}>
        <Icon name="person" size={14} className={styles.icon} />
        <span>{decidedByWord(decidedBy)}</span>
        {answered ? <span>{formatOffset(step.endTMs ?? step.tMs)}</span> : null}
        <span className={styles.spacer} />
        <Icon name="clock" size={14} className={styles.icon} />
        <span>{formatDuration(step?.durationMs ?? null)}</span>
      </div>
    </>
  );
}

function LooseBody({ frame, ctx }: BodyProps): React.JSX.Element {
  const step = ctx.stepById.get(frame.selId);
  if (step === undefined) return <></>;
  // The label above the card already reads the headline; the card shows the outcome.
  const graphic = frameGraphic(frame, ctx);
  if (graphic?.kind === "tests") {
    return (
      <div className={styles.row}>
        <StepGraphic step={step} />
        <span className={styles.spacer} />
        {graphic.failed > 0 ? <span className={styles.failed}>{`${graphic.failed} failed`}</span> : null}
        <Icon name="check" size={12} className={styles.passMark} />
        <span className={styles.passCount}>{graphic.passed}</span>
      </div>
    );
  }
  return (
    <div className={styles.row}>
      <StepGraphic step={step} />
      {graphic === null ? <StepText step={step} /> : <span className={styles.stepText}>{displayUntrusted(graphicPhrase(graphic))}</span>}
      {step.status === "failed" ? <FailedWord /> : null}
    </div>
  );
}

/** Step level header: one line with the xs graphic and its phrase above the step list. */
function StepHeader({ frame, ctx }: BodyProps): React.JSX.Element {
  const graphic = frameGraphic(frame, ctx);
  return (
    <div className={styles.header}>
      {graphic === null ? null : (
        <span className={styles.graphic} data-part="graphic">
          <Graphic spec={graphic} size="xs" />
        </span>
      )}
      <span className={styles.headerText}>{graphic === null ? "" : displayUntrusted(graphicPhrase(graphic))}</span>
    </div>
  );
}

function ChapterBody({ frame, ctx, level, expanded, nowMs }: FrameContentProps): React.JSX.Element {
  const steps = frameSteps(frame, ctx);
  if (level === "step") {
    return (
      <>
        <StepHeader frame={frame} ctx={ctx} />
        <StepList steps={steps} />
      </>
    );
  }
  if (expanded) return <StepList steps={steps} />;
  const graphic = frameGraphic(frame, ctx);
  const summary = graphic !== null && graphic.kind !== "diff" && graphic.kind !== "tests";
  const chapter = ctx.chapterById.get(frame.selId);
  // The span of the chapter and its steps: unit timestamps alone are often a single instant.
  const spanMs = frameEnd(frame, ctx) - frameStart(frame, ctx);
  return (
    <>
      <GraphicPart frame={frame} ctx={ctx} nowMs={nowMs} />
      {summary || graphic === null ? <EditSummary steps={steps} /> : null}
      {graphic?.kind === "tests" || chapter === undefined ? null : (
        <div className={`${styles.meta} ${styles.foot}`}>
          {spanMs > 0 ? (
            <>
              <Icon name="clock" size={14} className={styles.icon} />
              <span>{formatDuration(spanMs)}</span>
            </>
          ) : null}
          <span className={styles.spacer} />
          <span>{`${steps.length} ${steps.length === 1 ? "step" : "steps"}`}</span>
        </div>
      )}
    </>
  );
}

export function FrameContent(props: FrameContentProps): React.JSX.Element {
  const { frame, ctx, level } = props;
  if (level === "session") return <SessionChip frame={frame} ctx={ctx} />;
  const step = ctx.stepById.get(frame.selId);
  switch (frame.item) {
    case "intent":
    case "instruction":
      return <p className={styles.prompt}>{displayUntrusted(step?.text ?? step?.headline ?? "", { multiline: true })}</p>;
    case "plan":
      return <PlanBody step={step} />;
    case "claim":
      return <ClaimText text={step?.text ?? ""} span={step === undefined ? undefined : claimSpanFor(step, ctx)} />;
    case "decision":
      return <DecisionBody frame={frame} ctx={ctx} />;
    case "noise":
      return <EditSummary steps={frameSteps(frame, ctx)} />;
    case "loose":
      return <LooseBody frame={frame} ctx={ctx} />;
    case "chapter":
      return frame.kind === "noise" ? (
        <EditSummary steps={frameSteps(frame, ctx)} />
      ) : (
        <ChapterBody {...props} />
      );
  }
}
