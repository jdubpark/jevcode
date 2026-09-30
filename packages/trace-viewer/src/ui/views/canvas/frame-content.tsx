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
import { compactCount } from "../../graphics/scales.js";
import { TestDots } from "../../graphics/TestDots.js";
import { Icon } from "../../icons/Icon.js";
import { KIND_ICON } from "../../icons/kind-icons.js";
import styles from "./Frame.module.css";
import {
  CARD_FILE_ROWS,
  claimSpanFor,
  frameStepRows,
  frameSteps,
  graphicPhrase,
  hiddenFileCount,
  planItems,
  STEP_LIST_CAP,
  type FrameContext,
  type FrameModel,
} from "./frame-label.js";
import { CULL_FRAMES } from "./spike-rulings.js";

interface BodyProps {
  frame: CanvasFrame;
  ctx: FrameContext;
  /** frameModel(frame, ctx, level), derived once per frame by Frame. */
  model: FrameModel;
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

/** A final message keeps its line breaks (.claim is pre-line); every other control character becomes a token. */
const PROSE = { multiline: true } as const;

/** Agent text renders only as React text nodes; the underline covers text.slice(...span) and is dropped when out of range. */
function ClaimText({ text, span }: { text: string; span: readonly [number, number] | undefined }): React.JSX.Element {
  if (span === undefined || span[0] < 0 || span[1] > text.length || span[0] >= span[1]) {
    return <p className={styles.claim}>{displayUntrusted(text, PROSE)}</p>;
  }
  // displayUntrusted replaces code units one by one, so sanitizing each slice equals slicing the sanitized text.
  return (
    <p className={styles.claim}>
      {displayUntrusted(text.slice(0, span[0]), PROSE)}
      <mark className={styles.span}>{displayUntrusted(text.slice(span[0], span[1]), PROSE)}</mark>
      {displayUntrusted(text.slice(span[1]), PROSE)}
    </p>
  );
}

function PlanBody({ step }: { step: Step | undefined }): React.JSX.Element {
  const text = step?.text ?? "";
  const items = planItems(text);
  if (items.length === 0) return <p className={styles.plan}>{displayUntrusted(text, PROSE)}</p>;
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

/** The chapter's last owned test or check run (the one its TestDots summarize), else the last shared one. */
function testRunOf({ frame, ctx, model }: BodyProps): Step | undefined {
  const own = model.steps.filter((step) => step.tests !== undefined).at(-1);
  return own ?? frameSteps(frame, ctx).filter((step) => step.tests !== undefined).at(-1);
}

/** Spec §7.12 DurationBar: a failed test or check ends in a red dot. */
function runEnd(run: Step): "bad_dot" | "none" {
  return (run.kind === "test" || run.kind === "check") && run.status === "failed" ? "bad_dot" : "none";
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
          {/* The run's bar is part of the graphic: hidden below GRAPHIC_MIN_K with the dots (spec §7.5). */}
          <span className={styles.bar} data-part="graphic">
            <DurationBar
              size="sm"
              durationMs={run.durationMs}
              running={run.endTMs === null}
              elapsedMs={elapsedOf(run, nowMs)}
              end={runEnd(run)}
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

type DiffFile = { path: string; added: number; removed: number };

/** The last path segment, or the last two when another listed file shares it. */
function fileName(path: string, files: readonly DiffFile[]): string {
  const parts = path.split("/");
  const base = parts.at(-1) ?? path;
  const clash = files.some((file) => file.path !== path && file.path.split("/").at(-1) === base);
  return clash ? parts.slice(-2).join("/") : base;
}

/** Canvas mockup file list: one row per file with its own counts, capped to the rows the card fits (CARD_FILE_ROWS). */
function FileList({ files }: { files: readonly DiffFile[] }): React.JSX.Element {
  const shown = files.slice(0, CARD_FILE_ROWS);
  return (
    <ul className={styles.files} aria-label="Files">
      {shown.map((file) => (
        <li key={file.path} className={styles.fileRow} data-file={file.path}>
          <span className={styles.filePath} title={displayUntrusted(file.path)}>
            {displayUntrusted(fileName(file.path, shown))}
          </span>
          <DiffBar size="xs" added={file.added} removed={file.removed} />
          <span className={styles.fileCount}>
            {file.removed > 0 ? `+${compactCount(file.added)} −${compactCount(file.removed)}` : `+${compactCount(file.added)}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The frame's mini graphic at card scale; hidden below GRAPHIC_MIN_K by the zoom band. */
function GraphicPart(props: BodyProps): React.JSX.Element | null {
  const graphic = props.model.graphic;
  if (graphic === null) return null;
  // Tests keep their counts and duration as text below GRAPHIC_MIN_K; the dots and the run's bar are the graphic part.
  if (graphic.kind === "tests") return <TestsGraphic spec={graphic} run={testRunOf(props)} nowMs={props.nowMs} />;
  const body =
    graphic.kind === "fork" ? (
      <OptionFork spec={graphic} />
    ) : graphic.kind === "diff" && graphic.files !== undefined && graphic.files.length > 0 ? (
      <FileList files={graphic.files} />
    ) : (
      <Graphic spec={graphic} size="sm" />
    );
  return (
    <div className={styles.graphic} data-part="graphic" data-graphic={graphic.kind}>
      {body}
    </div>
  );
}

function SessionChip({ model }: BodyProps): React.JSX.Element {
  const flag = model.flag;
  return (
    <>
      <Icon name={model.icon} size={14} className={styles.icon} />
      <span className={styles.chipTitle} title={model.fullTitle}>
        {model.title}
      </span>
      {flag === "failed" ? <span className={styles.flagWord}>✕</span> : null}
      {flag === "neq" ? (
        <span className={styles.flagBad} data-flag="neq">
          <Icon name="neq" size={12} />
        </span>
      ) : null}
      {/* Neutral like the Outline's: a bad clamp already reads "failed" (frameFlag). */}
      {flag === "shield" ? (
        <span className={styles.flagIcon} data-flag="shield">
          <Icon name="shield" size={12} />
        </span>
      ) : null}
    </>
  );
}

function decidedByWord(decidedBy: "supervisor" | "delegated" | undefined): string {
  return decidedBy === "delegated" ? "Delegated" : decidedBy === "supervisor" ? "Supervisor" : "Open";
}

function DecisionBody(props: BodyProps): React.JSX.Element {
  const step = props.ctx.stepById.get(props.frame.selId);
  const decidedBy = step?.decision?.decidedBy;
  const answered = step !== undefined && decidedBy !== undefined;
  return (
    <>
      <GraphicPart {...props} />
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

function LooseBody({ frame, ctx, model }: BodyProps): React.JSX.Element {
  const step = ctx.stepById.get(frame.selId);
  if (step === undefined) return <></>;
  // The label above the card already reads the headline; the card shows the outcome.
  const graphic = model.graphic;
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
function StepHeader({ model }: BodyProps): React.JSX.Element {
  const graphic = model.graphic;
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

/** Sparse frames (C3-6 ruling): compact rows (kind icon, headline, offset) under a graphic that leaves the card empty. */
function FillRows({ steps }: { steps: readonly Step[] }): React.JSX.Element | null {
  if (steps.length === 0) return null;
  return (
    <ol className={styles.fill} data-part="fill" aria-label="Recent steps">
      {steps.map((step) => (
        <li key={step.id} className={styles.fillRow}>
          <Icon name={KIND_ICON[step.kind]} size={12} className={styles.icon} />
          <StepText step={step} />
          <span className={styles.offset}>{formatOffset(step.tMs)}</span>
        </li>
      ))}
    </ol>
  );
}

function ChapterBody(props: FrameContentProps): React.JSX.Element {
  const { frame, ctx, model, level, expanded } = props;
  const steps = model.steps;
  if (level === "step") {
    return (
      <>
        <StepHeader {...props} />
        <StepList steps={steps} />
      </>
    );
  }
  if (expanded) return <StepList steps={steps} />;
  const graphic = model.graphic;
  const summary = graphic !== null && graphic.kind !== "diff" && graphic.kind !== "tests";
  const chapter = ctx.chapterById.get(frame.selId);
  // The span of the chapter and its steps: unit timestamps alone are often a single instant.
  const spanMs = model.end - model.start;
  const hidden = hiddenFileCount(graphic);
  return (
    <>
      <GraphicPart {...props} />
      {summary || graphic === null ? <EditSummary steps={steps} /> : null}
      <FillRows steps={model.fill} />
      {graphic?.kind === "tests" || chapter === undefined ? null : (
        <div className={`${styles.meta} ${styles.foot}`}>
          {spanMs > 0 ? (
            <>
              <Icon name="clock" size={14} className={styles.icon} />
              <span>{formatDuration(spanMs)}</span>
            </>
          ) : null}
          <span className={styles.spacer} />
          {hidden > 0 ? <span data-more-files="">{`+${hidden} more`}</span> : null}
          <span>{`${steps.length} ${steps.length === 1 ? "step" : "steps"}`}</span>
        </div>
      )}
    </>
  );
}

export function FrameContent(props: FrameContentProps): React.JSX.Element {
  const { frame, ctx, level, model } = props;
  if (level === "session") return <SessionChip {...props} />;
  const step = ctx.stepById.get(frame.selId);
  switch (frame.item) {
    case "intent":
    case "instruction":
      return <p className={styles.prompt}>{displayUntrusted(step?.text ?? step?.headline ?? "", PROSE)}</p>;
    case "plan":
      return <PlanBody step={step} />;
    case "claim":
      return <ClaimText text={step?.text ?? ""} span={step === undefined ? undefined : claimSpanFor(step, ctx)} />;
    case "decision":
      return <DecisionBody {...props} />;
    case "noise":
      return <EditSummary steps={model.steps} />;
    case "loose":
      return <LooseBody {...props} />;
    case "chapter":
      return frame.kind === "noise" ? <EditSummary steps={model.steps} /> : <ChapterBody {...props} />;
  }
}
